import {
  listOrganizations,
  upsertTemplateFromMeta,
  retireMissingTemplates,
  withTenant,
} from "@nexus/db";
import { isHiddenTemplate } from "@nexus/shared";
import { listMetaTemplates } from "../lib/whatsapp-client.js";
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
    return templates.length > 0 ? await retireMissingTemplates(organization.id, seen) : 0;
  });

  logger.info(
    { organization: organization.slug, synced: seen.length, approved, retired },
    "Template sync complete"
  );

  return { organizationSlug: organization.slug, synced: seen.length, approved, retired };
}

export async function syncAllTemplates(): Promise<SyncResult[]> {
  const organizations = await listOrganizations();
  const results: SyncResult[] = [];

  for (const organization of organizations) {
    if (!organization.whatsappBusinessAccountId) {
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

  return results;
}
