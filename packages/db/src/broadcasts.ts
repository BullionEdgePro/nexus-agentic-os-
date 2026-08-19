import { getPool, withAllTenants } from "./client.js";
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
    // $4 is cast on both uses. Uncast it appeared twice — once as a column
    // value, where Postgres can infer timestamptz from the column, and once
    // inside `case when $4 is null`, where there is no type context at all.
    // With both, it cannot resolve a single type and the statement fails to
    // prepare: "could not determine data type of parameter $4". This never
    // worked, which means a broadcast draft could never be created, which means
    // Send would have failed at its first step regardless of Meta approval.
    `insert into broadcasts (organization_id, template_id, audience_filter, scheduled_at, status)
     values ($1, $2, $3::jsonb, $4::timestamptz,
             case when $4::timestamptz is null then 'draft' else 'scheduled' end)
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
  bodyParamCount: number;
}

export async function getBroadcastTemplate(templateId: string): Promise<BroadcastTemplateInfo | null> {
  const { rows } = await getPool().query<{
    meta_template_name: string;
    language: string;
    is_approved: boolean;
    body_param_count: number;
  }>(
    `select meta_template_name, language, is_approved, body_param_count
       from message_templates where id = $1`,
    [templateId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    metaTemplateName: row.meta_template_name,
    language: row.language,
    isApproved: row.is_approved,
    bodyParamCount: row.body_param_count,
  };
}

/**
 * Resolves the audience for a broadcast. audience_filter is matched against
 * contacts.attributes via jsonb containment (@>) — pass {} to target every
 * contact in the organization.
 */
export async function getContactsForAudience(
  organizationId: string,
  audienceFilter: AudienceFilter
): Promise<Array<{ id: string; waId: string; displayName: string | null }>> {
  const { rows } = await getPool().query<{ id: string; wa_id: string; display_name: string | null }>(
    `select id, wa_id, display_name from contacts
     where organization_id = $1 and attributes @> $2::jsonb`,
    [organizationId, JSON.stringify(audienceFilter ?? {})]
  );
  return rows.map((row) => ({ id: row.id, waId: row.wa_id, displayName: row.display_name }));
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
  waMessageId?: string | null
): Promise<void> {
  await getPool().query(
    `update broadcast_recipients
     set status = $2,
         sent_at = case when $2 = 'sent' then now() else sent_at end,
         -- Migration 051. Kept even on the failed path, where it is null: the
         -- column exists so a receipt can find this row later, and a send that
         -- never reached Meta has no receipt to wait for.
         wa_message_id = coalesce($3, wa_message_id)
     where id = $1`,
    [recipientId, status, waMessageId ?? null]
  );
}

/**
 * A delivery receipt from Meta, applied to the campaign recipient it names.
 *
 * The counterpart of `recordDeliveryStatus` for `messages`, and deliberately a
 * separate function rather than a shared one: the two tables have different
 * vocabularies, and papering over that with a generic updater is how one of them
 * would quietly acquire a status its own check constraint rejects.
 *
 * THE MAPPING IS THE INTERESTING PART. `broadcast_recipients.status` allows
 * pending / sent / delivered / failed. Meta reports sent / delivered / read /
 * failed. There is no 'read' here and inventing one would mean a migration on
 * every consumer of this column, so a read receipt is recorded as 'delivered' —
 * which is not a fudge: being read is proof of delivery, and this table's
 * question is whether the campaign arrived, not whether it was opened.
 *
 * Monotonic for the same reason `messages` is: Meta does not promise order, so
 * a late 'sent' must not walk a delivered recipient backwards. 'failed' is
 * terminal and reachable from anywhere.
 *
 * Returns whether anything moved. False is normal — most wamids belong to
 * replies rather than campaigns.
 */
export async function recordBroadcastDelivery(input: {
  waMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  errorText?: string | null;
}): Promise<boolean> {
  const mapped = input.status === "read" ? "delivered" : input.status;
  const { rowCount } = await getPool().query(
    `update broadcast_recipients
        set status = $2,
            delivery_error = coalesce($3, delivery_error)
      where wa_message_id = $1
        and (
              ($2 = 'failed' and status <> 'failed')
              or (
                status <> 'failed'
                and coalesce(array_position($4::text[], $2), 0)
                  > coalesce(array_position($4::text[], status), 0)
              )
            )`,
    [input.waMessageId, mapped, input.errorText ?? null, [...BROADCAST_STATUS_LADDER]]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * The order a campaign recipient moves through.
 *
 * Not `DELIVERY_STATUS_LADDER` from @nexus/shared, which starts at 'queued' and
 * ends at 'read' — this table has neither. Sharing the constant would let a
 * value through that this table's own check constraint rejects, and the failure
 * would be an UPDATE that silently matches nothing.
 */
const BROADCAST_STATUS_LADDER = ["pending", "sent", "delivered"] as const;

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
  /** Meta's verbatim status, so "why can I not send this" has an answer. */
  status: string | null;
  bodyParamCount: number;
  syncedAt: string | null;
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
    status: string | null;
    body_param_count: number;
    synced_at: string | null;
    created_at: string;
  }>(
    `select id, meta_template_name, language, category, is_approved,
            status, body_param_count, synced_at, created_at
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
    status: row.status,
    bodyParamCount: row.body_param_count,
    syncedAt: row.synced_at,
    createdAt: row.created_at,
  }));
}

