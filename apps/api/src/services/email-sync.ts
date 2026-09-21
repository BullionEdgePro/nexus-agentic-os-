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
  clientContactsWithEmail,
  connectionExpiry,
  connectionSecret,
  findOrCreateEmailConversation,
  insertSyncedEmailMessage,
  listGmailConnectionsForSync,
  recordSync,
  refreshStoredAccessToken,
  withAllTenants,
  withTenant,
} from "@nexus/db";
import { fetchClientMailFull, fetchGmailProfile, refreshGoogleToken } from "../lib/gmail.js";
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

/** Every email address in a header value ("Ada <a@x.com>, b@y.com"), lowercased. */
const emailsIn = (headerValue: string | null): string[] => {
  if (!headerValue) return [];
  const found = headerValue.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi) ?? [];
  return found.map((e) => e.toLowerCase());
};

/**
 * Pull the mail between a staff member and their clients into email
 * conversations, so it reads in the inbox beside their WhatsApp threads.
 *
 * The privacy boundary is unchanged from the read-only view: fetchClientMailFull
 * queries ONLY addresses in this person's client book, so a mailbox is never
 * listed and nothing outside those threads is touched. What is new is that the
 * body is read (the owner chose this) and stored — for those already-scoped
 * messages only.
 *
 * Direction is decided by the sender: a message from the connected mailbox is
 * outbound, anything else inbound. Dedup on the Gmail message id means running
 * this every inbox open is safe and cheap — a message already stored inserts
 * nothing. The Gmail fetch (slow, network) is kept OUTSIDE the write transaction
 * so a database connection is never held open across it.
 */
export async function runEmailSync(
  owner: MailboxOwner,
  accessToken: string
): Promise<{ newMessages: number; threads: number }> {
  const profile = await fetchGmailProfile(accessToken);
  const ownerAddress = profile.emailAddress.trim().toLowerCase();

  const clients = await withTenant(owner.organizationId, () =>
    clientContactsWithEmail(owner.organizationId, owner.employeeId as string)
  );
  if (clients.length === 0) return { newMessages: 0, threads: 0 };

  const byAddress = new Map(clients.map((client) => [client.email, client.contactId]));
  const messages = await fetchClientMailFull(
    accessToken,
    clients.map((client) => client.email),
    40
  );
  if (messages.length === 0) return { newMessages: 0, threads: 0 };

  return withTenant(owner.organizationId, async () => {
    let newMessages = 0;
    const touched = new Set<string>();
    for (const m of messages) {
      const fromEmail = emailsIn(m.from)[0] ?? "";
      const involved = [...emailsIn(m.from), ...emailsIn(m.to)];
      // The client this message is with: an involved address that is in the book
      // and is not the staff member's own mailbox.
      const clientEmail = involved.find((a) => a !== ownerAddress && byAddress.has(a));
      if (!clientEmail) continue;
      const contactId = byAddress.get(clientEmail)!;
      const conversationId = await findOrCreateEmailConversation(owner.organizationId, contactId);
      touched.add(conversationId);
      const inserted = await insertSyncedEmailMessage({
        organizationId: owner.organizationId,
        conversationId,
        contactId,
        direction: fromEmail === ownerAddress ? "outbound" : "inbound",
        body: (m.body || m.snippet || "").slice(0, 20_000),
        emailMessageId: m.id,
        emailThreadId: m.threadId || null,
        receivedAt: m.receivedAt,
      });
      if (inserted) newMessages += 1;
    }
    return { newMessages, threads: touched.size };
  });
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

  logger.info(result, "Mailboxes synced");
  return result;
}
