/**
 * IS THIS EMAIL FROM A PERSON?
 *
 * Since 2026-09-30 every email that reaches a connected business mailbox goes
 * into the inbox — not only mail from customers already on file, which is why
 * nothing had ever arrived (no customer had an email address saved). Letting
 * everything in means keeping out what no person wrote: newsletters, receipts,
 * "no-reply" notifications, bounces, auto-replies. Those would bury the one
 * enquiry that matters, and a reply to them goes nowhere.
 *
 * Standard signals first — mailing-list and bulk headers that legitimate
 * senders set on purpose (RFC 2369 List-*, RFC 3834 Auto-Submitted,
 * Precedence) — then the sender's address, for the machine mail that sets none.
 * A false "automated" hides a message; a false "person" shows one extra. So the
 * address rules are narrow: the local part has to BE a role like noreply, not
 * merely contain it.
 */
export interface MailSignals {
  /** The sender's address, lowercased. */
  from: string;
  /** Header name (any case) → value. Only the handful below are read. */
  headers?: Record<string, string | undefined>;
}

const AUTOMATED_LOCAL_PART =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|mailer[-_.]?daemon|postmaster|bounces?|notifications?|notify|alerts?|newsletters?|auto[-_.]?confirm)([-_.+].*)?$/i;

export function isAutomatedMail({ from, headers = {} }: MailSignals): boolean {
  const h = (name: string): string =>
    (Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1] ?? "").toString().trim().toLowerCase();

  // A mailing list or a bulk send says so.
  if (h("list-unsubscribe") || h("list-id")) return true;
  const precedence = h("precedence");
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") return true;
  // Auto-replies and machine-generated mail (RFC 3834): anything but "no".
  const autoSubmitted = h("auto-submitted");
  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (h("x-autoreply") || h("x-autorespond")) return true;

  const address = from.trim().toLowerCase();
  if (!address.includes("@")) return true; // no real sender to answer
  const local = address.split("@")[0];
  return AUTOMATED_LOCAL_PART.test(local);
}

/** Every email address in a header value ("Ada <a@x.com>, b@y.com"), lowercased. */
export function emailsIn(headerValue: string | null | undefined): string[] {
  if (!headerValue) return [];
  const found = headerValue.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi) ?? [];
  return found.map((e) => e.toLowerCase());
}

/** The display name in a From header ("Ada Lovelace <a@x.com>" → "Ada Lovelace"). */
export function senderName(headerValue: string | null | undefined): string | null {
  if (!headerValue) return null;
  const m = headerValue.match(/^\s*"?([^"<]+?)"?\s*</);
  const name = m?.[1]?.trim();
  return name && !name.includes("@") ? name : null;
}

/**
 * The part of an email the sender actually wrote this time (24 Oct 2026).
 *
 * A reply carries the whole conversation under it — "On Sat … wrote:" and
 * ">"-quoted lines, or Outlook's "-----Original Message-----". Scoring that
 * would judge the customer by our own earlier replies. Stops at the first such
 * marker, drops quoted lines, and keeps at most 2,000 characters.
 */
export function freshPartOfEmail(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const withNext = `${line} ${(lines[i + 1] ?? "").trim()}`;
    if (/^On .{3,200}wrote:$/.test(line) || /^On .{3,200}wrote:$/.test(withNext)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(line) || /^_{8,}$/.test(line)) break;
    if (line.startsWith(">")) continue;
    kept.push(lines[i]!);
  }
  return kept.join("\n").trim().slice(0, 2000);
}
