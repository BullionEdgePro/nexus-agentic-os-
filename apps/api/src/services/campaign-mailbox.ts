import { connectionSecret, listConnections, withTenant } from "@nexus/db";
import { sendGmail } from "../lib/gmail.js";
import { sendEmailImap } from "../lib/imap-email.js";
import { gmailToken } from "./email-sync.js";

/**
 * Which mailbox an email campaign leaves from, and sending from it (26 Oct 2026).
 *
 * The owner's choice: a staff member's own mailbox, otherwise the business
 * mailbox — the same shape as a WhatsApp campaign's own number, otherwise the
 * company line. A customer who replies then writes to the address they were
 * written from, and the reply lands back in Nexus through the ordinary sweep.
 */
export interface CampaignMailbox {
  address: string;
  provider: "imap" | "gmail";
  /** Whose connection it is; null is the business mailbox. */
  employeeId: string | null;
}

export const NO_MAILBOX_FOR_STAFF =
  "No mailbox to send from — connect yours in Connections, or ask the owner to connect the business mailbox in Channels.";
export const NO_MAILBOX_FOR_BUSINESS =
  "This business has no mailbox connected to send from. Connect one in Channels.";

/**
 * Staff, in order: their own IMAP mailbox, their own Gmail, the business IMAP
 * mailbox. Admin: the business mailbox only — a business campaign must not leave
 * from one employee's personal address. Only usable connections count: one whose
 * sign-in has broken is no sender, and choosing it would fail every recipient.
 */
export async function resolveCampaignMailbox(
  organizationId: string,
  employeeId: string | null
): Promise<CampaignMailbox | { error: string }> {
  const personal = employeeId
    ? await withTenant(organizationId, () => listConnections(organizationId, employeeId))
    : [];
  const ownImap = personal.find((c) => c.provider === "imap" && c.usable);
  if (ownImap) return { address: ownImap.externalId.toLowerCase(), provider: "imap", employeeId };
  const ownGmail = personal.find((c) => c.provider === "gmail" && c.usable);
  if (ownGmail) return { address: ownGmail.externalId.toLowerCase(), provider: "gmail", employeeId };

  const business = await withTenant(organizationId, () => listConnections(organizationId, null));
  const businessImap = business.find((c) => c.provider === "imap" && c.usable);
  if (businessImap) return { address: businessImap.externalId.toLowerCase(), provider: "imap", employeeId: null };

  return { error: employeeId ? NO_MAILBOX_FOR_STAFF : NO_MAILBOX_FOR_BUSINESS };
}

/** The mailbox stamped on a campaign row, as resolveCampaignMailbox would describe it. */
export async function mailboxFromStamp(
  organizationId: string,
  address: string,
  employeeId: string | null
): Promise<CampaignMailbox | null> {
  const connections = await withTenant(organizationId, () => listConnections(organizationId, employeeId));
  const match = connections.find(
    (c) => (c.provider === "imap" || c.provider === "gmail") && c.externalId.toLowerCase() === address.toLowerCase()
  );
  if (!match) return null;
  return { address: match.externalId.toLowerCase(), provider: match.provider as "imap" | "gmail", employeeId };
}

/** Send one rendered email from this mailbox. Returns the id the transport gives back. */
export async function sendFromMailbox(
  organizationId: string,
  mailbox: CampaignMailbox,
  message: { to: string; subject: string; text: string; html: string; headers: Record<string, string> }
): Promise<string> {
  if (mailbox.provider === "imap") {
    const secret = await withTenant(organizationId, () => connectionSecret(organizationId, mailbox.employeeId, "imap"));
    if (!secret) throw Object.assign(new Error("Invalid Credentials: the mailbox sign-in can no longer be read"), { responseCode: 535 });
    return sendEmailImap(mailbox.address, secret.accessToken, {
      to: message.to,
      subject: message.subject,
      body: message.text,
      html: message.html,
      headers: message.headers,
    });
  }
  const token = await gmailToken({ organizationId, employeeId: mailbox.employeeId });
  // A Gmail sign-in that will not renew is the mailbox failing, not this address.
  if ("error" in token) throw new Error(`GMAIL_RECONNECT ${token.error}`);
  return sendGmail(token.accessToken, {
    to: message.to,
    subject: message.subject,
    body: message.text,
    html: message.html,
    headers: message.headers,
  });
}
