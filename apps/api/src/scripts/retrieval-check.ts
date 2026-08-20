/**
 * Does each business's agent find the RIGHT page?
 *
 *   docker compose -f docker-compose.prod.yml exec -T worker \
 *     npx tsx apps/api/src/scripts/retrieval-check.ts
 *
 * `self-check.ts` already asks one question per tenant and asserts that
 * something matched. That is a real check and it is not this one: a query for
 * "do you handle criminal defence" that returns the privacy policy passes it.
 * When ABR held five passages — all from its home page — every question it
 * could be asked matched something, and the check was green the entire time.
 *
 * So this asks a realistic customer question and names the page that should
 * answer it. Retrieval is what the agent's reply is built from; if the wrong
 * passage comes back, the reply is wrong with a citation attached, which is
 * harder to catch than an obvious hallucination.
 *
 * WHY THE BAR IS "IN THE TOP THREE" rather than rank one. The agent is given
 * several passages and writes from all of them, so the useful question is
 * whether the right page is in what it reads. Demanding rank one would fail on
 * ties between two genuinely relevant pages — juris-prime-legal has both
 * /power-of-attorney/ and /private-notary/ — and a check that cries wolf over a
 * correct answer gets switched off.
 *
 * EVERY EXPECTATION HERE WAS READ OFF THE LIVE knowledge_sources TABLE, not
 * guessed from what the sites probably contain. An expectation naming a page
 * that does not exist fails forever and gets deleted rather than investigated.
 */
import { pathToFileURL } from "node:url";
import { withTenant, withAllTenants, findOrganizationBySlug, findNumberOwner } from "@nexus/db";
import { searchKnowledge, searchKnowledgeLexical } from "@nexus/knowledge";

interface Probe {
  /** What a customer would actually type on WhatsApp. */
  question: string;
  /**
   * Substring of the URI of a page that would answer it. More than one is
   * allowed, because more than one page can be a correct answer — see the SFS
   * "tell me about your agency" probe for the case that forced it.
   */
  expect: string | string[];
}

const expectations = (probe: Probe): string[] =>
  Array.isArray(probe.expect) ? probe.expect : [probe.expect];

/**
 * An expectation starting with `https://` must match the URI EXACTLY; anything
 * else is a substring.
 *
 * The distinction exists because of one probe. Naming SFS's home page as the
 * substring "sfsintrealestate.com/" matches every page on the site, so the
 * probe would have passed on any result at all — a check that cannot fail,
 * which is worse than no check, and it was written while fixing a genuine
 * failure. A home page is the one URL a substring cannot express.
 */
function matches(uri: string | null, want: string): boolean {
  if (!uri) return false;
  return want.startsWith("https://") ? uri === want : uri.includes(want);
}

const HOW_MANY_READ = 3;

const PROBES: Record<string, Probe[]> = {
  "juris-prime": [
    { question: "how do I get MOFA attestation for my degree certificate?", expect: "/mofa-attestation-process-in-uae/" },
    { question: "I need a notary public in Dubai", expect: "/notary-public-dubai/" },
    { question: "can you attest a power of attorney for me?", expect: "/power-of-attorney-attestation-dubai/" },
    { question: "who can witness my signature on a document?", expect: "/witnessing-of-signature-dubai/" },
  ],

  "juris-prime-legal": [
    { question: "can you help me set up a company in Dubai?", expect: "/company-formation/" },
    { question: "my tenant has stopped paying rent, how do I evict him?", expect: "/evict-a-non-paying-tenant-in-dubai/" },
    { question: "I need someone to draft a contract for my business", expect: "/contract-drafting/" },
    { question: "what happens to my property when I die, do I need a will?", expect: "/will-inheritance/" },
    { question: "I was injured in a car accident and want to claim", expect: "/personal-injury-claims/" },
  ],

  abr: [
    { question: "do you handle criminal defence cases?", expect: "criminal-law" },
    { question: "we have a dispute with our building contractor", expect: "construction-law" },
    { question: "I want to file for divorce and custody of my children", expect: "family-law" },
    { question: "a shipping container of ours was seized at the port", expect: "maritime-law" },
    { question: "another company is using our brand name", expect: "intellectual-property" },
  ],

  "sfs-international": [
    { question: "how can I get in touch with your office?", expect: "/contact/" },
    // TWO ACCEPTABLE ANSWERS, and the reason is a finding rather than a
    // convenience. This probe failed: it returned /terms-and-conditions/, the
    // home page and /privacy-policy/. SFS's /about/ page is about 250 words —
    // a mission statement and three testimonials — so it yields two passages
    // and loses to pages with nine. The home page carries the real description
    // of the agency and is a correct answer to this question.
    //
    // Pinning this to /about/ alone would leave a red check nobody can fix
    // without rewriting somebody's website, and a permanently-red check is one
    // people stop reading. The content gap is real and belongs to whoever owns
    // that copy; it is recorded in ARCHITECTURE §9.5, not enforced here.
    { question: "tell me about your agency", expect: ["/about/", "https://sfsintrealestate.com/"] },
  ],

  zipicka: [
    { question: "how long do I have to return an item?", expect: "/policies/refund-policy" },
    { question: "how much is delivery and how long does it take?", expect: "/policies/shipping-policy" },
  ],
};

let failures = 0;
let checks = 0;

