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
    return {
      risk: "medium",
      notes: `Judge call failed, defaulting to medium: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
