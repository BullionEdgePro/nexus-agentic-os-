import Anthropic from "@anthropic-ai/sdk";

/**
 * One place where this platform asks a model for a short piece of text.
 *
 * Four callers used to hold their own `GoogleGenAI` client and their own copy
 * of the same request shape: contact recall, the handover brief, the BI
 * copilot's routing step, and the boot preflight. That meant four places to
 * change when the provider changed, and — the reason this exists rather than
 * four edits — four chances to change three of them.
 *
 * WHY EVERY GENERATION CALL IS ANTHROPIC AND EMBEDDINGS ARE NOT.
 *
 * Anthropic has no embeddings endpoint. Its API is Messages, Batches, Files,
 * token counting and model listing. So `gemini-embedding-001` stays, and
 * `GEMINI_API_KEY` survives for exactly that one call in
 * packages/knowledge/src/embed.ts — nothing else.
 *
 * That is not an oversight to tidy up later. The 393 stored vectors were
 * produced by that model; vectors from a different embedder are not comparable
 * to them, so switching means re-embedding every passage and retrieval returns
 * nothing until it finishes. Worth doing deliberately, not as a side effect of
 * a generation migration.
 *
 * The practical upside: generation and embeddings now sit on different vendors
 * and therefore different quotas. The 429 that killed a dry run —
 * `generate_content_free_tier_requests, limit: 5` — cannot take retrieval down
 * with it any more.
 */

let client: Anthropic | undefined;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

/**
 * The model these short, structured jobs run on.
 *
 * Haiku, not Opus, and deliberately: these are summarise-this and pick-one-of-six
 * tasks against text that is already in the prompt. The env var stays so a
 * tenant hitting a limit can be moved without a deploy — its name is
 * NEXUS_ROUTER_MODEL for continuity with the value that is already set on the
 * VPS, and it now takes an Anthropic model id.
 */
export const TEXT_MODEL = process.env.NEXUS_ROUTER_MODEL || "claude-haiku-4-5";

export interface CompleteTextInput {
  /** Steering that is not the question — persona, format, refusals. */
  system?: string;
  /** The actual request, including any context it needs inline. */
  prompt: string;
  /**
   * Hard ceiling on the reply.
   *
   * Small on purpose. Every caller here wants a few sentences or one word, and
   * a cap is the only thing that makes a runaway generation cost bounded rather
   * than discovered on a bill.
   */
  maxTokens?: number;
}

/**
 * Ask for a short piece of text. Returns the reply, or null.
 *
 * NULL RATHER THAN THROWING, because of what every caller does with a failure:
 * contact recall skips the note, the handover brief falls back to the raw
 * transcript, the copilot declines to route. None of them should take a
 * customer's reply down with them, and a helper that throws makes "best effort"
 * something each caller has to remember to write.
 *
 * The one thing it must not do is return a plausible string on failure. A
 * caller cannot tell an empty answer from a broken one, and this codebase has
 * §8 rows about exactly that.
 */
export async function completeText(input: CompleteTextInput): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  try {
    const response = await getClient().messages.create({
      model: TEXT_MODEL,
      max_tokens: input.maxTokens ?? 512,
      ...(input.system ? { system: input.system } : {}),
      messages: [{ role: "user", content: input.prompt }],
    });

    // `content` is a union. Narrowing to text blocks drops tool-use and
    // thinking blocks rather than stringifying them into the answer.
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    return text || null;
  } catch {
    return null;
  }
}
