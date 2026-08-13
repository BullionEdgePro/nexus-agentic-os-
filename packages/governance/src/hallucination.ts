import Anthropic from "@anthropic-ai/sdk";
import type { HallucinationRisk } from "@nexus/shared";

let client: Anthropic | undefined;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

export interface HallucinationCheckInput {
  draftReply: string;
  conversationHistory: string; // last few turns, flattened as plain text
  ragContext?: string; // retrieved knowledge-base passages the reply should be grounded in, if any
}

/**
 * Marker written into the notes when the judge could not be reached.
 *
 * Exported and matched on rather than re-typed as a string literal in two
 * places: an operator that searches for text a developer might reword is an
 * operator that goes quiet the day somebody improves the wording.
 */
export const JUDGE_UNAVAILABLE = "GOVERNANCE JUDGE UNAVAILABLE —";

export interface HallucinationCheckResult {
  risk: HallucinationRisk;
  notes: string;
}

const JUDGE_TOOL = {
  name: "report_risk",
  description: "Report the hallucination-risk assessment for the draft reply.",
  input_schema: {
    type: "object" as const,
    properties: {
      risk: { type: "string", enum: ["low", "medium", "high"] },
      notes: { type: "string", description: "One sentence justifying the rating." },
    },
    required: ["risk", "notes"],
  },
};

/**
 * LLM-as-judge: asks a model call independent of the agent that drafted the
 * reply whether it asserts anything not supported by the conversation
 * history / RAG context it was given. Errs toward "medium" on judge failure
 * rather than silently passing an unchecked reply.
 */
export async function evaluateHallucinationRisk(
  input: HallucinationCheckInput
): Promise<HallucinationCheckResult> {
  try {
    const response = await getClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system:
        "You are a strict fact-grounding auditor for a customer-support AI. " +
        "Given the conversation history, optional retrieved knowledge-base context, " +
        "and a draft reply, judge whether the draft asserts any fact (price, " +
        "policy, legal claim, appointment, commitment) that is NOT supported by " +
        "the history or context. Call report_risk exactly once.",
      tools: [JUDGE_TOOL],
      tool_choice: { type: "tool", name: "report_risk" },
      messages: [
        {
          role: "user",
          content:
            `Conversation history:\n${input.conversationHistory || "(none)"}\n\n` +
            `Retrieved context:\n${input.ragContext || "(none provided)"}\n\n` +
            `Draft reply to audit:\n${input.draftReply}`,
        },
      ],
    });

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );
    const parsed = toolUse?.input as { risk?: string; notes?: string } | undefined;
    const risk = parsed?.risk;
    if (risk === "low" || risk === "medium" || risk === "high") {
      return { risk, notes: parsed?.notes ?? "" };
    }
    return { risk: "medium", notes: "Judge returned an unparseable response." };
  } catch (err) {
    // "medium" IS NOT A VERDICT HERE, IT IS THE ABSENCE OF ONE, and the two are
    // indistinguishable to every consumer downstream.
    //
    // Found in production 2026-08-13: the Anthropic key has no credit, so every
    // judge call had been throwing and returning this. `shouldEscalateReply`
    // escalates on medium for every tenant outside the tolerant allowlist, so
    // the three legal businesses were escalating every reply they generated,
    // while zipicka and sfs-international were sending replies nobody had
    // checked. Neither shows as an error. The deck reports "hallucination risk
    // medium" and that reads like the judge did its job.
    //
    // The value stays "medium" deliberately — it is the safe reading, and
    // changing the enum would push a new state into every consumer. What
    // changes is that the note now carries a MACHINE-MATCHABLE marker, so the
    // `judge-offline` operator can count these without a model call and say
    // out loud that governance is not running. See apps/api/src/services/
    // operators.ts.
    return {
      risk: "medium",
      notes: `${JUDGE_UNAVAILABLE} ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
