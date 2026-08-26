/**
 * What does each business's agent actually SAY?
 *
 *   docker compose -f docker-compose.prod.yml exec -T worker \
 *     npx tsx apps/api/src/scripts/dry-run-reply.ts
 *
 * `retrieval-check.ts` proves the right PAGE comes back. This is the next
 * question and nobody has ever answered it for four of the five businesses:
 * given that page, what does the agent write? Retrieval being correct and the
 * reply being good are different properties, and a WhatsApp customer only ever
 * sees the second.
 *
 * NOTHING IS SENT AND NOTHING IS WRITTEN. It loads the tenant's real agent,
 * calls the real model with the real system prompt, and runs the real
 * governance judge over the draft — then prints it. No WhatsApp call, no
 * conversation row, no message row, no lead assessment. The one thing this
 * script must never do is cost a real person a message, so the send is not
 * merely skipped, it is absent: this file does not import the WhatsApp client.
 *
 * IT RUNS IN THE NUMBER OWNER'S TRANSACTION, which is the only shape a customer
 * ever experiences and was not the shape this script used until 2026-08-18.
 *
 * It used to open `withTenant(organization.id)` — scoped to the business being
 * asked. That is the one context in which the defect found that day is
 * invisible. All five businesses answer on one number, so the live pipeline
 * scopes its transaction to the number's OWNER and then asks about the SERVING
 * business; under RLS the difference is not an error, it is zero rows. On 17
 * August a customer picked a business from the triage menu and received nothing
 * at all for seventeen hours, and this script would have printed a perfectly
 * good reply for that same business on that same day.
 *
 * So it now resolves the owner from the phone number and runs inside its
 * transaction, exactly as the worker does. `shared-number-check` proves each
 * READ survives that scoping; this proves the whole chain does, in the only
 * currency that matters — the words a customer would receive.
 *
 * NOT A GATE, AND DELIBERATELY NOT ONE. It costs a model call per question and
 * its output is prose, which a person has to read. Wiring prose into a
 * pass/fail check means inventing a rubric, and a rubric that can be satisfied
 * is one the agent will satisfy while still answering badly. The governance
 * verdict IS machine-readable and is printed alongside, because that number is
 * what the live pipeline acts on.
 */
import { pathToFileURL } from "node:url";
import { withTenant, withAllTenants, findOrganizationBySlug, findNumberOwner } from "@nexus/db";
import { routeToDomainAgent, describeNobodyToEscalateTo } from "@nexus/agents";
import { hasStaffOnShift } from "../services/availability.js";
import { searchKnowledge } from "@nexus/knowledge";
import { evaluateOutgoingMessage } from "@nexus/governance";

/** Not a dialable number, so this can never collide with a real contact. */
const PROBE_WA_ID = "999000000000002";

/**
 * What each business is asked.
 *
 * ONE QUESTION EACH WAS NOT ENOUGH. The first version asked every business the
 * thing it exists to answer, which reads well and probes nothing: an agent that
 * handles its own subject fluently can still promise what the platform will not
 * do, quote a fee its prompt forbids, or answer a question meant for one of the
 * four other businesses on the same number.
 *
 * The escalation defect found on 2026-08-22 was in the FIRST question — the one
 * that looked like the safe one. So the list below deliberately asks each
 * business something awkward as well as something ordinary, and every awkward
 * one probes a specific rule the platform depends on:
 *
 *   the fee guard          every legal prompt forbids quoting fees, and a firm
 *                          quoted a price it did not agree to is a real problem
 *   booking with no rota   three businesses have the tool on and nobody on it.
 *                          `booking-without-anyone` asserts on the deck right
 *                          now that these customers are "offered a call back" —
 *                          which was read off the tool's code, never from what
 *                          the agent actually says
 *   the wrong business     five firms share one number, so this arrives often
 *   a tool it lacks        Zipicka has no booking tool at all
 */
