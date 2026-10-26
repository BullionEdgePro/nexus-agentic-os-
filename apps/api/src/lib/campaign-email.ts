/**
 * The email half of a campaign, as pure functions (26 Oct 2026).
 *
 * What one person receives, how a list is paced across days, and what a failure
 * means — kept free of I/O so each can be pinned by a test, and so the route,
 * the worker and the test send cannot each render a slightly different email.
 * Spec: docs/superpowers/specs/2026-10-26-email-campaigns-design.md
 */
import { emailsIn } from "./mail-filter.js";

/** The customer's first name for {name}, or "there" — "Hi there" reads as written. */
export function firstName(displayName: string | null | undefined): string {
  const first = (displayName ?? "").trim().split(/\s+/)[0] ?? "";
  return first || "there";
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Escaped text with its web addresses made into links. Nothing else is interpreted. */
function linkify(escaped: string): string {
  return escaped.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (url) => `<a href="${url}">${url}</a>`);
}

export interface RenderedCampaignEmail {
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

/**
 * One person's copy of a campaign email.
 *
 * {name} is filled everywhere it appears; any other braces stay as typed, since
 * a paraphrase of what somebody wrote is not ours to make. The HTML is the text,
 * escaped, in paragraphs — no images and no tracking: a pixel costs inbox
 * placement and tells a business something its customer did not agree to.
 *
 * The unsubscribe is in three places on purpose: the footer people read, the
 * List-Unsubscribe header Gmail turns into a button beside the sender, and the
 * one-click POST form of it (RFC 8058) that Gmail and Yahoo now expect from
 * anyone sending in bulk.
 */
export function renderCampaignEmail(input: {
  subject: string;
  body: string;
  displayName: string | null;
  unsubscribeUrl: string;
  businessName: string;
  fromAddress: string;
}): RenderedCampaignEmail {
  const name = firstName(input.displayName);
  const fill = (s: string) => s.split("{name}").join(name);
  const subject = fill(input.subject).replace(/[\r\n]+/g, " ").trim();
  const body = fill(input.body).replace(/\r\n/g, "\n").trim();

  const text = `${body}\n\n—\nDon't want these emails? Unsubscribe: ${input.unsubscribeUrl}`;

  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${linkify(escapeHtml(p)).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const html =
    `<!doctype html><html><body style="margin:0;padding:24px;font:15px/1.55 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1f2937">` +
    `<div style="max-width:600px">${paragraphs}` +
    `<p style="margin:28px 0 0;padding-top:12px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">` +
    `${escapeHtml(input.businessName)} · Don't want these emails? ` +
    `<a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#6b7280">Unsubscribe</a></p>` +
    `</div></body></html>`;

  return {
    subject,
    text,
    html,
    headers: {
      "List-Unsubscribe": `<${input.unsubscribeUrl}>, <mailto:${input.fromAddress}?subject=unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

/**
 * How many people go out on each day: today first, up to what the mailbox has
 * left of its rolling-24-hour limit, then a full limit per later day.
 *
 * A list over the limit is never refused and never trimmed — the people at the
 * end would be invisible. It finishes on a later day, and the screen says which.
 */
export function splitByDailyCap(count: number, usedToday: number, cap: number): number[] {
  if (count <= 0) return [];
  const days: number[] = [];
  let left = count;
  days.push(Math.min(left, Math.max(0, cap - usedToday)));
  left -= days[0];
  while (left > 0) {
    const take = Math.min(left, Math.max(1, cap));
    days.push(take);
    left -= take;
  }
  return days;
}

export type EmailSendFailure = "transient" | "permanent" | "auth";

const fieldOf = (err: unknown, key: string): unknown =>
  err && typeof err === "object" ? (err as Record<string, unknown>)[key] : undefined;
const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(fieldOf(err, "message") ?? fieldOf(err, "response") ?? err ?? "");

/**
 * What a failed send means for the rest of the list.
 *
 * - auth: the mailbox itself will not sign in. Every remaining email would fail
 *   the same way, so the campaign pauses rather than burning through the list.
 * - transient: a timeout, a full queue, a busy server (SMTP 4xx, Gmail 429/5xx).
 *   Tried again later.
 * - permanent: this one address was refused. Marked failed with a reason.
 */
export function classifyEmailSendError(err: unknown): EmailSendFailure {
  const code = Number(fieldOf(err, "responseCode") ?? NaN);
  const errno = String(fieldOf(err, "code") ?? "");
  const message = messageOf(err);

  if (code === 535 || code === 534 || errno === "EAUTH" || /GMAIL_RECONNECT|invalid_grant|unauthorized_client|Invalid Credentials|authentication failed|Username and Password not accepted/i.test(message)) {
    return "auth";
  }
  if (code >= 400 && code < 500) return "transient";
  if (/^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ESOCKET|ECONNECTION|EDNS|EAI_AGAIN|ENOTFOUND)$/.test(errno)) return "transient";
  if (/HTTP (429|5\d\d)|rate limit|timed? ?out|temporarily|try again/i.test(message)) return "transient";
  return "permanent";
}

/** A failure in a sentence the sender can act on. */
export function explainEmailSendError(err: unknown): string {
  const kind = classifyEmailSendError(err);
  if (kind === "auth") return "The mailbox sign-in stopped working — reconnect it, then Resume.";
  if (kind === "transient") return "The mail server was busy and did not take this email in time.";
  const message = messageOf(err);
  if (/5\.1\.1|user unknown|no such user|does not exist|address rejected|recipient.*(invalid|rejected)|mailbox unavailable/i.test(message)) {
    return "The address does not exist or refused the email.";
  }
  if (/spam|blocked|policy|reputation/i.test(message)) {
    return "The receiving server refused it as possible spam.";
  }
  return message.trim().slice(0, 200) || "The email could not be sent.";
}

const BOUNCE_SENDER = /mailer-daemon|postmaster|mail delivery (subsystem|system)/i;
const BOUNCE_SUBJECT = /undeliver|delivery status notification|delivery has failed|delivery failure|returned mail|failure notice|mail delivery failed/i;

/**
 * The addresses a bounce says could not be reached — or none, for anything that
 * is not a bounce. The sender's own addresses (the daemon) are left out; the
 * caller matches what remains against what was actually sent, so an address
 * merely quoted in the bounce text changes nothing.
 */
export function bounceAddresses(mail: { from: string | null; subject: string | null; body: string }): string[] {
  const from = mail.from ?? "";
  if (!BOUNCE_SENDER.test(from) && !BOUNCE_SUBJECT.test(mail.subject ?? "")) return [];
  const own = new Set(emailsIn(from).map((a) => a.toLowerCase()));
  return [...new Set(emailsIn(mail.body).map((a) => a.toLowerCase()))].filter(
    (address) => !own.has(address) && !BOUNCE_SENDER.test(address)
  );
}
