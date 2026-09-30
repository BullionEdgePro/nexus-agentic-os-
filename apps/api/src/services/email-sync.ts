/**
 * Pulling connected mailboxes into the inbox — on demand and on a schedule.
 *
 * ============================================================
 * ONE DEFINITION, TWO CALLERS
 * ============================================================
 *
 * `gmailToken` and `runEmailSync` began life inside the connections route,
 * where the manual "sync my mailbox now" button calls them. The background
 * sweep needs exactly the same two steps — resolve a usable token, then read a
 * person's client mail into email conversations — so they live here and the
 * route imports them. A second copy would be a second thing to keep right, and
 * the privacy boundary these enforce is not one to maintain twice.
 *
 * ============================================================
 * WHAT THE SWEEP MUST NOT DO
 * ============================================================
 *
 * One person's expired token, revoked consent, or Gmail hiccup must not stop
 * the rest from syncing. Each mailbox is its own try; a failure is recorded on
 * that connection's row — where the staff member who owns it reads it — and the
 * loop moves on. The read is idempotent (dedup on the Gmail message id), so a
 * cycle that overlaps a manual sync, or the next cycle, stores nothing twice.
 */
import {
  connectionExpiry,
  connectionSecret,
  emailReplyContext,
  findOrCreateEmailConversation,
  findOrCreateEmailContact,
  insertSyncedEmailMessage,
  listConnections,
  listGmailConnectionsForSync,
  listImapConnectionsForSync,
  recordSync,
  refreshStoredAccessToken,
  withAllTenants,
  withTenant,
} from "@nexus/db";
import {
  fetchRecentInboxMailFull,
  fetchGmailProfile,
  fetchMessageThreadingHeaders,
  refreshGoogleToken,
  sendGmail,
} from "../lib/gmail.js";
import { fetchRecentMailImap, sendEmailImap } from "../lib/imap-email.js";
import { emailsIn, isAutomatedMail, senderName } from "../lib/mail-filter.js";
import { logger } from "../lib/logger.js";

/** Whose mailbox — an (org, employee) pair. Gmail is always a person's here. */
export interface MailboxOwner {
  organizationId: string;
  employeeId: string | null;
}

/**
 * A usable Gmail access token, refreshed if it has expired.
 *
 * Google's access tokens last an hour, so refreshing is the ordinary path
 * rather than the exception, and it happens HERE — once, in front of every
 * Gmail call — instead of being remembered at each call site.
 *
 * The refresh writes back only the access token. A Google refresh response does
 * not include a new refresh token, and round-tripping through `saveConnection`
 * would write null over the working one, leaving a connection that dies an hour
 * later with nothing to renew it.
 */
