import { searchKnowledge } from "@nexus/knowledge";
import type { ToolDefinition } from "../types.js";
import { defaultToolRegistry } from "./registry.js";

const SEARCH_TIMEOUT_MS = 8000;

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
      const hits = await Promise.race([
        searchKnowledge({
          organizationId: ctx.organizationId,
          employeeId: ctx.employeeId ?? null,
          query,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), SEARCH_TIMEOUT_MS)
        ),
      ]);

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
