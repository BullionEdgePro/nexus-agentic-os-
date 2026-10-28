import {
  listOrganizations,
  listStaffWhatsAppAccounts,
  connectionSecret,
  upsertTemplateFromMeta,
  retireMissingTemplates,
  withTenant,
} from "@nexus/db";
import { isHiddenTemplate } from "@nexus/shared";
import { listMetaTemplates, createMetaTemplate } from "../lib/whatsapp-client.js";
import { missingCampaignTemplates } from "../lib/campaign-templates.js";
import { logger } from "../lib/logger.js";

export interface SyncResult {
  organizationSlug: string;
  synced: number;
  approved: number;
  retired: number;
}

/**
 * Pulls every template Meta holds for a business's WhatsApp account into our
 * mirror.
 *
 * All five businesses share one WhatsApp Business Account, so this reads the
 * same list for each and stores a row per (business, template) pair. That is
 * intentional: a template belongs to the account, but permission to send it is
 * a per-business decision the owner makes in the picker, and past broadcasts
 * must stay attributable to the business that sent them.
 *
 * Sync is the only writer of approval state. Nothing in the product may set
 * `is_approved` by hand — the point of the mirror is that the answer comes from
 * the party who actually decides it.
 */
export async function syncTemplatesForOrganization(organization: {
  id: string;
  slug: string;
  whatsappBusinessAccountId: string;
}): Promise<SyncResult> {
  // Meta is called OUTSIDE the tenant context on purpose: it is a slow network
  // round trip and holding a database transaction open across it would pin a
  // connection for the duration. The context wraps only the writes below.
  const templates = await listMetaTemplates(organization.whatsappBusinessAccountId);

  let approved = 0;
  const seen: string[] = [];

  // Every write below runs inside the tenant context.
  //
  // This wrapper is a regression fix, not a tidy-up. The scheduled sync reaches
  // these writes without passing through the API middleware that supplies a
  // context, and RLS rejects an unscoped write outright — "new row violates
  // row-level security policy". Enabling policies therefore stopped template
  // approvals reaching the product, on a half-hourly job whose only visible
  // symptom would have been templates that never left PENDING.
  const retired = await withTenant(organization.id, async () => {
    for (const template of templates) {
      // A template with no id cannot be identified on the next sync, so storing
      // it would create a duplicate row on every run rather than updating one.
      if (!template.id) continue;

      // Another system's template (Klaviyo's), suppressed by name — see
      // HIDDEN_TEMPLATE_NAMES. Skipped entirely: not stored, and not added to
      // `seen`, so any row that predates this is retired by the pass below.
      if (isHiddenTemplate(template.name)) continue;

      seen.push(template.id);
      if (template.status === "APPROVED") approved++;

      await upsertTemplateFromMeta({
        organizationId: organization.id,
        whatsappBusinessAccountId: organization.whatsappBusinessAccountId,
        metaTemplateId: template.id,
        name: template.name,
        language: template.language,
        category: template.category,
        status: template.status,
        bodyParamCount: template.bodyParamCount,
      });
    }

    // Only retire when Meta actually answered. An empty list from a failed or
    // permission-denied call would otherwise mark every template deleted and
    // quietly disable bulk messaging across the platform.
    return templates.length > 0
      ? await retireMissingTemplates(organization.id, seen, organization.whatsappBusinessAccountId)
      : 0;
  });

  logger.info(
    { organization: organization.slug, synced: seen.length, approved, retired },
    "Template sync complete"
  );

  return { organizationSlug: organization.slug, synced: seen.length, approved, retired };
}

/**
 * Whether this is an account Meta could answer for. Meta's ids are all digits;
 * the App Review sandbox (review-demo) carries `none-review-demo` because the
 * column is required, and asking Meta for it logged a level-50 "Template sync
 * failed" every half hour from 2 Oct — noise in exactly the log a health check
 * reads for real failures.
 */
export function isMetaAccountId(id: string | null | undefined): id is string {
  return typeof id === "string" && /^\d+$/.test(id);
}

