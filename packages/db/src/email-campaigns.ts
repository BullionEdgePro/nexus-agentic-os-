import { getPool, withAllTenants } from "./client.js";
import { contactServedBy } from "./contacts.js";
import { contactOwnedBy } from "./client-book.js";
import type { BroadcastStatus } from "@nexus/shared";

/**
 * Email campaigns (migration 103, 26 Oct 2026).
 *
 * The email half of "bulk messaging separated for email and WhatsApp". Same
 * campaigns table as WhatsApp, its own audience: a WhatsApp campaign reaches
 * people with a number, an email campaign people with an address, and neither
 * ever queues somebody it cannot reach — the 22 Oct campaign queued 57 email
 * customers on WhatsApp and reached nobody.
 */

/** A customer's email address as campaigns read it: trimmed, lower-cased, or null. */
export const EMAIL_ADDRESS_SQL = `lower(nullif(trim(ct.attributes->>'email'), ''))`;

/**
 * Who an email campaign may reach, beyond whose customer they are.
 *
 * Written once and used by both audiences and the count, so the number on screen
 * and the people queued cannot disagree. Somebody who said STOP on WhatsApp is
 * left out here too — stop means stop, whichever channel it was said on.
 */
export function emailReachableSql(): string {
  return `(${EMAIL_ADDRESS_SQL} ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'
           and ct.email_campaigns_opted_out_at is null
           and ct.email_bounced_at is null
           and ct.reengagement_opted_out = false
           and ct.not_a_customer_at is null)`;
}

export interface EmailAudienceMember {
  id: string;
  email: string;
  displayName: string | null;
}

function toMembers(rows: Array<{ id: string; email: string; display_name: string | null }>): EmailAudienceMember[] {
  return rows.map((row) => ({ id: row.id, email: row.email, displayName: row.display_name }));
}

/** A staff member's own clients who can be emailed — their book, nobody else's. */
export async function myClientsForEmailCampaign(
  organizationId: string,
  employeeId: string
): Promise<EmailAudienceMember[]> {
  const { rows } = await getPool().query<{ id: string; email: string; display_name: string | null }>(
    // One row per contact: two contacts sharing an address would each be one
    // person on file, and DISTINCT ON keeps the address from being mailed twice.
    `select distinct on (${EMAIL_ADDRESS_SQL}) ct.id, ${EMAIL_ADDRESS_SQL} as email, ct.display_name
       from contacts ct
      where ${contactServedBy("$1")}
        and ${contactOwnedBy("$2")}
        and ${emailReachableSql()}
      order by ${EMAIL_ADDRESS_SQL}, ct.display_name nulls last`,
    [organizationId, employeeId]
  );
  return toMembers(rows);
}

/** Everyone a business can reach by email — an admin's email campaign. */
export async function businessEmailAudience(organizationId: string): Promise<EmailAudienceMember[]> {
  const { rows } = await getPool().query<{ id: string; email: string; display_name: string | null }>(
    `select distinct on (${EMAIL_ADDRESS_SQL}) ct.id, ${EMAIL_ADDRESS_SQL} as email, ct.display_name
       from contacts ct
      where ${contactServedBy("$1")}
        and ${emailReachableSql()}
      order by ${EMAIL_ADDRESS_SQL}, ct.display_name nulls last`,
    [organizationId]
  );
  return toMembers(rows);
}

export async function createEmailBroadcast(input: {
  organizationId: string;
  employeeId: string | null;
  subject: string;
  body: string;
  fromMailbox: string;
  fromMailboxEmployeeId: string | null;
}): Promise<{ id: string }> {
  const { rows } = await getPool().query<{ id: string }>(
    `insert into broadcasts
       (organization_id, employee_id, channel, template_id, email_subject, email_body,
        from_mailbox, from_mailbox_employee_id, audience_filter, status)
     values ($1, $2, 'email', null, $3, $4, $5, $6, '{}'::jsonb, 'sending')
     returning id`,
    [input.organizationId, input.employeeId, input.subject, input.body, input.fromMailbox, input.fromMailboxEmployeeId]
  );
  return { id: rows[0].id };
}

export async function createEmailRecipients(
  broadcastId: string,
  people: Array<{ contactId: string; toAddress: string; sendAfter: Date | null }>
): Promise<Array<{ id: string; contactId: string; sendAfter: string | null }>> {
  if (people.length === 0) return [];
  const { rows } = await getPool().query<{ id: string; contact_id: string; send_after: string | null }>(
    `insert into broadcast_recipients (broadcast_id, contact_id, to_address, send_after)
     select $1, x.contact_id, x.to_address, x.send_after
       from unnest($2::uuid[], $3::text[], $4::timestamptz[]) as x(contact_id, to_address, send_after)
     on conflict (broadcast_id, contact_id) do nothing
     returning id, contact_id, send_after::text`,
    [
      broadcastId,
      people.map((p) => p.contactId),
      people.map((p) => p.toAddress),
      people.map((p) => (p.sendAfter ? p.sendAfter.toISOString() : null)),
    ]
  );
  return rows.map((row) => ({ id: row.id, contactId: row.contact_id, sendAfter: row.send_after }));
}

