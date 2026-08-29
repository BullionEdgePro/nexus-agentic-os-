import Anthropic from "@anthropic-ai/sdk";
import { pdfToText } from "./pdf-text.js";

/**
 * A model call that can look at what somebody attached.
 *
 * ============================================================
 * WHY NOT JUST EXTEND completeText
 * ============================================================
 *
 * `completeText` is deliberately small: one system prompt, one string, a short
 * cap, and it swallows every error into `null`. Nine callers depend on exactly
 * that — a routing step that returns null falls back to a rule, and none of
 * them wants an exception.
 *
 * This is a different shape of job. The help assistant needs conversation turns
 * rather than one string, images and documents rather than text, a much larger
 * answer, and — most importantly — it needs to know WHY a call failed, because
 * "the model is unreachable", "that file is too big" and "I cannot read video"
 * are three different sentences to show a person. Folding that into
 * `completeText` would mean either changing nine callers or giving it two
 * personalities.
 */

let client: Anthropic | undefined;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

/**
 * The model the assistant answers on.
 *
 * Separate from NEXUS_ROUTER_MODEL, which is Haiku and correct for pick-one-of
 * -six routing. This one is asked open questions by a person who is waiting, so
 * it is worth more capable — and it is its own variable so the two can be tuned
 * independently rather than one being dragged by the other.
 */
export const ASSISTANT_MODEL = process.env.NEXUS_ASSISTANT_MODEL || "claude-sonnet-5";

/** What Anthropic will actually look at. Everything else is refused by name. */
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export const DOCUMENT_TYPES = ["application/pdf"] as const;
export const TEXT_TYPES = [
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
  "text/html",
] as const;

export interface Attachment {
  name: string;
  mediaType: string;
  /** base64, without the data: prefix. */
  data: string;
}

export interface RichTurn {
  role: "user" | "assistant";
  text: string;
}

export type RichResult =
  | { ok: true; text: string }
  | { ok: false; reason: "no-key" | "unreadable-file" | "bad-image" | "too-large" | "upstream"; detail: string };

/**
 * Why a file cannot be looked at, in the words to show the person.
 *
 * ============================================================
 * VIDEO IS THE ONE PEOPLE ASK FOR
 * ============================================================
 *
 * The model reads images, PDFs and text. It cannot watch video and cannot
 * listen to audio — no amount of prompting changes that, and accepting the
 * upload only to answer vaguely about the filename is worse than refusing.
 *
 * So video is refused BY NAME, with the thing that does work said in the same
 * breath: a screenshot of the moment in question is a picture, and pictures it
 * reads perfectly well.
 */
export function describeUnsupported(mediaType: string, name: string): string | null {
  const type = mediaType.toLowerCase();
  if ([...IMAGE_TYPES, ...DOCUMENT_TYPES, ...TEXT_TYPES].includes(type as never)) return null;

  if (type.startsWith("video/")) {
    return `I cannot watch video, so I cannot tell you anything about ${name}. If you take a screenshot of the moment you are asking about and send that, I can read it.`;
  }
  if (type.startsWith("audio/")) {
    return `I cannot listen to audio, so ${name} is not something I can help with. If you have a transcript, paste it and I will work from that.`;
  }
  if (type.includes("word") || type.includes("officedocument") || type.includes("excel")) {
    return `I cannot open ${name} directly. Save it as a PDF and send that, or paste the part you want me to look at.`;
  }
  return `I cannot read ${name} — I can look at images, PDFs and plain text files.`;
}

/**
 * Roughly how many bytes a base64 string holds.
 *
 * Used for a limit shown to a person, so an approximation is fine and the
 * arithmetic is worth doing in one place rather than at each call site.
 */
export function decodedBytes(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}

export interface RichInput {
  system: string;
  history: RichTurn[];
  question: string;
  attachments?: Attachment[];
  maxTokens?: number;
}

/**
 * Ask, with whatever was attached.
 *
 * Attachments ride on the LAST user message rather than being described in the
 * system prompt, which is what makes "what is wrong with this screenshot" work:
 * the model sees the picture next to the question about it, in the same turn.
 */
export async function completeRich(input: RichInput): Promise<RichResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, reason: "no-key", detail: "No model key is configured." };
  }

  // The SDK pinned here (0.32.1) has no ContentBlockParam union and no
  // document block. Text and image are what it types, and they are what this
  // sends — PDFs are read to text below rather than passed through.
  const content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];

  for (const file of input.attachments ?? []) {
    const type = file.mediaType.toLowerCase();

    if ((IMAGE_TYPES as readonly string[]).includes(type)) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: type as (typeof IMAGE_TYPES)[number], data: file.data },
      });
      continue;
    }

    if ((DOCUMENT_TYPES as readonly string[]).includes(type)) {
      const read = pdfToText(Buffer.from(file.data, "base64"));
      if (!read.ok) {
        return {
          ok: false,
          reason: "unreadable-file",
          detail:
            read.reason === "scanned"
              ? `${file.name} is a scan — a picture of a page rather than text, so there is nothing in it for me to read. Send a screenshot or photo of the part you are asking about instead; I can read images.`
              : `${file.name} could not be opened. If it is password-protected or unusual, try exporting it again.`,
        };
      }
      content.push({
        type: "text",
        text: `--- contents of ${file.name} (PDF) ---
${read.text.slice(0, 200_000)}`,
      });
      continue;
    }

    if ((TEXT_TYPES as readonly string[]).includes(type)) {
      // Inlined as text rather than sent as a document block: a CSV read as
      // prose is answerable, and it keeps the request far smaller.
      let decoded: string;
      try {
        decoded = Buffer.from(file.data, "base64").toString("utf8");
      } catch {
        return { ok: false, reason: "unreadable-file", detail: `${file.name} could not be read as text.` };
      }
      content.push({
        type: "text",
        text: `--- contents of ${file.name} ---\n${decoded.slice(0, 200_000)}`,
      });
      continue;
    }

    return {
      ok: false,
      reason: "unreadable-file",
      detail: describeUnsupported(file.mediaType, file.name) ?? `I cannot read ${file.name}.`,
    };
  }

  content.push({ type: "text", text: input.question });

  const messages: Anthropic.MessageParam[] = [
    ...input.history.map((turn) => ({
      role: turn.role,
      content: turn.text,
    })),
    { role: "user" as const, content },
  ];

  try {
    const response = await getClient().messages.create({
      model: ASSISTANT_MODEL,
      max_tokens: input.maxTokens ?? 1400,
      system: input.system,
      messages,
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    return text
      ? { ok: true, text }
      : { ok: false, reason: "upstream", detail: "The model returned nothing." };
  } catch (err) {
    // Surfaced rather than swallowed. The caller shows a person a sentence, and
    // "the file was too big" and "the provider is down" need different ones.
    const message = err instanceof Error ? err.message : String(err);
    const tooLarge = /too large|exceeds|maximum size|request_too_large/i.test(message);

    // "Could not process image" is a 400 about the FILE, not an outage. Left in
    // the upstream bucket it became "I could not reach the assistant" — which
    // sends somebody to check their connection over a picture that was simply
    // too small. Found by a probe whose own 8x8 test fixture triggered it.
    const badImage = /could not process image|unsupported image|image.*(invalid|corrupt)/i.test(message);

    return {
      ok: false,
      reason: badImage ? "bad-image" : tooLarge ? "too-large" : "upstream",
      detail: badImage
        ? "I could not read that image. Very small or unusual files sometimes fail — try a normal screenshot or photo."
        : message.slice(0, 300),
    };
  }
}