export async function gmailToken(
  owner: MailboxOwner
): Promise<{ accessToken: string; scopes: string[] } | { error: string; status: 404 | 401 }> {
  const stored = await withTenant(owner.organizationId, () =>
    connectionSecret(owner.organizationId, owner.employeeId, "gmail")
  );
  if (!stored) {
    return {
      error: "Gmail is not connected, or the stored sign-in can no longer be read. Connect it again.",
      status: 404,
    };
  }

  const fresh = await withTenant(owner.organizationId, () =>
    connectionExpiry(owner.organizationId, owner.employeeId, "gmail")
  );
  // A minute of slack: a token that expires while the request is in flight
  // fails in a way that looks like a revoked connection.
  const stillGood = fresh && fresh.getTime() - Date.now() > 60_000;
  if (stillGood) return { accessToken: stored.accessToken, scopes: stored.scopes };

  if (!stored.refreshToken) {
    return {
      error:
        "This Gmail sign-in has expired and carries nothing to renew it — that happens when consent was given without offline access. Connect it again.",
      status: 401,
    };
  }

  try {
    const renewed = await refreshGoogleToken(stored.refreshToken);
    await withTenant(owner.organizationId, () =>
      refreshStoredAccessToken(
        owner.organizationId,
        owner.employeeId,
        "gmail",
        renewed.accessToken,
        renewed.expiresAt
      )
    );
    return { accessToken: renewed.accessToken, scopes: stored.scopes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withTenant(owner.organizationId, () =>
      recordSync(owner.organizationId, owner.employeeId, "gmail", message.slice(0, 200))
    );
    return {
      error: message.startsWith("GMAIL_RECONNECT")
        ? "Google has signed this connection out — access was revoked or the password changed. Connect it again."
        : "Could not renew the Gmail sign-in just now. Try again shortly.",
      status: 401,
    };
  }
}

/** One fetched message, in the shape the insert loop below needs — the common
 *  ground between a Gmail message and an IMAP one, which differ only in transport. */
interface FetchedMail {
  id: string;
  from: string | null;
  body: string;
  snippet?: string | null;
  threadId?: string | null;
  receivedAt: string | null;
  /** True when no person wrote it: lists, bulk, no-reply, auto-replies. */
  automated: boolean;
}

/**
 * File a mailbox's recent mail into the inbox — the shared half of both
 * transports, so the rules and the dedup live in ONE place.
 *
 * EVERY EMAIL FROM A PERSON (the owner's decision, 2026-09-30). The sender
 * becomes a customer if they aren't one already, and gets one email
 * conversation, like a WhatsApp chat. Skipped: automated mail (see
 * lib/mail-filter.ts), and anything from the mailbox's own address. Dedup is on
 * the message id, so a re-sync, or the same mail seen twice, stores nothing new.
 *
 * A new conversation from a staff member's mailbox is assigned to them; from a
 * business mailbox it lands in Unassigned, where auto-assign (if the business
 * turned it on) or a person hands it out.
 */
async function storeInboxMail(
  owner: MailboxOwner,
  ownerAddress: string,
  messages: FetchedMail[]
): Promise<{ newMessages: number; threads: number; skippedAutomated: number }> {
  if (messages.length === 0) return { newMessages: 0, threads: 0, skippedAutomated: 0 };

  return withTenant(owner.organizationId, async () => {
    let newMessages = 0;
    let skippedAutomated = 0;
    const touched = new Set<string>();
    for (const m of messages) {
      const fromEmail = emailsIn(m.from)[0] ?? "";
      if (!fromEmail || fromEmail === ownerAddress) continue;
      if (m.automated) {
        skippedAutomated += 1;
        continue;
      }
      const contactId = await findOrCreateEmailContact(
        owner.organizationId,
        fromEmail,
        senderName(m.from),
        owner.employeeId
      );
      const conversationId = await findOrCreateEmailConversation(owner.organizationId, contactId, owner.employeeId);
      touched.add(conversationId);
      const inserted = await insertSyncedEmailMessage({
        organizationId: owner.organizationId,
        conversationId,
        contactId,
        direction: "inbound",
        body: (m.body || m.snippet || "").slice(0, 20_000),
        emailMessageId: m.id,
        emailThreadId: m.threadId || null,
        receivedAt: m.receivedAt,
      });
      if (inserted) newMessages += 1;
    }
    return { newMessages, threads: touched.size, skippedAutomated };
  });
}

/** A Gmail mailbox connected with Google sign-in: its recent Primary inbox. */
export async function runEmailSync(
  owner: MailboxOwner,
  accessToken: string
): Promise<{ newMessages: number; threads: number; skippedAutomated: number }> {
  const profile = await fetchGmailProfile(accessToken);
  const ownerAddress = profile.emailAddress.trim().toLowerCase();
  const messages = await fetchRecentInboxMailFull(accessToken, 40);
  return storeInboxMail(
    owner,
    ownerAddress,
    messages.map((m) => ({
      id: m.id,
      from: m.from,
      body: m.body,
      snippet: m.snippet,
      threadId: m.threadId,
      receivedAt: m.receivedAt,
      automated: isAutomatedMail({
        from: emailsIn(m.from)[0] ?? "",
        headers: {
          "list-unsubscribe": m.listUnsubscribe ?? undefined,
          precedence: m.precedence ?? undefined,
          "auto-submitted": m.autoSubmitted ?? undefined,
        },
      }),
    }))
  );
}

/**
 * The IMAP twin of runEmailSync: a business mailbox (Hostinger, or Gmail with
 * an app password) read over IMAP. The owner's address is the mailbox address.
 */
export async function runImapEmailSync(
  owner: MailboxOwner,
  credential: { email: string; password: string }
): Promise<{ newMessages: number; threads: number; skippedAutomated: number }> {
  const ownerAddress = credential.email.trim().toLowerCase();
  const messages = await fetchRecentMailImap(credential.email, credential.password, { sinceDays: 3, limit: 40 });
  return storeInboxMail(owner, ownerAddress, messages);
}

export interface EmailSyncResult {
  /** Mailboxes read without error. */
  synced: number;
  /** Mailboxes that could not be read — their last state still stands. */
  failed: number;
  /** New messages stored across all mailboxes this cycle. */
  newMessages: number;
}

/**
 * Read every connected staff mailbox, on a schedule.
 *
 * ============================================================
 * WHY A SWEEP AND NOT INBOX-OPEN ALONE
 * ============================================================
 *
 * The manual path only ever runs when a person opens their own inbox, for their
 * own mailbox. That leaves a customer's email sitting unseen until the one staff
 * member it concerns happens to look — which is exactly the unreliability the
 * whole "email as a real channel" ask was about. The sweep makes inbound mail
 * arrive on its own, for everyone, the way WhatsApp already does.
 *
 * withAllTenants, and the reason is the whole point: it reads every business's
 * staff connections in one pass. Left unwrapped it would return zero rows under
 * RLS and report a clean sync of nothing forever — the calendar sync learned
 * that the expensive way, so the reason is stated where the assert can see it.
 *
 * Each mailbox is its own try. A token that will not refresh, a revoked consent,
 * a Gmail blip: the reason is recorded on that connection's row where its owner
 * reads it, and the loop moves on. One person's broken sign-in never stops the
 * rest.
 */
export async function syncAllMailboxes(): Promise<EmailSyncResult> {
  const owners = await withAllTenants(
    "email sync reads every connected staff mailbox in one pass",
    () => listGmailConnectionsForSync()
  );

  const result: EmailSyncResult = { synced: 0, failed: 0, newMessages: 0 };

  for (const owner of owners) {
    try {
      const token = await gmailToken(owner);
      if ("error" in token) {
        // gmailToken already recorded a refresh failure where the owner reads
        // it; the config states (never connected, no offline access) are not
        // sync errors and are left off the row rather than rewritten every
        // cycle into noise.
        result.failed++;
        continue;
      }

      const { newMessages } = await runEmailSync(owner, token.accessToken);
      await withTenant(owner.organizationId, () =>
        recordSync(owner.organizationId, owner.employeeId, "gmail", null)
      );
      result.synced++;
      result.newMessages += newMessages;
    } catch (err) {
      result.failed++;
      const message = err instanceof Error ? err.message.slice(0, 200) : String(err);
      await withTenant(owner.organizationId, () =>
        recordSync(owner.organizationId, owner.employeeId, "gmail", message)
      ).catch(() => undefined);
      logger.warn(
        { organizationId: owner.organizationId, employeeId: owner.employeeId, message },
        "A mailbox could not be synced — its last state still stands"
      );
    }
  }

  // The IMAP mailboxes, in the same pass and with the same per-mailbox isolation.
  // A Hostinger blip or a changed password fails only its own row.
  const imapOwners = await withAllTenants(
    "email sync reads every connected business (IMAP) mailbox in one pass",
    () => listImapConnectionsForSync()
  );
  for (const owner of imapOwners) {
    try {
      const secret = await withTenant(owner.organizationId, () =>
        connectionSecret(owner.organizationId, owner.employeeId, "imap")
      );
      if (!secret) {
        result.failed++;
        continue;
      }
      const { newMessages } = await runImapEmailSync(
        { organizationId: owner.organizationId, employeeId: owner.employeeId },
        { email: owner.email, password: secret.accessToken }
      );
      await withTenant(owner.organizationId, () =>
        recordSync(owner.organizationId, owner.employeeId, "imap", null)
      );
      result.synced++;
      result.newMessages += newMessages;
    } catch (err) {
      result.failed++;
      const message = err instanceof Error ? err.message.slice(0, 200) : String(err);
      await withTenant(owner.organizationId, () =>
        recordSync(owner.organizationId, owner.employeeId, "imap", message)
      ).catch(() => undefined);
      logger.warn(
        { organizationId: owner.organizationId, employeeId: owner.employeeId, message },
        "A business mailbox could not be synced — its last state still stands"
      );
    }
  }

  logger.info(result, "Mailboxes synced");
  return result;
}

/** Add "Re: " unless the subject already carries one (any case, once). */
function replySubject(subject: string | null): string {
  const base = (subject ?? "").trim();
  if (!base) return "Re: (no subject)";
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

export interface SentEmailReply {
  /** The Gmail id of the message just sent — stored so the next sync dedups it. */
  gmailMessageId: string;
  /** The thread it went out on, for the stored row. */
  threadId: string | null;
}

/**
 * Reply to an email conversation, as the staff member who owns the client.
 *
 * The other half of "email is a real channel": inbound arrives on its own (the
 * sweep), and this sends the answer back from the inbox, on the same thread, so
 * the customer sees a reply rather than a new mail out of nowhere.
 *
 * It leaves from the OWNER's mailbox — a reply to a client is from the person
 * whose client they are, sent as themselves — resolved through the same
 * `gmailToken` the sweep uses. The reply threads three ways: Gmail's threadId
 * groups it in the sender's mailbox, and In-Reply-To/References onto the last
 * message's Message-ID thread it in the recipient's client, under a matching
 * "Re: …" subject.
 *
 * Refuses honestly rather than sending wrong: no address on file, a contact
 * owned by nobody, or a mailbox that will not authorise each throw a message the
 * inbox can show. A missing thread (an email conversation with nothing synced
 * yet) is not a refusal — it sends a fresh thread.
 *
 * The Gmail id it returns is stored on the outbound row as email_message_id, so
 * when the sweep later sees this very message in the mailbox its dedup skips it
 * rather than appending a second copy.
 */
export async function sendEmailReply(conversationId: string, text: string): Promise<SentEmailReply> {
  const ctx = await emailReplyContext(conversationId);
  if (!ctx) {
    throw new Error("This conversation could not be found to reply to.");
  }
  if (!ctx.toEmail) {
    throw new Error(
      "This client has no email address on file, so there is nowhere to send the reply. Add one to their client record first."
    );
  }
  // A customer who emailed a BUSINESS mailbox belongs to no one staff member:
  // the reply leaves from that business mailbox (connected with employee null).
  const owner = { organizationId: ctx.organizationId, employeeId: ctx.ownerEmployeeId };

  // A business (IMAP) mailbox wins if this staff member has one connected: the
  // reply leaves from it over SMTP. For IMAP-synced mail the stored message id IS
  // the RFC-822 Message-ID, so In-Reply-To threads it directly with no header
  // fetch. The subject is not stored, so a plain "Re:" carries it — the
  // In-Reply-To is what actually threads it in the recipient's client.
  const personal = owner.employeeId
    ? await withTenant(owner.organizationId, () => listConnections(owner.organizationId, owner.employeeId))
    : [];
  const business = await withTenant(owner.organizationId, () => listConnections(owner.organizationId, null));
  const personalImap = personal.find((conn) => conn.provider === "imap" && conn.usable);
  const businessImap = business.find((conn) => conn.provider === "imap" && conn.usable);
  const imapConn = personalImap ?? businessImap;
  const imapOwnerId = personalImap ? owner.employeeId : null;
  if (!imapConn && !owner.employeeId) {
    throw new Error(
      "There is no business mailbox connected for this business to reply from. Connect one in Channels."
    );
  }
  if (imapConn) {
    const secret = await withTenant(owner.organizationId, () =>
      connectionSecret(owner.organizationId, imapOwnerId, "imap")
    );
    if (!secret) {
      throw new Error("The business mailbox sign-in can no longer be read — connect it again.");
    }
    const messageId = await sendEmailImap(imapConn.externalId, secret.accessToken, {
      to: ctx.toEmail,
      subject: "Re: your message",
      body: text,
      inReplyTo: ctx.replyToGmailMessageId,
    });
    logger.info(
      { conversationId, employeeId: ctx.ownerEmployeeId, mailbox: imapConn.externalId, messageId },
      "Email reply sent from the business mailbox"
    );
    return { gmailMessageId: messageId, threadId: ctx.threadId };
  }

  const token = await gmailToken(owner);
  if ("error" in token) throw new Error(token.error);

  // Threading headers come from the message being replied to, fetched on demand
  // because the sync does not store them. Best-effort: if it cannot be read, the
  // reply still sends, threaded by Gmail's threadId alone.
  let inReplyTo: string | null = null;
  let subjectSource: string | null = null;
  if (ctx.replyToGmailMessageId) {
    const headers = await fetchMessageThreadingHeaders(token.accessToken, ctx.replyToGmailMessageId);
    inReplyTo = headers.messageId;
    subjectSource = headers.subject;
  }

  const gmailMessageId = await sendGmail(token.accessToken, {
    to: ctx.toEmail,
    subject: replySubject(subjectSource),
    body: text,
    threadId: ctx.threadId,
    inReplyTo,
  });

  logger.info(
    { conversationId, employeeId: ctx.ownerEmployeeId, gmailMessageId },
    "Email reply sent from the inbox"
  );
  return { gmailMessageId, threadId: ctx.threadId };
}