/**
 * Emails a mailbox has sent from campaigns in the last 24 hours — what the daily
 * limit is counted against. Cross-tenant and says so: one mailbox (a business
 * address) can carry campaigns for the business and for its staff alike.
 */
export async function emailSentFromMailbox24h(fromMailbox: string): Promise<number> {
  return withAllTenants("email daily limit: a mailbox's sends, whichever campaign they belong to", async () => {
    const { rows } = await getPool().query<{ n: string }>(
      `select count(*)::text as n
         from broadcast_recipients r
         join broadcasts b on b.id = r.broadcast_id
        where b.channel = 'email'
          and lower(b.from_mailbox) = lower($1)
          and r.status in ('sent', 'delivered')
          and r.sent_at > now() - interval '24 hours'`,
      [fromMailbox]
    );
    return Number(rows[0]?.n ?? 0);
  });
}

export interface EmailRecipientForSend {
  recipientId: string;
  broadcastId: string;
  organizationId: string;
  /** Whose campaign: a staff member's, or null for the business's own. */
  employeeId: string | null;
  status: string;
  campaignStatus: BroadcastStatus;
  toAddress: string | null;
  contactId: string;
  displayName: string | null;
  optedOut: boolean;
  bounced: boolean;
  subject: string;
  body: string;
  fromMailbox: string;
  fromMailboxEmployeeId: string | null;
  unsubscribeToken: string;
  businessName: string;
}

/**
 * Everything one email needs, read fresh at the moment of sending. Cross-tenant
 * because the job carries ids only — the campaign was resolved under a tenant
 * scope when it was queued, and this only reads what was frozen then.
 */
export async function emailRecipientForSend(recipientId: string): Promise<EmailRecipientForSend | null> {
  return withAllTenants(`email campaign delivery: recipient ${recipientId}`, async () => {
    const { rows } = await getPool().query<{
      recipient_id: string;
      broadcast_id: string;
      organization_id: string;
      employee_id: string | null;
      status: string;
      campaign_status: BroadcastStatus;
      to_address: string | null;
      contact_id: string;
      display_name: string | null;
      opted_out: boolean;
      bounced: boolean;
      email_subject: string;
      email_body: string;
      from_mailbox: string;
      from_mailbox_employee_id: string | null;
      unsubscribe_token: string;
      business_name: string;
    }>(
      `select r.id as recipient_id, r.broadcast_id, b.organization_id, b.employee_id, r.status, b.status as campaign_status,
              r.to_address, r.contact_id, ct.display_name,
              (ct.email_campaigns_opted_out_at is not null or ct.reengagement_opted_out) as opted_out,
              (ct.email_bounced_at is not null) as bounced,
              b.email_subject, b.email_body, b.from_mailbox, b.from_mailbox_employee_id,
              r.unsubscribe_token::text, o.name as business_name
         from broadcast_recipients r
         join broadcasts b on b.id = r.broadcast_id
         join contacts ct on ct.id = r.contact_id
         join organizations o on o.id = b.organization_id
        where r.id = $1 and b.channel = 'email'`,
      [recipientId]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      recipientId: row.recipient_id,
      broadcastId: row.broadcast_id,
      organizationId: row.organization_id,
      employeeId: row.employee_id,
      status: row.status,
      campaignStatus: row.campaign_status,
      toAddress: row.to_address,
      contactId: row.contact_id,
      displayName: row.display_name,
      optedOut: row.opted_out,
      bounced: row.bounced,
      subject: row.email_subject,
      body: row.email_body,
      fromMailbox: row.from_mailbox,
      fromMailboxEmployeeId: row.from_mailbox_employee_id,
      unsubscribeToken: row.unsubscribe_token,
      businessName: row.business_name,
    };
  });
}

export async function markEmailRecipientSent(recipientId: string, messageId: string): Promise<void> {
  await withAllTenants("email campaign delivery: marking one recipient sent", () =>
    getPool().query(
      `update broadcast_recipients
          set status = 'sent', sent_at = now(), email_message_id = $2, delivery_error = null
        where id = $1 and status = 'pending'`,
      [recipientId, messageId || null]
    )
  );
}

export async function markEmailRecipientFailed(recipientId: string, reason: string): Promise<void> {
  await withAllTenants("email campaign delivery: marking one recipient failed", () =>
    getPool().query(
      `update broadcast_recipients set status = 'failed', delivery_error = $2
        where id = $1 and status in ('pending', 'sent')`,
      [recipientId, reason.slice(0, 500)]
    )
  );
}

/** A customer who replied "unsubscribe" or "stop" by email: no more campaign emails. */
export async function optOutOfEmailCampaigns(contactId: string): Promise<void> {
  // Cross-tenant on purpose: the contact may be owned by the business that runs
  // the number, not the one whose mailbox read the reply, and the contacts
  // policy's WITH CHECK would refuse the write from the reader's scope.
  await withAllTenants("email opt-out: a customer replied unsubscribe", () =>
    getPool().query(
      `update contacts set email_campaigns_opted_out_at = coalesce(email_campaigns_opted_out_at, now())
        where id = $1`,
      [contactId]
    )
  );
}