export async function syncAllTemplates(): Promise<SyncResult[]> {
  const organizations = await listOrganizations();
  const results: SyncResult[] = [];

  for (const organization of organizations) {
    if (!isMetaAccountId(organization.whatsappBusinessAccountId)) {
      logger.warn({ organization: organization.slug }, "No WhatsApp account id; skipping sync");
      continue;
    }
    try {
      results.push(await syncTemplatesForOrganization(organization));
    } catch (err) {
      // One business failing must not stop the rest. A thrown error here would
      // leave the businesses after it in the list unsynced with no signal.
      logger.error({ organization: organization.slug, err }, "Template sync failed");
    }
  }

  results.push(...(await syncStaffNumberTemplates()));
  return results;
}

/**
 * The templates on each staff member's OWN WhatsApp account.
 *
 * A number connected through Coexistence sits on the account of whichever
 * business portfolio owns it -- on 12 Oct 2026, +971 52 563 1476 landed on
 * 1915340836093863, not Zipicka's -- and a template can only be sent from a
 * number on the account that holds it. Read with that number's own token,
 * because the platform's system user cannot see an account another portfolio
 * owns; stored against the staff member's business, tagged with the account.
 */
export async function syncStaffNumberTemplates(): Promise<SyncResult[]> {
  const accounts = await listStaffWhatsAppAccounts();
  const results: SyncResult[] = [];
  for (const account of accounts) {
    try {
      const result = await syncStaffAccountTemplates(account);
      if (result) results.push(result);
    } catch (err) {
      logger.error({ wabaId: account.wabaId, err }, "Template sync failed for a staff number's account");
    }
  }
  return results;
}

/**
 * One staff number's account: what the half-hourly pass does for each, and what
 * a staff member's "Check again" does for theirs alone (28 Oct 2026). Null when
 * the account has no stored token. Throws when Meta does — the caller decides
 * whether that is a log line or a sentence on screen.
 */
export async function syncStaffAccountTemplates(account: {
  wabaId: string;
  organizationId: string;
  organizationSlug: string;
  employeeId: string;
}): Promise<SyncResult | null> {
  const secret = await withTenant(account.organizationId, () =>
    connectionSecret(account.organizationId, account.employeeId, "whatsapp")
  );
  if (!secret) {
    logger.warn(
      { organization: account.organizationSlug, wabaId: account.wabaId, employeeId: account.employeeId },
      "A staff number's account has no stored WhatsApp token — its templates cannot be read or created"
    );
    return null;
  }
  const templates = await listMetaTemplates(account.wabaId, secret.accessToken);

  // TEMPLATES FOLLOW THE NUMBER. A number connected on a fresh account holds
  // no templates, and without one it cannot start a single conversation —
  // Keshav Arora's SFS number on 22 Oct 2026. Whatever the business's
  // catalogue has that this account lacks is submitted here, every cycle,
  // so it needs nobody to run a script and a failed submission is simply
  // tried again in half an hour. New ones arrive PENDING on the next read.
  for (const spec of missingCampaignTemplates(account.organizationSlug, templates.map((t) => t.name))) {
    const created = await createMetaTemplate(account.wabaId, spec, secret.accessToken);
    if (created.ok || /already exists|duplicate/i.test(created.error ?? "")) {
      logger.info(
        { organization: account.organizationSlug, wabaId: account.wabaId, template: spec.name, status: created.status },
        "Submitted a campaign template to a staff number's account"
      );
    } else {
      logger.warn(
        { organization: account.organizationSlug, wabaId: account.wabaId, template: spec.name, err: created.error },
        "Could not submit a campaign template to a staff number's account — retrying next cycle"
      );
    }
  }
  let approved = 0;
  const seen: string[] = [];
  const retired = await withTenant(account.organizationId, async () => {
    for (const template of templates) {
      if (!template.id || isHiddenTemplate(template.name)) continue;
      seen.push(template.id);
      if (template.status === "APPROVED") approved++;
      await upsertTemplateFromMeta({
        organizationId: account.organizationId,
        whatsappBusinessAccountId: account.wabaId,
        metaTemplateId: template.id,
        name: template.name,
        language: template.language,
        category: template.category,
        status: template.status,
        bodyParamCount: template.bodyParamCount,
      });
    }
    return templates.length > 0 ? await retireMissingTemplates(account.organizationId, seen, account.wabaId) : 0;
  });
  return { organizationSlug: `${account.organizationSlug} (staff account ${account.wabaId})`, synced: seen.length, approved, retired };
}
