/**
 * Does a published deep link actually route, against the live registry?
 *
 *   docker compose -f docker-compose.prod.yml exec -T worker  *     npx tsx apps/api/src/scripts/deep-link-check.ts
 *
 * `deep-link.test.mjs` already unit-tests the classifier against invented
 * businesses. This runs the same classifier against the REAL registry — the
 * actual slugs, the actual dialable numbers, all five businesses competing on
 * one number — which is the difference between knowing the function works and
 * knowing the links you are about to publish work.
 *
 * The four website edits are the highest-value thing pending on this platform,
 * and every one of them depends on a mechanism no real message has ever
 * exercised. Every inbound message in production has been "hi" or "2" — never a
 * tagged one. If `#juris-prime` does not route, the owner pastes four links,
 * customers arrive, and every one of them still lands in the triage menu: the
 * edits would look like they had failed, and the reason would be here.
 *
 * Reads the real registry and calls the real classifier. Sends nothing, writes
 * nothing, and touches no conversation.
 */
import { pathToFileURL } from "node:url";
import { withAllTenants, listOrganizations, getDisplayNumbers } from "@nexus/db";
import { classifyBusiness, buildDeepLink } from "@nexus/agents";

async function main() {
  console.log("Deep links — does a published link route to the business that published it?\n");
  const [organizations, numbers] = await withAllTenants("deep-link check: registry", () =>
    Promise.all([listOrganizations(), getDisplayNumbers()])
  );

  // The same shape the switchboard builds for a shared number: every business
  // answering on it is a candidate, so a tag has to beat keyword matching
  // against four competitors rather than route by default.
  const routable = organizations.map((o) => ({
    id: o.id,
    slug: o.slug,
    name: o.name,
    routingKeywords: [] as string[],
  }));

  let failures = 0;
  for (const organization of organizations) {
    const number = numbers.get(organization.id);
    if (!number) {
      console.log(`  skip  ${organization.slug.padEnd(20)} no dialable number`);
      continue;
    }

    // Reconstruct exactly what the customer's phone will send: the prefilled
    // text out of the published wa.me link, decoded as WhatsApp delivers it.
    const url = buildDeepLink(routable.find((r) => r.slug === organization.slug)!, number);
    const prefilled = decodeURIComponent(new URL(url).searchParams.get("text") ?? "");

    const outcome = classifyBusiness(prefilled, routable);
    const ok = outcome.kind === "routed" && outcome.business.slug === organization.slug;
    if (!ok) failures += 1;

    console.log(
      `  ${ok ? "ok  " : "FAIL"}  ${organization.slug.padEnd(20)} ${
        outcome.kind === "routed"
          ? `routed to ${outcome.business.slug} via ${outcome.matched.join(", ")}`
          : `NOT ROUTED (${outcome.kind}) — this customer would get the triage menu`
      }`
    );
  }

  // The negative case matters as much: a message that merely mentions a
  // business must NOT be treated as a published link, or the tag stops meaning
  // "the customer came from our website".
  const loose = classifyBusiness("do you know anything about #juris-prime", routable);
  const looseOk = !(loose.kind === "routed" && loose.matched.includes("#juris-prime"));
  if (!looseOk) failures += 1;
  console.log(
    `  ${looseOk ? "ok  " : "FAIL"}  ${"tag mid-sentence".padEnd(20)} ${
      looseOk ? "not treated as a published link" : "TREATED AS A LINK — the tag has lost its meaning"
    }`
  );

  console.log(
    failures === 0
      ? "\nPASS — every published link routes to the business that published it."
      : `\n${failures} link(s) do not route. The four website edits would not work.`
  );
  process.exit(failures === 0 ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("FAILED:", e?.message ?? e);
    process.exit(1);
  });
}