function report(label: string, ok: boolean, detail: string) {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label} — ${detail}`);
}

/**
 * `--lexical` measures the OUTAGE path instead: the same probes, the same
 * corpus, read by `searchKnowledgeLexical`.
 *
 * It exists because the fallback's whole justification is a ratio — during an
 * outage the alternative is not semantic search, it is nothing — and a ratio
 * quoted in a code comment stops being measured the moment it is written down.
 * Three places cite "13 of 18": `retrieve.ts`, the `retrieval-unavailable`
 * operator's detail text, and HANDOFF. This is what re-derives it.
 *
 * IT SETS NO EXIT CODE. A gate that failed when keyword search missed a page
 * would be asserting that the degraded path is as good as the real one, which is
 * the opposite of what it is for; the misses are the finding, not a regression.
 * Read the list.
 */
const LEXICAL = process.argv.includes("--lexical");

async function main() {
  if (LEXICAL) return lexicalSurvey();
  console.log("Retrieval quality — does the right page come back?\n");

  for (const [slug, probes] of Object.entries(PROBES)) {
    const organization = await withAllTenants("retrieval-check: tenant registry", () =>
      findOrganizationBySlug(slug)
    );
    if (!organization) {
      report(slug, false, "no such business");
      continue;
    }

    // `is_number_owner`, not the first business on the number: two of this
    // platform's gates once called ABR the owner because listOrganizations
    // orders by name, and ran every probe from the one direction production
    // never takes.
    const owner = await withAllTenants("retrieval-check: number owner", () =>
      findNumberOwner(organization.whatsappPhoneNumberId)
    );

    console.log(
      `${slug}${owner && owner.id !== organization.id ? `  (asked from inside ${owner.slug}'s transaction)` : ""}`
    );
    for (const probe of probes) {
      // FROM THE NUMBER OWNER'S TRANSACTION, which is the only shape a
      // customer ever experiences.
      //
      // This used to open `withTenant(organization.id)` — scoped to the
      // business being asked about. That is the one context in which the
      // shared-number defect is invisible, and this gate is a knowledge check
      // that would have reported "the right page came back" on a day when no
      // routed customer could reach any page at all. `dry-run-reply` had
      // exactly this blind spot and was corrected on 18 August; this was noted
      // the same day and left, because `searchKnowledge` self-widens now and so
      // the gate passes either way.
      //
      // Passing either way is the problem. A harness that agrees with
      // production by coincidence stops agreeing the moment somebody removes
      // the widening — and reports a knowledge result rather than the missing
      // context that caused it. So it runs the way the reply pipeline runs:
      // the owner's transaction, asking about the serving business.
      const scope = owner ?? organization;
      const hits = await withTenant(scope.id, () =>
        searchKnowledge({
          organizationId: organization.id,
          query: probe.question,
          limit: HOW_MANY_READ,
        })
      );

      const wanted = expectations(probe);
      const rank = hits.findIndex((hit) => wanted.some((want) => matches(hit.sourceUri, want)));
      const detail =
        rank === 0
          ? `top hit, score ${hits[0].score.toFixed(3)}`
          : rank > 0
            ? `rank ${rank + 1} of ${hits.length}, score ${hits[rank].score.toFixed(3)}`
            : hits.length === 0
              ? "NOTHING MATCHED AT ALL"
              : `expected ${wanted.join(" or ")}, got ${hits.map((h) => (h.sourceUri ?? "?").replace(/^https?:\/\/[^/]+/, "")).join(", ")}`;

      report(`"${probe.question.slice(0, 46)}"`, rank >= 0, detail);
    }
    console.log("");
  }

  if (failures > 0) {
    console.log(`${failures} of ${checks} probes did not find the page that answers them.`);
    console.log("A wrong passage becomes a wrong answer WITH a citation, which reads as authoritative.");
    process.exitCode = 1;
    return;
  }
  console.log(`PASS — all ${checks} probes found their page within the top ${HOW_MANY_READ}.`);
}

/**
 * How much of the knowledge base is still reachable when Google is not.
 *
 * Prints the misses in full, because "13 of 18" is the reassuring half of the
 * finding and the other half is WHICH five and how confidently wrong they look:
 * a will-and-inheritance question answered from real-estate law outranks correct
 * hits, so no score threshold removes it. That is why the tool labels these
 * excerpts as keyword matches and tells the model to ignore any that merely
 * share a word with the question.
 */
async function lexicalSurvey() {
  console.log("Keyword fallback — what survives an embedding outage?\n");

  let found = 0;
  let total = 0;

  for (const [slug, probes] of Object.entries(PROBES)) {
    const organization = await withAllTenants("retrieval-check: tenant registry", () =>
      findOrganizationBySlug(slug)
    );
    if (!organization) continue;

    console.log(`${slug}`);
    for (const probe of probes) {
      const hits = await withTenant(organization.id, () =>
        searchKnowledgeLexical({
          organizationId: organization.id,
          query: probe.question,
          limit: HOW_MANY_READ,
        })
      );

      const wanted = expectations(probe);
      const rank = hits.findIndex((hit) => wanted.some((want) => matches(hit.sourceUri, want)));
      total += 1;
      if (rank >= 0) found += 1;

      const detail =
        rank >= 0
          ? `rank ${rank + 1} of ${hits.length}`
          : hits.length === 0
            ? "nothing matched — the customer would be deferred, as they are today"
            : `WRONG PAGE: ${hits.map((h) => (h.sourceUri ?? "?").replace(/^https?:\/\/[^/]+/, "") || "/").join(", ")}`;

      console.log(`  ${rank >= 0 ? "ok  " : "    "}  "${probe.question.slice(0, 46)}" — ${detail}`);
    }
    console.log("");
  }

  console.log(`${found} of ${total} probes found their page by keyword alone.`);
  console.log(`Semantic search finds all ${total}. This is the gap the fallback trades for not being nothing.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
