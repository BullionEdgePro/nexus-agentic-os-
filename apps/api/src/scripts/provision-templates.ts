import { findOrganizationBySlug } from "@nexus/db";
import { createMetaTemplate, type TemplateSpec } from "../lib/whatsapp-client.js";
import { syncTemplatesForOrganization } from "../services/template-sync.js";
import { CAMPAIGN_TEMPLATES } from "../lib/campaign-templates.js";

/**
 * Submits every business's catalogue messages (lib/campaign-templates.ts) to
 * the company WhatsApp account for Meta's review. Staff members' own accounts
 * no longer need this: the staff template sync submits what they are missing.
 *
 * Run:  docker exec nexus-api-1 node dist/scripts/provision-templates.js
 * Safe to re-run: a name that already exists comes back as a duplicate error,
 * which is reported and skipped rather than treated as a failure.
 */

interface Provision {
  slug: string;
  spec: TemplateSpec;
}

const PROVISIONS: Provision[] = Object.entries(CAMPAIGN_TEMPLATES).flatMap(([slug, specs]) =>
  specs.map((spec) => ({ slug, spec }))
);
async function main(): Promise<void> {
  let created = 0;
  let existing = 0;
  let failed = 0;

  for (const provision of PROVISIONS) {
    const organization = await findOrganizationBySlug(provision.slug);
    if (!organization) {
      console.log(`  SKIP  ${provision.slug} — no such business`);
      failed++;
      continue;
    }
    if (!organization.whatsappBusinessAccountId) {
      console.log(`  SKIP  ${provision.slug} — no WhatsApp account connected`);
      failed++;
      continue;
    }

    const result = await createMetaTemplate(
      organization.whatsappBusinessAccountId,
      provision.spec
    );

    if (result.ok) {
      created++;
      console.log(`  NEW   ${provision.spec.name} → ${result.status ?? "submitted"}`);
    } else if (/already exists|duplicate/i.test(result.error ?? "")) {
      // Re-running is the normal case after a rejection is corrected, so an
      // existing name is expected rather than an error.
      existing++;
      console.log(`  HAVE  ${provision.spec.name} — already at Meta`);
    } else {
      failed++;
      console.log(`  FAIL  ${provision.spec.name} — ${result.error}`);
    }
  }

  console.log(`\n${created} submitted, ${existing} already present, ${failed} failed.\n`);

  // Pull the result straight back in, so the product reflects Meta immediately
  // rather than after some later sync. Newly submitted templates arrive as
  // PENDING; that is the honest state and the picker will show it.
  console.log("Syncing statuses back from Meta:");
  for (const slug of new Set(PROVISIONS.map((provision) => provision.slug))) {
    const organization = await findOrganizationBySlug(slug);
    if (!organization?.whatsappBusinessAccountId) continue;
    const result = await syncTemplatesForOrganization(organization);
    console.log(
      `  ${slug.padEnd(20)} ${result.synced} template(s), ${result.approved} approved`
    );
  }

  // Assert the mirror is actually populated. "No errors" is not evidence that
  // anything was written — the failure this catches is a sync that succeeded
  // against an empty list and left the picker as empty as it found it.
  if (created === 0 && existing === 0) {
    console.error("\nNothing was created and nothing already existed — check the errors above.");
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
