import {
  listOrganizations,
  upsertTemplateFromMeta,
  retireMissingTemplates,
} from "@nexus/db";
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
  const templates = await listMetaTemplates(organization.whatsappBusinessAccountId);

  let approved = 0;
  const seen: string[] = [];

  for (const template of templates) {
    // A template with no id cannot be identified on the next sync, so storing
    // it would create a duplicate row on every run rather than updating one.
    if (!template.id) continue;

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
  const retired = templates.length > 0 ? await retireMissingTemplates(organization.id, seen) : 0;

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
