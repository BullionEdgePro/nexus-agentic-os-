import { GoogleGenAI } from "@google/genai";
import { getContactMemory, upsertContactMemory } from "@nexus/db";
import { loadRecentHistory } from "./switchboard.js";

/**
 * Remembering a customer between conversations (F10, episodic).
 *
 * Two halves: writing a memory after an exchange, and reading it back when the
 * same person returns. Both are deliberately conservative, because the failure
 * mode is not forgetting — it is an agent confidently telling a customer
 * something about themselves that is out of date or was never true.
 */

/** Below this, there is nothing worth remembering and a summary would invent one. */
const MIN_MESSAGES_TO_REMEMBER = 4;

/**
 * How much of a memory to show the agent.
 *
 * Capped so a long history cannot crowd out the retrieved business knowledge
 * that answers the actual question. Recall is context, not the answer.
 */
const MAX_MEMORY_CHARS = 600;

export async function rememberContact(input: {
  organizationId: string;
  contactId: string;
  conversationId: string;
}): Promise<{ written: boolean; reason?: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { written: false, reason: "no api key" };

  const history = await loadRecentHistory(input.conversationId, 40);
  if (history.length < MIN_MESSAGES_TO_REMEMBER) {
    // A two-message exchange summarised into "the customer asked about X and
    // seems interested in Y" is a fabricated profile, not a memory.
    return { written: false, reason: "too short to summarise honestly" };
  }

  const transcript = history
    .map((turn) => `${turn.role === "user" ? "Customer" : "Us"}: ${turn.content}`)
    .join("\n");

  const existing = await getContactMemory(input.organizationId, input.contactId);

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: process.env.NEXUS_ROUTER_MODEL ?? "gemini-3.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                `Keep a short standing note about this customer so a colleague picking up a future ` +
                `conversation knows who they are.\n\n` +
                (existing ? `Existing note:\n${existing.summary}\n\n` : "") +
                `Latest conversation:\n${transcript}\n\n` +
                `Write at most three sentences covering what they wanted, anything settled, and ` +
                `anything outstanding. Record only what was actually said. Do not infer their ` +
                `budget, seniority, urgency or intent from tone — a guess written down becomes a ` +
                `fact the next reader acts on. If the existing note is contradicted by the latest ` +
                `conversation, prefer the latest. No preamble.`,
            },
          ],
        },
      ],
    });

    const summary = (response.text ?? "").trim().slice(0, MAX_MEMORY_CHARS);
    if (!summary) return { written: false, reason: "empty summary" };

    await upsertContactMemory({
      organizationId: input.organizationId,
      contactId: input.contactId,
      summary,
      sourceMessages: history.length,
    });
    return { written: true };
  } catch (err) {
    // Never fatal. Memory is an enhancement; failing to write one must not
    // affect the customer's reply, which has already been sent by now.
    return { written: false, reason: err instanceof Error ? err.message : "unknown" };
  }
}

/**
 * The memory line to put in front of the agent, or null.
 *
 * Returned as a labelled block rather than blended into the system prompt, so
 * the model can tell recalled context from instruction — and so that anything
 * wrong in it reads as a note that may be stale rather than as ground truth.
 */
export async function recallContact(
  organizationId: string,
  contactId: string
): Promise<string | null> {
  const memory = await getContactMemory(organizationId, contactId);
  if (!memory) return null;

  const days = Math.floor((Date.now() - new Date(memory.updatedAt).getTime()) / 86_400_000);
  const age = days <= 0 ? "earlier today" : days === 1 ? "yesterday" : `${days} days ago`;

  return (
    `Note from a previous conversation with this customer (last updated ${age}, ` +
    `from ${memory.sourceMessages} messages). It may be out of date — if what they say now ` +
    `contradicts it, believe them, and never recite it back to them as fact:\n` +
    memory.summary.slice(0, MAX_MEMORY_CHARS)
  );
}
