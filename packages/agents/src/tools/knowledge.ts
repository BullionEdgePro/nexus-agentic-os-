import { searchKnowledge, searchKnowledgeLexical } from "@nexus/knowledge";
import type { ToolDefinition } from "../types.js";
import { defaultToolRegistry } from "./registry.js";

const SEARCH_TIMEOUT_MS = 8000;

/**
 * The fallback gets its own, much shorter budget.
 *
 * It runs after the primary has already spent up to 8 seconds failing, and a
 * customer waiting 16 seconds for a degraded answer is a worse outcome than
 * waiting 8 for an honest deferral. Postgres full-text over a few hundred chunks
 * returns in single-digit milliseconds; anything approaching this ceiling means
 * the database is in trouble too, and there is nothing left to fall back to.
 */
const LEXICAL_TIMEOUT_MS = 2500;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

/**
 * search_knowledge: grounded retrieval over the tenant's own documents.
 *
 * Every result carries its source title and index date, and the description
 * tells the model to answer only from what comes back. That pairing is the
 * point: retrieval without attribution just gives a model more confident
 * material to paraphrase, and an ungrounded claim wearing a citation is worse
 * than no citation at all — especially for the legal tenants, whose governance
 * policy already escalates on unverifiable statements.
 *
 * Fails soft on every path, matching check_inventory: an empty or errored
 * lookup returns a structured "couldn't confirm" so the agent escalates to a
 * human instead of filling the gap from its own priors.
 */