/**
 * The unsubscribe link. Cross-tenant and says so: the person clicking it is not
 * signed in to anything, and the token is all there is to go on. Returns whether
 * the token named somebody — the page says the same thing either way.
 */
export async function unsubscribeByToken(token: string): Promise<boolean> {
  return withAllTenants("unsubscribe link: the token names one recipient of one campaign", async () => {
    const { rowCount } = await getPool().query(
      `update contacts ct
          set email_campaigns_opted_out_at = coalesce(ct.email_campaigns_opted_out_at, now())
         from broadcast_recipients r
        where r.unsubscribe_token = $1::uuid and ct.id = r.contact_id`,
      [token]
    );
    return (rowCount ?? 0) > 0;
  });
}

/**
 * A bounce, matched to what was sent. The newest campaign email to this address
 * from this mailbox in the last week is marked failed, and the address is
 * skipped from then on. Cross-tenant: the mailbox reading the bounce can carry
 * several businesses' campaigns.
 */
export async function recordEmailBounce(
  fromMailbox: string,
  address: string
): Promise<{ broadcastId: string } | null> {
  return withAllTenants("email bounce: an address, matched to the campaign email that bounced", async () => {
    const { rows } = await getPool().query<{ id: string; broadcast_id: string; contact_id: string }>(
      `select r.id, r.broadcast_id, r.contact_id
         from broadcast_recipients r
         join broadcasts b on b.id = r.broadcast_id
        where b.channel = 'email'
          and lower(b.from_mailbox) = lower($1)
          and lower(r.to_address) = lower($2)
          and r.status in ('sent', 'delivered')
          and r.sent_at > now() - interval '7 days'
        order by r.sent_at desc
        limit 1`,
      [fromMailbox, address]
    );
    const hit = rows[0];
    if (!hit) return null;
    await getPool().query(
      `update broadcast_recipients set status = 'failed',
              delivery_error = 'Bounced: the address does not exist or refused the email'
        where id = $1`,
      [hit.id]
    );
    await getPool().query(
      `update contacts set email_bounced_at = coalesce(email_bounced_at, now()) where id = $1`,
      [hit.contact_id]
    );
    return { broadcastId: hit.broadcast_id };
  });
}

/** Who a paused campaign never reached — what Resume queues again. */
export async function pendingRecipients(broadcastId: string): Promise<
  Array<{ id: string; contactId: string; waId: string | null; displayName: string | null; toAddress: string | null }>
> {
  const { rows } = await getPool().query<{
    id: string;
    contact_id: string;
    wa_id: string | null;
    display_name: string | null;
    to_address: string | null;
  }>(
    `select r.id, r.contact_id, ct.wa_id, ct.display_name, r.to_address
       from broadcast_recipients r
       join contacts ct on ct.id = r.contact_id
      where r.broadcast_id = $1 and r.status = 'pending'`,
    [broadcastId]
  );
  return rows.map((row) => ({
    id: row.id,
    contactId: row.contact_id,
    waId: row.wa_id,
    displayName: row.display_name,
    toAddress: row.to_address,
  }));
}

/** Move a campaign between statuses only from the ones named — never over a finish. */
export async function setBroadcastStatusIf(
  broadcastId: string,
  from: BroadcastStatus[],
  to: BroadcastStatus
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `update broadcasts set status = $3 where id = $1 and status = any($2::text[])`,
    [broadcastId, from, to]
  );
  return (rowCount ?? 0) > 0;
}

/** The campaign row as resume/stop need it: whose it is, which channel, what it sends. */
export async function campaignForControl(broadcastId: string): Promise<{
  id: string;
  organizationId: string;
  employeeId: string | null;
  channel: "whatsapp" | "email";
  status: BroadcastStatus;
  templateId: string | null;
  fromPhoneNumberId: string | null;
  fromMailbox: string | null;
  fromMailboxEmployeeId: string | null;
} | null> {
  const { rows } = await getPool().query<{
    id: string;
    organization_id: string;
    employee_id: string | null;
    channel: "whatsapp" | "email";
    status: BroadcastStatus;
    template_id: string | null;
    from_phone_number_id: string | null;
    from_mailbox: string | null;
    from_mailbox_employee_id: string | null;
  }>(
    `select id, organization_id, employee_id, channel, status, template_id, from_phone_number_id,
            from_mailbox, from_mailbox_employee_id
       from broadcasts where id = $1`,
    [broadcastId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    employeeId: row.employee_id,
    channel: row.channel,
    status: row.status,
    templateId: row.template_id,
    fromPhoneNumberId: row.from_phone_number_id,
    fromMailbox: row.from_mailbox,
    fromMailboxEmployeeId: row.from_mailbox_employee_id,
  };
}