/**
 * ============================================================
 * WHY EACH BUSINESS ALSO GETS AN ARABIC QUESTION
 * ============================================================
 *
 * Added 2026-08-26. Every scenario here was English, and this platform serves
 * the UAE: the routing keywords are half Arabic, the triage menu is written
 * with an Arabic comma, the lead scorer claims EN + AR, and the CSV export
 * carries a byte-order mark specifically so Arabic names survive Excel.
 *
 * Nothing had ever checked what an agent SAYS in Arabic, and it is not the
 * same path. Every knowledge source on this platform is an English website, so
 * an Arabic question has to retrieve across languages — the embedding model is
 * multilingual and this is the one thing that makes that a claim rather than an
 * assumption — and then answer in the customer's language without inventing the
 * detail it could not find.
 *
 * There are three ways for that to go wrong and only one of them is visible in
 * an English test: retrieving nothing and refusing (safe), retrieving correctly
 * and answering in the wrong language (embarrassing), or retrieving correctly
 * and inventing Arabic specifics the English source never said (dangerous).
 */
const QUESTIONS: Record<string, string[]> = {
  "juris-prime": [
    "Hi, I need my UK degree certificate attested for a job in Dubai. What do you need from me and how long does it take?",
    "What is your fee for attesting a degree certificate?",
    "أحتاج تصديق شهادة جامعية من بريطانيا لوظيفة في دبي. ما هي المستندات المطلوبة وكم تستغرق العملية؟",
  ],
  "juris-prime-legal": [
    "My tenant has not paid rent for three months and refuses to leave. What can I do?",
    "Can I book a consultation for tomorrow morning?",
    "المستأجر لم يدفع الإيجار منذ ثلاثة أشهر ويرفض المغادرة. ماذا أفعل؟",
  ],
  abr: [
    "My brother has been arrested in Dubai and we need a criminal defence lawyer urgently. Can you help?",
    "How much will it cost to defend him, and how long will the case take?",
    "أخي موقوف في دبي ونحتاج محامي جنائي بشكل عاجل. هل يمكنكم المساعدة؟",
  ],
  "sfs-international": [
    "I am moving to Dubai next month and looking for a two bedroom apartment to rent. Can you help me?",
    "Do you sell phone cases and chargers?",
    "أبحث عن شقة غرفتين للإيجار في دبي. هل يمكنكم مساعدتي؟",
  ],
  zipicka: [
    "I ordered something last week and want to return it. How long do I have?",
    "Can I book an appointment to come to your office on Thursday?",
    "طلبت منتجاً الأسبوع الماضي وأريد إرجاعه. كم يوماً لدي؟",
  ],
};