export interface BroadcastSummary extends BroadcastRow {
  templateName: string;
  recipients: number;
  /**
   * Accepted by Meta. NOT delivered, and the deck said otherwise until 051.
   *
   * This number counts `sent` and `delivered` together because a delivered
   * message was necessarily accepted first. It is the honest ceiling on what a
   * campaign achieved, and on its own it is what a 2xx from the Graph API means:
   * Meta took the message. Whether anybody received it is `delivered`.
   */
  sent: number;
  /**
   * Confirmed delivered by a receipt from Meta.
   *
   * Zero for every campaign sent before migration 051, and that is not a
   * measurement — nothing wrote this state, so the honest reading of a zero on
   * an old campaign is "unknown", which is why the screen says so rather than
   * printing a bare 0.
   */
  delivered: number;
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
    delivered: string;
    failed: string;
  }>(
    `select b.id, b.organization_id, b.template_id, b.status, b.audience_filter,
            b.scheduled_at, b.created_at,
            t.meta_template_name                              as template_name,
            count(r.id)::text                                 as recipients,
            count(r.id) filter (where r.status in ('sent', 'delivered'))::text as sent,
            count(r.id) filter (where r.status = 'delivered')::text          as delivered,
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
    delivered: Number(row.delivered),
    failed: Number(row.failed),
  }));
}

/**
 * How many contacts a send would actually reach, before committing to it.
 *
 * The column is `wa_id`. An earlier version of this query filtered on
 * `whatsapp_number`, which does not exist on `contacts` — so every authenticated
 * load of the Broadcasts page raised, and the page never rendered. Nothing
 * caught it: the route returns 401 unauthenticated, so an external check saw a
 * healthy endpoint, and no test exercised the query against the real schema.
 * The RLS preflight found it by running the real function against the real
 * database, which is the only thing that could have.
 *
 * `wa_id` is NOT NULL in the schema, so the meaningful exclusion is an empty
 * string rather than a null — a contact created from a malformed payload can
 * carry one, and messaging it would fail per recipient at send time.
 */
export async function countReachableContacts(organizationId: string): Promise<number> {
  const { rows } = await getPool().query<{ total: string }>(
    `select count(*)::text as total
       from contacts
      where organization_id = $1 and coalesce(wa_id, '') <> ''`,
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

export interface TemplateMirrorInput {
  organizationId: string;
  metaTemplateId: string;
  name: string;
  language: string;
  category: string | null;
  status: string;
  bodyParamCount: number;
}

/**
 * Writes Meta's answer about one template into our mirror.
 *
 * `is_approved` is derived here and nowhere else, so there is exactly one place
 * that decides what "approved" means. Meta reports several non-sending states —
 * PENDING, REJECTED, PAUSED, DISABLED — and only APPROVED may be sent; treating
 * anything else as sendable produces a broadcast that fails per recipient after
 * every row has already been written.
 */
export async function upsertTemplateFromMeta(input: TemplateMirrorInput): Promise<void> {
  await getPool().query(
    `insert into message_templates
       (organization_id, meta_template_id, meta_template_name, language, category,
        status, is_approved, body_param_count, synced_at)
     values ($1, $2, $3, $4, $5, $6, $6 = 'APPROVED', $7, now())
     on conflict (organization_id, meta_template_id) where meta_template_id is not null
     do update set meta_template_name = excluded.meta_template_name,
                   language           = excluded.language,
                   category           = excluded.category,
                   status             = excluded.status,
                   is_approved        = excluded.is_approved,
                   body_param_count   = excluded.body_param_count,
                   synced_at          = now()`,
    [
      input.organizationId,
      input.metaTemplateId,
      input.name,
      input.language,
      input.category,
      input.status,
      input.bodyParamCount,
    ]
  );
}

/**
 * Marks templates Meta no longer returns as gone.
 *
 * A template deleted at Meta would otherwise sit in the picker forever, look
 * approved, and fail at send. Rows are marked rather than deleted because
 * broadcasts reference them and past sends must stay readable.
 */
export async function retireMissingTemplates(
  organizationId: string,
  keepMetaIds: string[]
): Promise<number> {
  const { rowCount } = await getPool().query(
    `update message_templates
        set status = 'DELETED', is_approved = false, synced_at = now()
      where organization_id = $1
        and meta_template_id is not null
        and not (meta_template_id = any($2::text[]))
        and status is distinct from 'DELETED'`,
    [organizationId, keepMetaIds]
  );
  return rowCount ?? 0;
}

/**
 * Which business messaged this contact first, if one did.
 *
 * ============================================================
 * THE PROBLEM THIS ANSWERS
 * ============================================================
 *
 * A campaign goes out from Juris Prime. A recipient replies "yes please". That
 * inbound message arrives on the shared number carrying no tag and probably no
 * keyword, so the switchboard cannot tell which of five businesses it is for —
 * and asks. The customer is shown a menu of five firms by the same number that
 * messaged them ninety seconds ago.
 *
 * Nobody had to decide that; it is what "route by the text of the message"
 * does when the message is a reply to something. The context that answers it
 * was already in the database.
 *
 * ============================================================
 * WHY THIS IS CROSS-TENANT, AND SAYS SO
 * ============================================================
 *
 * `broadcasts` is tenant-scoped. The reply pipeline runs inside the NUMBER
 * OWNER's transaction, so a broadcast belonging to Juris Prime is invisible
 * there — the eighth appearance of the trap this platform keeps producing, and
 * the first where widening to the serving business is not the fix, because
 * WHICH business is serving is precisely the question being asked.
 *
 * So it is a stated cross-tenant read, in the same class as resolving which
 * tenant a phone number belongs to: the answer cannot be scoped to a tenant
 * because it is what determines the tenant.
 *
 * Sent or delivered only. A recipient row that is `pending` was never actually
 * messaged, and routing somebody to a business that has not spoken to them yet
 * would be inventing a conversation neither party had.
 */
export async function findRecentBroadcastSender(
  contactId: string,
  withinHours: number
): Promise<{ organizationId: string; sentAt: string } | null> {
  return withAllTenants("switchboard: which business messaged this contact", async () => {
    const { rows } = await getPool().query<{ organization_id: string; sent_at: string }>(
      `select b.organization_id, r.sent_at::text
         from broadcast_recipients r
         join broadcasts b on b.id = r.broadcast_id
        where r.contact_id = $1
          and r.status in ('sent', 'delivered')
          and r.sent_at is not null
          and r.sent_at > now() - ($2 || ' hours')::interval
        order by r.sent_at desc
        limit 1`,
      [contactId, String(withinHours)]
    );
    const row = rows[0];
    return row ? { organizationId: row.organization_id, sentAt: row.sent_at } : null;
  });
}
