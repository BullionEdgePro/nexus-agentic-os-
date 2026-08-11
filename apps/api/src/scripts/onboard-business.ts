/**
 * Add a business to the platform.
 *
 * Replaces "write a migration and redeploy", which is how all five current
 * tenants were created. That works at five and is not a platform.
 *
 * Two-step by design. The first run analyses and changes nothing; it prints the
 * keyword collisions and makes you look at them. Only `--confirm` writes.
 *
 * The reason is the shared number. Routing keywords live in one namespace
 * across every business, so onboarding is never an isolated act: a word claimed
 * twice stops routing for BOTH claimants. Add a sixth tenant claiming
 * "contract" and every contract enquiry that used to reach the law firm starts
 * returning a triage menu — a regression in a business that was working fine,
 * caused by adding a different one, and invisible at insert time. A prompt you
 * have to answer is the cheapest place to catch that.
 *
 * Usage:
 *   npx tsx src/scripts/onboard-business.ts --slug=acme --name="Acme Trading" \
 *     --keywords="acme,trading,import" --website=https://acme.ae [--confirm]
 *
 * The WhatsApp number is inherited from the existing shared-number tenants
 * unless --phone-number-id is given, because on this deployment a new business
 * joining the shared number is the normal case.
 */

import {
  listOrganizations,
  analyseKeywordCollisions,
  onboardBusiness,
  getDisplayNumbers,
  withAllTenants,
  getPool,
} from "@nexus/db";

function arg(name: string): string | undefined {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const slug = arg("slug");
  const name = arg("name");
  const keywords = (arg("keywords") ?? "")
    .split(",")
    .map((keyword) => keyword.trim())
    .filter(Boolean);
  const website = arg("website") ?? null;
  const confirm = process.argv.includes("--confirm");

  if (!slug || !name || keywords.length === 0) {
    console.error(
      "Need --slug, --name and --keywords.\n" +
        'e.g. --slug=acme --name="Acme Trading" --keywords="acme,trading,import"\n'
    );
    process.exit(1);
  }

  const organizations = await withAllTenants("onboard: read tenants", () => listOrganizations());
  const numbers = await withAllTenants("onboard: read numbers", () => getDisplayNumbers());

  if (organizations.some((organization) => organization.slug === slug)) {
    console.error(`A business with slug "${slug}" already exists.`);
    process.exit(1);
  }

  // Inherit the shared number rather than asking for it. Getting a
  // phone_number_id wrong produces a business that looks live and can never
  // receive a message, which is exactly the state four tenants sat in for
  // months before the switchboard.
  const donor = organizations.find((organization) => numbers.get(organization.id));
  const phoneNumberId = arg("phone-number-id") ?? donor?.whatsappPhoneNumberId;
  const wabaId = arg("waba-id") ?? donor?.whatsappBusinessAccountId;
  const displayNumber = arg("display-number") ?? (donor ? numbers.get(donor.id) ?? null : null);

  if (!phoneNumberId || !wabaId) {
    console.error("No existing business to inherit a WhatsApp number from — pass --phone-number-id and --waba-id.");
    process.exit(1);
  }

  console.log(`\nBusiness   ${name}  (#${slug})`);
  console.log(`Number     ${displayNumber ?? "none"}  (phone_number_id ${phoneNumberId})`);
  console.log(`Keywords   ${keywords.join(", ")}`);
  console.log(`Website    ${website ?? "none"}`);

  const collisions = await analyseKeywordCollisions(keywords);
  console.log("\nKeyword collisions");
  if (collisions.length === 0) {
    console.log("  none — every keyword is unclaimed");
  } else {
    for (const collision of collisions) {
      console.log(`  "${collision.keyword}" is already claimed by ${collision.existing.join(", ")}`);
    }
    console.log(
      "\n  A keyword claimed by two businesses routes to NEITHER — the switchboard\n" +
        "  returns a triage menu instead. Adding these degrades routing for the\n" +
        "  businesses above, which are working today. Remove them, or accept that\n" +
        "  those enquiries will ask the customer which company they mean."
    );
  }

  if (!confirm) {
    console.log("\nNothing was written. Re-run with --confirm to create it.\n");
    await getPool().end();
    process.exit(0);
  }

  const result = await onboardBusiness({
    slug,
    name,
    whatsappPhoneNumberId: phoneNumberId,
    whatsappBusinessAccountId: wabaId,
    whatsappDisplayNumber: displayNumber,
    timezone: arg("timezone") ?? "Asia/Dubai",
    websiteUrl: website,
    routingKeywords: keywords,
    // Deliberately plain. A generated prompt that guesses at a business's
    // services would have the agent stating things nobody at that business
    // approved — the governance failure §2.4 exists to prevent. It answers from
    // indexed knowledge and escalates otherwise until someone writes a real one.
    systemPrompt:
      `You are the WhatsApp assistant for ${name}. Answer only from the knowledge you retrieve ` +
      `about this business. If you do not find an answer, say you will pass the question to a ` +
      `colleague and ask for their name and what they need — do not guess, do not quote prices, ` +
      `and do not make commitments on the business's behalf. This prompt is a placeholder: it ` +
      `should be replaced with one written by someone who knows ${name}.`,
  });

  console.log(`\nCreated  ${result.organizationId}`);
  console.log("\nStill to do");
  for (const item of result.outstanding) console.log(`  - ${item}`);
  console.log(
    `  - Replace the placeholder system prompt. Until then the agent can only\n` +
      `    answer from indexed pages and will escalate everything else.\n`
  );

  await getPool().end();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
