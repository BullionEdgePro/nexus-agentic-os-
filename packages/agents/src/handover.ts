import { GoogleGenAI } from "@google/genai";
import { loadRecentHistory } from "./switchboard.js";

/**
 * What an employee needs to know before they message a customer themselves.
 *
 * The handoff already works: the employee gets a WhatsApp link, the AI is
 * paused, the conversation is flagged. What they do not get is any idea what
 * the agent has already said — so they open WhatsApp cold and either re-ask a
 * question the customer has answered, or contradict a commitment the agent
 * made an hour ago. The second one is the expensive failure: to the customer it
 * is one business changing its story.
 *
 * So the brief leads with what was already promised, not with a synopsis.
 *
 * THIS MUST NEVER BLOCK THE HANDOFF. The employee taking the conversation is
 * the operation that matters; the summary is a convenience on top of it. Every
 * failure here returns null and lets the handoff proceed — a model timeout must
 * not stop someone answering their customer.
 */

export interface HandoverBrief {
  /** Two or three sentences. Null when it could not be produced. */
  summary: string | null;
  /** Why there is no summary, for the UI to show instead of an empty panel. */
  unavailableReason: string | null;
  /** How many turns it was built from, so a thin brief is visibly thin. */
  turnsConsidered: number;
}

const EMPTY = (reason: string, turns = 0): HandoverBrief => ({
  summary: null,
  unavailableReason: reason,
  turnsConsidered: turns,
});

export async function buildHandoverBrief(conversationId: string): Promise<HandoverBrief> {
  let history: Awaited<ReturnType<typeof loadRecentHistory>>;
  try {
    history = await loadRecentHistory(conversationId, 30);
  } catch {
    return EMPTY("Could not read the conversation history.");
  }

  if (history.length === 0) {
    // Not a failure. A conversation with no messages is a real state, and
    // saying "nothing has been said yet" is more useful than an error.
    return EMPTY("Nothing has been said in this conversation yet.", 0);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return EMPTY("Summaries are not configured on this deployment.", history.length);

  const transcript = history
    .map((turn) => `${turn.role === "user" ? "Customer" : "Us"}: ${turn.content}`)
    .join("\n");

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
                `A colleague is about to continue this WhatsApp conversation from their own phone. ` +
                `Write them two or three sentences covering, in this order: anything we have already ` +
                `promised or committed to, what the customer is actually asking for, and what is still ` +
                `unresolved.\n\n` +
                `Use only what is in the transcript. If something is unclear, say it is unclear rather ` +
                `than filling it in — they are about to act on this, and a confident guess is worse ` +
                `than an admitted gap. Write plainly, no preamble, no bullet points.\n\n` +
                `Transcript:\n${transcript}`,
            },
          ],
        },
      ],
    });

    const summary = (response.text ?? "").trim();
    if (!summary) return EMPTY("The summary came back empty.", history.length);

    return { summary, unavailableReason: null, turnsConsidered: history.length };
  } catch {
    // Deliberately swallowed. The caller is mid-handoff and the employee is
    // waiting; surfacing this as an error would fail the operation that matters
    // for the sake of the one that does not.
    return EMPTY("The summary could not be generated just now.", history.length);
  }
}
