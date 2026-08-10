import { getPool } from "./client.js";
import type { AudienceFilter, BroadcastStatus, CreateBroadcastInput } from "@nexus/shared";

export interface BroadcastRow {
  id: string;
  organizationId: string;
  templateId: string;
  status: BroadcastStatus;
  audienceFilter: AudienceFilter;
  scheduledAt: string | null;
  createdAt: string;
}

export async function createBroadcast(input: CreateBroadcastInput): Promise<BroadcastRow> {
  const { rows } = await getPool().query<{
    id: string;
    organization_id: string;
    template_id: string;
    status: BroadcastStatus;
    audience_filter: AudienceFilter;
    scheduled_at: string | null;
    created_at: string;
  }>(
    `insert into broadcasts (organization_id, template_id, audience_filter, scheduled_at, status)
     values ($1, $2, $3, $4, case when $4 is null then 'draft' else 'scheduled' end)
     returning id, organization_id, template_id, status, audience_filter, scheduled_at, created_at`,
    [input.organizationId, input.templateId, JSON.stringify(input.audienceFilter ?? {}), input.scheduledAt ?? null]
  );
  const row = rows[0];
  return {
    id: row.id,
    organizationId: row.organization_id,
    templateId: row.template_id,
    status: row.status,
    audienceFilter: row.audience_filter,
    scheduledAt: row.scheduled_at,
    createdAt: row.created_at,
  };
}

export interface BroadcastTemplateInfo {
  metaTemplateName: string;
  language: string;
  isApproved: boolean;
}

export async function getBroadcastTemplate(templateId: string): Promise<BroadcastTemplateInfo | null> {
  const { rows } = await getPool().query<{
    meta_template_name: string;
    language: string;
    is_approved: boolean;
  }>(
    `select meta_template_name, language, is_approved from message_templates where id = $1`,
    [templateId]
  );
  const row = rows[0];
  if (!row) return null;
  return { metaTemplateName: row.meta_template_name, language: row.language, isApproved: row.is_approved };
}

/**
 * Resolves the audience for a broadcast. audience_filter is matched against
 * contacts.attributes via jsonb containment (@>) — pass {} to target every
 * contact in the organization.
 */
export async function getContactsForAudience(
  organizationId: string,
  audienceFilter: AudienceFilter
): Promise<Array<{ id: string; waId: string }>> {
  const { rows } = await getPool().query<{ id: string; wa_id: string }>(
    `select id, wa_id from contacts
     where organization_id = $1 and attributes @> $2::jsonb`,
    [organizationId, JSON.stringify(audienceFilter ?? {})]
  );
  return rows.map((row) => ({ id: row.id, waId: row.wa_id }));
}

export async function createBroadcastRecipients(
  broadcastId: string,
  contactIds: string[]
): Promise<Array<{ id: string; contactId: string }>> {
  if (contactIds.length === 0) return [];
  const { rows } = await getPool().query<{ id: string; contact_id: string }>(
    `insert into broadcast_recipients (broadcast_id, contact_id)
     select $1, unnest($2::uuid[])
     on conflict (broadcast_id, contact_id) do nothing
     returning id, contact_id`,
    [broadcastId, contactIds]
  );
  return rows.map((row) => ({ id: row.id, contactId: row.contact_id }));
}

export async function updateBroadcastStatus(broadcastId: string, status: BroadcastStatus): Promise<void> {
  await getPool().query(`update broadcasts set status = $2 where id = $1`, [broadcastId, status]);
}

export async function updateBroadcastRecipientStatus(
  recipientId: string,
  status: "sent" | "failed",
): Promise<void> {
  await getPool().query(
    `update broadcast_recipients
     set status = $2, sent_at = case when $2 = 'sent' then now() else sent_at end
     where id = $1`,
    [recipientId, status]
  );
}

/**
 * True once every recipient has moved off 'pending' — used by the broadcast
 * worker to decide when to flip the parent broadcast to a terminal status.
 */
export async function isBroadcastFullyProcessed(broadcastId: string): Promise<boolean> {
  const { rows } = await getPool().query<{ pending_count: string }>(
    `select count(*)::text as pending_count from broadcast_recipients
     where broadcast_id = $1 and status = 'pending'`,
    [broadcastId]
  );
  return Number(rows[0]?.pending_count ?? 0) === 0;
}

