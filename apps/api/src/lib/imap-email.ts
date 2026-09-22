/**
 * A business mailbox over IMAP/SMTP — the non-Google half of the email channel.
 *
 * ============================================================
 * WHY THIS EXISTS BESIDE gmail.ts
 * ============================================================
 *
 * Gmail connects with OAuth: a token, scoped, revocable, and the whole
 * privacy design of `gmail.ts` leans on it. A Hostinger (or any cPanel/Dovecot)
 * business mailbox has no OAuth — it is reached with the address and the
 * account password over IMAP (to read) and SMTP (to send). So this is a second
 * transport for the SAME channel: the DB layer, the dedup, the conversation and
 * the reply flow are shared; only the fetch and the send differ.
 *
 * THE SAME PRIVACY BOUNDARY STILL HOLDS. It never lists the mailbox. It searches
 * INBOX only for mail involving an address already in the staff member's client
 * book, exactly as the Gmail side does — an empty book fetches nothing.
 *
 * The password is more sensitive than a token (it is not scoped and cannot be
 * revoked per-app), which is why it is sealed at rest like every other
 * credential and why a dedicated app-password is the right thing to connect.
 *
 * Hosts default to Hostinger and are overridable by env for another provider.
 */
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";

/** imapflow types internalDate loosely (string | Date); mailparser gives a Date. */
function toIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const imapHost = () => process.env.IMAP_HOST || "imap.hostinger.com";
const imapPort = () => Number(process.env.IMAP_PORT || 993);
const smtpHost = () => process.env.SMTP_HOST || "smtp.hostinger.com";
const smtpPort = () => Number(process.env.SMTP_PORT || 465);

/** IMAP is always available — the host defaults to Hostinger, no server setup. */
export function imapConfigured(): boolean {
  return true;
}

function imapClient(email: string, password: string): ImapFlow {
  return new ImapFlow({
    host: imapHost(),
    port: imapPort(),
    secure: true,
    auth: { user: email, pass: password },
    logger: false,
    // A mailbox that will not answer must not hang the sweep on it.
    socketTimeout: 20_000,
  });
}

/**
 * Prove the address and password log in, so the connect screen can refuse a bad
 * one at the door rather than storing a credential that silently never syncs.
 * Connect then log out; touches no mail.
 */
export async function verifyImapLogin(email: string, password: string): Promise<void> {
  const client = imapClient(email, password);
  try {
    await client.connect();
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** One message, in the shape the shared inbox-insert loop already speaks. */
export interface ImapMailMessage {
  /** The RFC-822 Message-ID — stable, unique, and the dedup key AND the thread anchor. */
  id: string;
  from: string | null;
  to: string | null;
  subject: string | null;
  body: string;
  receivedAt: string | null;
}

/**
 * The mail in INBOX involving this person's clients — and only that.
 *
 * INBOX only: it holds what customers SENT, which is the inbound the channel
 * exists to surface. The staff member's own replies are recorded when they are
 * sent, so there is no need to trawl the Sent folder and risk double-storing
 * them. Bounded to the newest `limit` across all client addresses so a big
 * mailbox cannot make one sweep expensive.
 */
export async function fetchClientMailImap(
  email: string,
  password: string,
  addresses: string[],
  limit = 40
): Promise<ImapMailMessage[]> {
  const clean = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  if (clean.length === 0) return [];

  const client = imapClient(email, password);
  const out: ImapMailMessage[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uidSet = new Set<number>();
      for (const addr of clean) {
        // Mail this address is on either end of — a reply the staff member sent
        // that is still in INBOX (rare) counts too, and dedup handles the rest.
        const uids = (await client
          .search({ or: [{ from: addr }, { to: addr }] }, { uid: true })
          .catch(() => [])) as number[];
        for (const u of uids) uidSet.add(u);
      }
      const uids = [...uidSet].sort((a, b) => b - a).slice(0, limit);
      if (uids.length) {
        for await (const msg of client.fetch(
          uids,
          { uid: true, source: true, internalDate: true },
          { uid: true }
        )) {
          if (!msg.source) continue;
          const parsed = await simpleParser(msg.source as Buffer);
          const toText = Array.isArray(parsed.to)
            ? parsed.to.map((t) => t.text).join(", ")
            : parsed.to?.text ?? null;
          out.push({
            id: parsed.messageId || `imap-${msg.uid}@${imapHost()}`,
            from: parsed.from?.text ?? null,
            to: toText,
            subject: parsed.subject ?? null,
            body: (parsed.text || "").slice(0, 20_000),
            receivedAt: toIso(parsed.date ?? msg.internalDate),
          });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  return out;
}

/**
 * Send a reply from this mailbox over SMTP, as the staff member.
 *
 * In-Reply-To / References carry the message being answered so it threads in the
 * recipient's client. Returns the sent Message-ID, which is stored on the
 * outbound row so the next IMAP sweep recognises this very message rather than
 * appending a second copy.
 */
export async function sendEmailImap(
  email: string,
  password: string,
  input: { to: string; subject: string; body: string; inReplyTo?: string | null }
): Promise<string> {
  const transporter = nodemailer.createTransport({
    host: smtpHost(),
    port: smtpPort(),
    secure: smtpPort() === 465,
    auth: { user: email, pass: password },
  });
  const info = await transporter.sendMail({
    from: email,
    to: input.to,
    subject: input.subject,
    text: input.body,
    inReplyTo: input.inReplyTo || undefined,
    references: input.inReplyTo || undefined,
  });
  return info.messageId || "";
}
