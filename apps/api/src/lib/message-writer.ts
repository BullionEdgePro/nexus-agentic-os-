import { completeText } from "@nexus/agents";
import type { BusinessVoice } from "@nexus/db";
import { staffTemplateBody } from "@nexus/shared";

/**
 * Bulk messaging's AI writer (30 Oct 2026).
 *
 * An admin gives a one-line brief and gets three drafts in the business's
 * voice, or asks for the message in the editor shorter, more formal, in
 * Arabic, or fixed after WhatsApp refused it. Drafts are suggestions: they
 * land in an editor the admin reads, and the existing review step still comes
 * before any send. So what this file guarantees is narrow and checked here:
 * no fact the brief did not give, and nothing that would reach a client
 * literally — no "[Your Name]", no placeholder but {name}, and for an approved
 * message nothing WhatsApp's template rules would refuse.
 *
 * Prompt, request and parsing are plain functions so all of it is tested
 * without the model; only writeDrafts and rewriteDraft call it.
 */

/** Claude Opus 5.5: client-facing copy, a few calls a campaign, so quality over cost. */
export const WRITER_MODEL = process.env.NEXUS_WRITER_MODEL || "claude-opus-5-5";

export type WriterKind = "quick" | "approved";
export type RewriteChange = "shorter" | "formal" | "arabic" | "fix";

export interface WriterBrief {
  kind: WriterKind;
  brief: string;
  tone?: "friendly" | "professional";
  length?: "short" | "detailed";
  language?: "en" | "ar";
}

// Opus 5.5 always thinks and its thinking counts toward max_tokens, so the cap
// is roomy; low effort keeps three short drafts quick. 45 seconds keeps a slow
// answer from outliving the proxy in front of the API. The fallback re-runs a
// declined request on another model inside the same call.
const CALL = { model: WRITER_MODEL, effort: "low", fallback: true, maxTokens: 4000, timeoutMs: 45_000 } as const;

export function writerSystemPrompt(kind: WriterKind, voice: BusinessVoice): string {
  const about = [voice.tagline, voice.summary].filter(Boolean).join(" ");
  const rules = [
    // The stored description is background for the voice, not copy: some carry
    // internal notes ("the only tenant with a live WhatsApp number") and
    // policies the admin did not choose to mention in this message.
    `You write WhatsApp messages that ${voice.name} sends to its own customers.${about ? ` Background on ${voice.name}, for tone only — never quote it or use its facts: ${about}` : ""}`,
    "Write as the business, in plain, warm language, the way a person there would type it.",
    "Use {name} where the customer's first name belongs; it is filled in for each customer. Use no other placeholder, brackets or blanks to fill in.",
    "Never invent prices, dates, offers, links or phone numbers. Use only facts from the brief, exactly as written.",
    "No all-capital words, and at most two emoji.",
  ];
  if (kind === "quick") {
    rules.push("Each message stays under 600 characters.");
  } else {
    rules.push(
      "Each message stays under 1024 characters; WhatsApp reviews it as a marketing template before it can be sent.",
      "Messages never start or end with {name}, and contain no link unless the brief gives one.",
      "Do not mention opting out or replying STOP: a Stop button is added to the message."
    );
  }
  return rules.join(" ");
}

export function draftRequest(input: WriterBrief): string {
  return [
    `Brief: ${input.brief.trim()}`,
    `Tone: ${input.tone === "professional" ? "professional and courteous" : "friendly and warm"}.`,
    `Length: ${input.length === "detailed" ? "a short paragraph with the key facts" : "two or three sentences"}.`,
    `Language: ${input.language === "ar" ? "Arabic (Modern Standard Arabic)" : "English"}.`,
    "Write three different drafts, each taking a different approach: one direct, one warm, one that opens with a question.",
    "Keep every fact from the brief exactly as written.",
    "Separate the drafts with a line containing only ---. Return only the three drafts, with no titles, numbering or notes.",
  ].join("\n");
}

const CHANGES: Record<RewriteChange, string> = {
  shorter: "Make it shorter: one or two sentences, keeping the main point.",
  formal: "Make it more formal and courteous.",
  arabic: "Write it in Arabic (Modern Standard Arabic).",
  fix: "WhatsApp refused it as a template. Rewrite it so WhatsApp approves it, keeping what it says.",
};

export function rewriteRequest(kind: WriterKind, text: string, change: RewriteChange, reason?: string): string {
  return [
    `Message:\n${text.trim()}`,
    CHANGES[change] + (change === "fix" && reason ? ` WhatsApp's reason: ${reason}.` : ""),
    kind === "approved" ? "It must still pass WhatsApp's template review." : "",
    "Keep {name} and every fact exactly as written. Return only the rewritten message.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Numbering and labels a model adds despite being asked not to: "1.", "2)", "Draft 3:", "**Draft 1:**". */
const LEADING_LABEL = /^\*{0,2}\s*(?:draft\s*\d+\s*[:.)\-]?|\d+\s*[.)])\s*\*{0,2}\s*/i;

function cleanDraft(raw: string): string {
  return raw
    .trim()
    .replace(LEADING_LABEL, "")
    .replace(/^["“”]+|["“”]+$/g, "")
    .trim();
}

/** Whether a draft can go into an editor that sends what it holds. */
function usable(draft: string, kind: WriterKind): boolean {
  if (/\[[^\]]*\]/.test(draft)) return false; // "[Your Name]"
  if (/\{(?!name\})[^}]*\}/i.test(draft)) return false; // "{customer}"
  if (kind === "quick") return draft.length <= 4096;
  return !("error" in staffTemplateBody(draft));
}

/** The drafts in a reply, cleaned, at most three; unusable ones are dropped rather than repaired. */
export function parseDrafts(text: string, kind: WriterKind): string[] {
  return text
    .split(/^\s*-{3,}\s*$/m)
    .map(cleanDraft)
    .filter((draft) => draft && usable(draft, kind))
    .slice(0, 3);
}

const WRITER_TURNS_PER_HOUR = 30;
const writerTurns = new Map<string, number[]>();

/**
 * At most WRITER_TURNS_PER_HOUR AI requests per admin per rolling hour. Kept in
 * this process like the test-send limit: one API container serves every
 * request, and a restart forgetting the count only ever allows more drafts.
 */
export function takeWriterTurn(adminKey: string, now = Date.now()): boolean {
  const recent = (writerTurns.get(adminKey) ?? []).filter((at) => now - at < 3_600_000);
  if (recent.length >= WRITER_TURNS_PER_HOUR) {
    writerTurns.set(adminKey, recent);
    return false;
  }
  recent.push(now);
  writerTurns.set(adminKey, recent);
  return true;
}

/** Three drafts for a brief, or null when the AI is unavailable or wrote nothing usable. */
export async function writeDrafts(brief: WriterBrief, voice: BusinessVoice): Promise<string[] | null> {
  const reply = await completeText({ system: writerSystemPrompt(brief.kind, voice), prompt: draftRequest(brief), ...CALL });
  if (!reply) return null;
  const drafts = parseDrafts(reply, brief.kind);
  return drafts.length ? drafts : null;
}

/** The editor's message changed as asked, or null when the AI is unavailable or its answer is unusable. */
export async function rewriteDraft(
  kind: WriterKind,
  text: string,
  change: RewriteChange,
  voice: BusinessVoice,
  reason?: string
): Promise<string | null> {
  const reply = await completeText({ system: writerSystemPrompt(kind, voice), prompt: rewriteRequest(kind, text, change, reason), ...CALL });
  if (!reply) return null;
  return parseDrafts(reply, kind)[0] ?? null;
}