export interface TemplateRow {
  id: string;
  metaTemplateName: string;
  language: string;
  category: string | null;
  isApproved: boolean;
  createdAt: string;
}

/**
 * Templates registered for a business.
 *
 * Registering one here does not create it at Meta and does not approve it —
 * `is_approved` mirrors a decision made in WhatsApp Manager. The send path
 * refuses anything not approved, so this list is "what we know about", not
 * "what we may send".
 */
export async function listBroadcastTemplates(organizationId: string): Promise<TemplateRow[]> {
  const { rows } = await getPool().query<{
    id: string;
    meta_template_name: string;
    language: string;
    category: string | null;
    is_approved: boolean;
    created_at: string;
  }>(
    `select id, meta_template_name, language, category, is_approved, created_at
       from message_templates
      where organization_id = $1
      order by is_approved desc, meta_template_name asc`,
    [organizationId]
  );
  return rows.map((row) => ({
    id: row.id,
    metaTemplateName: row.meta_template_name,
    language: row.language,
    category: row.category,
    isApproved: row.is_approved,
    createdAt: row.created_at,
  }));
}

export interface BroadcastSummary extends BroadcastRow {
  templateName: string;
  recipients: number;
  sent: number;
  failed: number;
}

export async function listBroadcasts(organizationId: string): Promise<BroadcastSummary[]> {
  const { rows } = await getPool().query<{
    id: string;
    organization_id: string;
    template_id: string;
    status: BroadcastStatus;
    audience_filter: AudienceFilter;
    scheduled_at: string | null;
    created_at: string;
    template_name: string;
    recipients: string;
    sent: string;
    failed: string;
  }>(
    `select b.id, b.organization_id, b.template_id, b.status, b.audience_filter,
            b.scheduled_at, b.created_at,
            t.meta_template_name                              as template_name,
            count(r.id)::text                                 as recipients,
            count(r.id) filter (where r.status in ('sent', 'delivered'))::text as sent,
            count(r.id) filter (where r.status = 'failed')::text as failed
       from broadcasts b
       join message_templates t on t.id = b.template_id
       left join broadcast_recipients r on r.broadcast_id = b.id
      where b.organization_id = $1
      group by b.id, t.meta_template_name
      order by b.created_at desc
      limit 50`,
    [organizationId]
  );
  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    templateId: row.template_id,
    status: row.status,
    audienceFilter: row.audience_filter,
    scheduledAt: row.scheduled_at,
    createdAt: row.created_at,
    templateName: row.template_name,
    recipients: Number(row.recipients),
    sent: Number(row.sent),
    failed: Number(row.failed),
  }));
}

/** How many contacts a send would actually reach, before committing to it. */
export async function countReachableContacts(organizationId: string): Promise<number> {
  const { rows } = await getPool().query<{ total: string }>(
    `select count(*)::text as total
       from contacts
      where organization_id = $1 and whatsapp_number is not null`,
    [organizationId]
  );
  return Number(rows[0]?.total ?? 0);
}

/**
 * The broadcast itself, so the send path can derive its organization and
 * template from the row rather than trusting the caller to re-supply them.
 *
 * It previously took both as request parameters, which meant nothing checked
 * that the organization sent in matched the one the broadcast belongs to — a
 * request naming broadcast A and organization B would have resolved B's whole
 * contact list as A's audience and messaged them.
 */
export async function getBroadcast(id: string): Promise<BroadcastRow | null> {
  const { rows } = await getPool().query<{
    id: string;
    organization_id: string;
    template_id: string;
    status: BroadcastStatus;
    audience_filter: AudienceFilter;
    scheduled_at: string | null;
    created_at: string;
  }>(
    `select id, organization_id, template_id, status, audience_filter, scheduled_at, created_at
       from broadcasts where id = $1`,
    [id]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    templateId: row.template_id,
    status: row.status,
    audienceFilter: row.audience_filter,
    scheduledAt: row.scheduled_at,
    createdAt: row.created_at,
  };
}