export const searchKnowledgeTool: ToolDefinition = {
  name: "search_knowledge",
  description:
    "Search this business's own documents, FAQs, and SOPs for information needed to answer the customer. " +
    "Answer ONLY from the excerpts returned, and name the source you used. " +
    "If nothing relevant comes back, say you'll check with a colleague — never fill the gap from general knowledge.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What to look up, phrased as the customer's underlying question.",
      },
    },
    required: ["query"],
  },
  handler: async (input, ctx) => {
    const query = String(input.query ?? "").trim();
    if (!query) return { found: false, note: "No search query was provided." };

    try {
      const hits = await withTimeout(
        searchKnowledge({
          organizationId: ctx.organizationId,
          employeeId: ctx.employeeId ?? null,
          query,
        }),
        SEARCH_TIMEOUT_MS
      );

      if (hits.length === 0) {
        return {
          found: false,
          // Machine-readable, so the caller never has to read the note to learn
          // what happened. "nothing matched" and "the lookup broke" are
          // different facts and must not be told apart by parsing prose.
          outcome: "miss" as const,
          note: "Nothing in the knowledge base matched that closely enough to rely on.",
        };
      }

      return {
        found: true,
        outcome: "hit" as const,
        // KEPT, BUT ADDED ON A PREMISE THAT TURNED OUT TO BE FALSE.
        //
        // The story this comment used to tell: juris-prime's agent retrieved the
        // right page and then wrote "5-10 working days" where the page says
        // "10 working days", and added a document list the page does not carry.
        // The judge scored it medium four runs in a row. This rule was written
        // to stop it, broadened when the next run failed the same way, and then
        // honestly reported as not having worked.
        //
        // It had not worked because there was nothing to fix. The medium came
        // from `dry-run-reply` handing the judge its OWN three-passage search
        // instead of the passages the agent actually read — so the judge was
        // asked whether a reply was supported by a subset of its own evidence.
        // With the harness corrected, the same question on the same agent scores
        // LOW, and the judge names the very items it had called invented as
        // "directly supported by the retrieved excerpts".
        //
        // So: no figure was ever narrowed, no requirement invented, and the page
        // was never the problem either. Three conclusions published that day were
        // downstream of one broken measurement.
        //
        // The rule stays because it is true independently of the evidence that
        // prompted it — it is what "answer ONLY from the excerpts returned",
        // which has been in the tool description since the tool existed, means in
        // practice. It is not retained as a fix, and nothing here should be read
        // as evidence that it prevented anything.
        //
        // Platform-level on purpose. This is not a business decision about
        // wording — no tenant's system prompt is edited.
        constraints:
          "Every specific in your reply must appear in these excerpts: figures, prices, " +
          "timelines, reference numbers, document requirements, and the steps of a process. " +
          "Quote them as stated — do not narrow a range, add a bound, combine values from " +
          "different excerpts, convert units, or fill in the plausible next item of a list. " +
          "If an excerpt qualifies something ('usually', 'up to', 'depending on'), carry the " +
          "qualification with it. Where the excerpts do not cover what was asked, say so and " +
          "offer to confirm rather than estimating. A particular you supplied is read as a " +
          "commitment by this business, whether it is a price, a deadline or a document list.",
        results: hits.map((hit) => ({
          excerpt: hit.content,
          source: hit.sourceTitle,
          uri: hit.sourceUri,
          indexedAt: hit.lastIndexedAt,
          relevance: Number(hit.score.toFixed(3)),
        })),
      };
    } catch (err) {
      const reason = err instanceof Error && err.message === "timeout" ? "timed out" : "failed";

      // ----------------------------------------------------------------
      // SEMANTIC SEARCH IS DOWN. READ THE SAME SHELF WITH WORDS.
      // ----------------------------------------------------------------
      //
      // Reached only from this catch, never from a miss. The knowledge is
      // sitting in the database as plain text and Postgres needs no provider to
      // match words in it, so the choice during an outage is between a keyword
      // answer and telling every customer for the duration that a colleague
      // will confirm — which sounds like a business with nothing on file.
      //
      // Failing soft twice over: if this throws as well, nothing is lost that
      // was not already lost, and the reply goes out exactly as it did before
      // this existed.
      try {
        const lexical = await withTimeout(
          searchKnowledgeLexical({
            organizationId: ctx.organizationId,
            employeeId: ctx.employeeId ?? null,
            query,
          }),
          LEXICAL_TIMEOUT_MS
        );

        if (lexical.length > 0) {
          return {
            found: true,
            // Its own outcome, not 'hit'. A degraded answer that recorded
            // itself as a healthy one would hide the outage inside its own
            // mitigation and leave `retrieval-unavailable` sweeping for a
            // failure that had stopped being written down.
            outcome: "degraded" as const,
            // The real guard on this feature, and it is addressed to the model
            // rather than enforced by a number. Measured on the 18 retrieval
            // probes, keyword search returns a confidently wrong page often
            // enough to matter — "what happens to my property when I die"
            // returns real-estate law, because two areas of law share a noun —
            // and it outranks correct hits when it does, so no score threshold
            // can catch it. Judging whether a passage actually answers the
            // question is the one part of this a model does better than the
            // matcher, so it is told plainly what it is holding.
            degraded: true,
            note:
              "Semantic search is unavailable, so these excerpts were found by matching WORDS, " +
              "not meaning. Treat them as unverified: use one only if it plainly answers what " +
              "the customer actually asked, and ignore any that merely share a word with the " +
              "question. If none of them clearly answers it, say a colleague will confirm — " +
              "that is the right outcome here, not a failure.",
            results: lexical.map((hit) => ({
              excerpt: hit.content,
              source: hit.sourceTitle,
              uri: hit.sourceUri,
              indexedAt: hit.lastIndexedAt,
              // No `relevance`. The semantic path's number is a cosine
              // similarity against a floor of 0.55 and this one is a
              // `ts_rank_cd` with no floor at all; printing both under one name
              // invites the model — and anyone reading a transcript — to
              // compare two things that do not share a scale.
              match: "keyword" as const,
            })),
          };
        }
      } catch {
        // Deliberately silent. The outcome below is already the honest one.
      }

      return {
        found: false,
        // The distinction this platform could not previously see: retrieval was
        // unavailable, not empty. Recorded so an operator can notice an outage
        // that otherwise looks exactly like "we have nothing on that".
        outcome: "failed" as const,
        note: `Knowledge lookup ${reason}; a colleague can confirm this.`,
      };
    }
  },
};

defaultToolRegistry.register(searchKnowledgeTool);
