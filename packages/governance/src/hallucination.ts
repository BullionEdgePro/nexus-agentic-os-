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
  /**
   * The business whose agent wrote this. WITHOUT IT THE JUDGE MARKS AN AGENT
   * NAMING ITS OWN COMPANY AS A HALLUCINATION.
   *
   * Found on the first production run after the judge came back to life. Juris
   * Prime Legal's agent answered an eviction question well, declined to give
   * legal advice, offered a consultation — and scored HIGH. Verbatim: "The
   * draft reply references 'Juris Prime Legal' as a service provider and
   * implies the ability to set up consultations with their attorneys, but this
   * company and service offering are not mentioned anywhere in the conversation
   * history or retrieved context."
   *
   * The judge was right on its own terms. It had simply never been told who was
   * speaking. High risk escalates for every tenant, so this would have blocked
   * nearly every reply the three strict businesses produce — a correct answer,
   * withheld, and replaced by a promise of a human.
   */
  businessName?: string;
  /**
   * What the business has stated about ITSELF — its own system prompt.
   *
   * THE SAME DEFECT AS businessName, ONE STEP FURTHER OUT. That field exists
   * because the judge marked an agent naming its own company as a
   * hallucination. It still marked an agent stating its own ADDRESS, phone
   * number or opening hours as one, and those come from the same place: things
   * the business said about itself, which live in the prompt and in no
   * retrieved passage.
   *
   * Found on 2026-08-26 in the first Arabic dry run. ABR's reply to "my brother
   * has been arrested, we need a criminal lawyer urgently" scored HIGH —
   * verbatim: "asserts a specific office address (building name, location,
   * district in Dubai, and hours) that does not appear anywhere in the
   * retrieved knowledge base". The identical English scenario scored LOW,
   * because retrieval happened to return a page carrying the address that time.
   * The verdict turned on which chunks came back rather than on whether the
   * reply was true.
   *
   * And the platform had TOLD it to say that. `describeNobodyToEscalateTo`
   * instructs the agent to give its direct contact details when nobody is on
   * the rota — so the path where this matters most, an urgent matter with
   * nobody to escalate to, is the path that got flagged for obeying.
   */
  businessFacts?: string;
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
            // Identity first, because it changes how everything after it reads:
            // a business describing its own services is the speaker, not an
            // unsupported factual assertion.
            (input.businessName
              ? `You are auditing a reply written BY ${input.businessName} to one of its own ` +
                `customers. The business naming itself, describing its own services, or ` +
                `inviting a consultation is NOT a hallucination — it is the speaker. Judge the ` +
                `verifiable claims instead: prices, timeframes, legal or factual assertions, ` +
                `and promises about what will happen next.\n\n`
              : "") +
            // The speaker's own account of itself, offered as a SOURCE rather
            // than as instructions. A reply repeating the firm's own address is
            // quoting its employer, not inventing a fact — and without this the
            // judge can only see whatever retrieval happened to return, so the
            // same true sentence scores differently from one message to the
            // next.
            (input.businessFacts
              ? `What this business states about itself, in its own standing instructions. ` +
                `Treat these as verified for its identity, contact details, address, opening ` +
                `hours and the services it offers:\n${input.businessFacts}\n\n`
              : "") +
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
