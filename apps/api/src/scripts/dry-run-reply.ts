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
import { routeToDomainAgent } from "@nexus/agents";
import { searchKnowledge } from "@nexus/knowledge";
import { evaluateOutgoingMessage } from "@nexus/governance";

/** Not a dialable number, so this can never collide with a real contact. */
const PROBE_WA_ID = "999000000000002";

const QUESTIONS: Record<string, string> = {
  "juris-prime": "Hi, I need my UK degree certificate attested for a job in Dubai. What do you need from me and how long does it take?",
  "juris-prime-legal": "My tenant has not paid rent for three months and refuses to leave. What can I do?",
  abr: "My brother has been arrested in Dubai and we need a criminal defence lawyer urgently. Can you help?",
  "sfs-international": "I am moving to Dubai next month and looking for a two bedroom apartment to rent. Can you help me?",
  zipicka: "I ordered something last week and want to return it. How long do I have?",
};

async function main() {
  console.log("Dry run — what each agent would reply. Nothing is sent.\n");

  for (const [slug, question] of Object.entries(QUESTIONS)) {
    const organization = await withAllTenants("dry-run: tenant registry", () =>
      findOrganizationBySlug(slug)
    );
    if (!organization) {
      console.log(`${slug}: NO SUCH BUSINESS\n`);
      continue;
    }

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

        const reply = await agent.respond(
          {
            organizationId: organization.id,
            contactWaId: PROBE_WA_ID,
            contactName: "Dry run",
            messageId: `dry-run-${slug}`,
            text: question,
            timestamp: new Date().toISOString(),
          },
          []
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

        // The same judge the live pipeline runs before sending. Its verdict is
        // what decides whether this reply would have gone out or escalated.
        const verdict = await evaluateOutgoingMessage({
          draftReply: reply.text,
          conversationHistory: `customer: ${question}`,
          ragContext: hits.map((h) => h.content).join("\n\n"),
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

  console.log("=".repeat(78));
  console.log("Read these. There is no pass mark — that judgement is a person's.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
