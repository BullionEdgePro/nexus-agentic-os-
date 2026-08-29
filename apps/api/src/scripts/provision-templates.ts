import { findOrganizationBySlug } from "@nexus/db";
import { createMetaTemplate, type TemplateSpec } from "../lib/whatsapp-client.js";
import { syncTemplatesForOrganization } from "../services/template-sync.js";
import { OPT_OUT_BUTTON_LABEL } from "@nexus/agents";

/**
 * Creates one message template per business and submits it to Meta for review.
 *
 * Why one each, when all five share a WhatsApp number: the customer sees the
 * sender as the same number either way, so the message text is the only thing
 * telling them who is writing. A generic "we have an update for you" from a
 * number that also handles four unrelated businesses is exactly the kind of
 * message people report as spam — and reports are what get a WhatsApp number
 * restricted. Naming the business in the body is a deliverability decision as
 * much as a branding one.
 *
 * THE FIRST FIVE are UTILITY rather than MARKETING. Utility templates describe an
 * existing relationship — a request the customer made, a matter already open —
 * and Meta approves them readily and prices them lower. A marketing template
 * needs explicit opt-in and, on an account still completing verification, is
 * the likelier rejection. These say "there is an update on the thing you asked
 * us about", which is what a business CRM actually sends.
 *
 * Each body carries one placeholder, the customer's name. Meta requires an
 * example value for every placeholder or the submission is rejected outright.
 *
 * THE SIXTH IS MARKETING, and is the exception the paragraph above describes.
 * It exists because staff campaigns had nothing worth sending: the only
 * templates a Zipicka staff member could pick were an order update and two
 * generic Klaviyo ones. It carries a "Stop promotions" quick-reply button, and
 * that button is not decoration — `contacts.reengagement_opted_out` had NO
 * WRITER until this was built, so every customer on the platform had been
 * unable to opt out since the column was created in migration 035. A marketing
 * message nobody can stop is what produces a spam report, and the quality
 * rating a spam report damages belongs to one number that six businesses share.
 *
 * Its wording claims nothing that could stop being true. The store's own site
 * advertises 20% off and free delivery; neither is in here, because a template
 * is approved once and sent for months, and the discount in particular is the
 * claim a previous piece of work was blocked on for not actually existing.
 *
 * Run:  docker exec nexus-api-1 node dist/scripts/provision-templates.js
 * Safe to re-run: a name that already exists comes back as a duplicate error,
 * which is reported and skipped rather than treated as a failure.
 */

interface Provision {
  slug: string;
  spec: TemplateSpec;
}

const PROVISIONS: Provision[] = [
  {
    slug: "zipicka",
    spec: {
      name: "zipicka_order_update",
      language: "en",
      category: "UTILITY",
      body:
        "Hello {{1}}, this is Zipicka. There is an update on your order with us. " +
        "Reply to this message and our team will help you right away.",
      example: ["Ahmed"],
    },
  },
  {
    slug: "zipicka",
    spec: {
      name: "zipicka_promotions",
      language: "en",
      category: "MARKETING",
      body:
        "Hello {{1}}, this is Zipicka. We stock beauty, pet care, home essentials and " +
        "electronics with delivery across the UAE. Reply to this message to see what is " +
        "available or to ask us anything. If you would rather not hear from us, tap Stop " +
        "promotions below.",
      example: ["Ahmed"],
      buttons: [OPT_OUT_BUTTON_LABEL],
    },
  },
  {
    slug: "sfs-international",
    spec: {
      name: "sfs_property_update",
      language: "en",
      category: "UTILITY",
      body:
        "Hello {{1}}, this is SFS International Real Estate. There is an update on the " +
        "property enquiry you made with us. Reply to this message and our team will assist you.",
      example: ["Ahmed"],
    },
  },
  {
    slug: "juris-prime",
    spec: {
      name: "juris_prime_attestation_update",
      language: "en",
      category: "UTILITY",
      body:
        "Hello {{1}}, this is Juris Prime. There is an update on your document attestation " +
        "request. Reply to this message and our team will assist you.",
      example: ["Ahmed"],
    },
  },
  {
    slug: "juris-prime-legal",
    spec: {
      name: "juris_prime_legal_update",
      language: "en",
      category: "UTILITY",
      body:
        "Hello {{1}}, this is Juris Prime Legal. There is an update on the legal service " +
        "you requested from us. Reply to this message and our team will assist you.",
      example: ["Ahmed"],
    },
  },
  {
    slug: "abr",
    spec: {
      name: "abr_matter_update",
      language: "en",
      category: "UTILITY",
      body:
        "Hello {{1}}, this is ABR Advocates and Legal Consultants. There is an update on " +
        "the matter you raised with our office. Reply to this message and our team will assist you.",
      example: ["Ahmed"],
    },
  },
];

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