async function main() {
  console.log("Dry run — what each agent would reply. Nothing is sent.\n");

  for (const [slug, questions] of Object.entries(QUESTIONS)) {
    const organization = await withAllTenants("dry-run: tenant registry", () =>
      findOrganizationBySlug(slug)
    );
    if (!organization) {
      console.log(`${slug}: NO SUCH BUSINESS\n`);
      continue;
    }

    for (const question of questions) {
    console.log("=".repeat(78));
    console.log(`${slug}  —  ${organization.name}`);
    console.log(`CUSTOMER: ${question}\n`);

    try {
      // The transaction belongs to whoever owns the WhatsApp number, and the
      // question is asked of the business the switchboard would have routed to.
      // Falls back to the business itself when it owns its own number, which is
      // also what the pipeline does.
      // `is_number_owner`, not "the first one on this number". The first
      // version of this took the head of a name-ordered list and ran every dry
      // run from ABR's transaction — the one direction production never takes.
      const owner = await withAllTenants("dry-run: number owner", () =>
        findNumberOwner(organization.whatsappPhoneNumberId)
      );
      const scope = owner ?? organization;
      if (scope.id !== organization.id) {
        console.log(`  (asked from inside ${scope.slug}'s transaction — ${scope.slug} owns the number)`);
      }

      await withTenant(scope.id, async () => {
        const agent = await routeToDomainAgent({ id: organization.id, slug: organization.slug });
        if (!agent) {
          console.log("  NO ACTIVE AGENT CONFIGURED — this business would not reply at all.\n");
          return;
        }

        // WHAT THE AGENT IS ACTUALLY TOLD, not just the system prompt.
        //
        // This called respond(event, []) until 2026-08-22 -- an EMPTY history --
        // and the reply path never does. It prepends fenced notes: memory,
        // open follow-ups, existing appointments, any recalled procedure, and
        // whether there is anybody to hand over to. So this script's whole
        // premise ("the words a customer would receive") was answering for an
        // agent that had been told less than the real one.
        //
        // It showed. On the day the escalation note shipped, this script printed
        // ABR still promising "I'm escalating this to our team right away" --
        // not because the note failed, but because this file never passed it.
        //
        // THE OTHER FOUR NOTES CANNOT BE HONESTLY SUPPLIED HERE and are absent
        // on purpose. Memory, follow-ups and appointments are facts about a
        // REAL contact, and this script deliberately has none -- inventing them
        // would print a reply no customer could receive. A procedure needs a
        // live one, and no business has any. This note depends only on the
        // business, so it is the one that belongs.
        const canPromiseAPerson = await hasStaffOnShift(organization.id).catch(() => true);
        const notes = canPromiseAPerson
          ? []
          : [{ role: "assistant" as const, content: describeNobodyToEscalateTo() }];

        if (!canPromiseAPerson) {
          console.log("  (nobody on the rota — the agent is told it cannot promise a person)");
        }

        const reply = await agent.respond(
          {
            organizationId: organization.id,
            contactWaId: PROBE_WA_ID,
            contactName: "Dry run",
            messageId: `dry-run-${slug}`,
            text: question,
            timestamp: new Date().toISOString(),
          },
          notes
        );

        console.log(`AGENT (${agent.config.model}):`);
        console.log(reply.text.split("\n").map((line) => `  ${line}`).join("\n"));

        // What the agent had to work with. Printed because a vague reply from
        // good passages and a vague reply from nothing need different fixes,
        // and the reply alone cannot tell you which you are looking at.
        const hits = await searchKnowledge({
          organizationId: organization.id,
          query: question,
          limit: 3,
        });
        console.log(
          `\n  grounded in: ${
            hits.length === 0
              ? "NOTHING — no passage cleared the similarity floor"
              : hits
                  .map((h) => `${(h.sourceUri ?? h.sourceTitle).replace(/^https?:\/\/[^/]+/, "")} (${h.score.toFixed(2)})`)
                  .join(", ")
          }`
        );

        // THE JUDGE MUST SEE WHAT THE AGENT SAW, NOT A SECOND SEARCH.
        //
        // This passed `hits` — the three passages from the separate lookup above
        // — while the agent had retrieved its own, with its own queries and a
        // limit of five. The judge was therefore asked whether a reply was
        // supported by a SUBSET of the evidence behind it, and answered
        // correctly and uselessly: on 18 August it returned `high` for SFS
        // twice, calling a listing fabricated that is in the knowledge base four
        // chunks over — sauna, HZ-09, HZ-04, doorman and the exact prices all
        // present. Nothing was hallucinated; the harness had hidden the source.
        //
        // Worse than a wrong number on a screen: that verdict was repeated as
        // fact, as "the most serious fabrication this project has produced". A
        // tool that manufactures the defect it was built to detect is the most
        // expensive kind of wrong.
        //
        // The live path never had this bug — `processor.ts` reconstructs the
        // context from `result.toolCalls`, "what the agent read, not what a
        // second search might have found". This now does the same, which is also
        // the only version that tests what production does.
        const agentContext = (reply.toolCalls ?? [])
          .filter((call) => call.name === "search_knowledge")
          .map((call) => (typeof call.output === "string" ? call.output : JSON.stringify(call.output)))
          .join("\n\n");

        // The same judge the live pipeline runs before sending. Its verdict is
        // what decides whether this reply would have gone out or escalated.
        const verdict = await evaluateOutgoingMessage({
          draftReply: reply.text,
          conversationHistory: `customer: ${question}`,
          ragContext: agentContext || undefined,
          businessName: organization.name,
        });
        console.log(
          `  governance: hallucination risk ${verdict.hallucinationRisk}, PII ${
            verdict.piiFlagged ? "FLAGGED" : "clean"
          }${verdict.notes ? ` — ${verdict.notes}` : ""}\n`
        );
      });
    } catch (err) {
      // One business failing must not hide the other four. A model quota is
      // exhausted per key, so the first failure usually means the rest will
      // fail too — which is itself worth seeing in full rather than aborting on.
      console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    }
  }

  console.log("=".repeat(78));
  console.log("Read these. There is no pass mark — that judgement is a person's.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
