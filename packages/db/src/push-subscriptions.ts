import { getPool, withAllTenants } from "./client.js";

/**
 * Devices that can be told (migration 095).
 *
 * One row per installed phone or browser that said yes to notifications. A row
 * belongs to one person, named by `subject` ("e:<employeeId>" or "o:<adminId>",
 * the readerOf key), which the API takes from the session and never from a
 * request body. Every function that changes or removes a device filters on that
 * subject as well as the id, so knowing someone else's device id is not enough
 * to touch it.
 *
 * Per-person reads and writes run in the caller's own scope: a staff request is
 * already inside its business, the owner's requests already cross businesses.
 * The two worker paths (who to tell, how a delivery went) have no request
 * around them and name their reason.
 */
export type PushMode = "mine" | "all" | "paused";

export interface PushSubscriptionRow {
  id: string;
  subject: string;
  organizationId: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string | null;
  previews: boolean;
  mode: PushMode;
  lastSuccessAt: string | null;
  failureCount: number;
}

interface Row {
  id: string;
  subject: string;
  organization_id: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string | null;
  previews: boolean;
  mode: PushMode;
  last_success_at: Date | string | null;
  failure_count: number;
}

const COLUMNS = `id, subject, organization_id, endpoint, p256dh, auth, label, previews, mode, last_success_at, failure_count`;

function toRow(r: Row): PushSubscriptionRow {
  return {
    id: r.id,
    subject: r.subject,
    organizationId: r.organization_id,
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    label: r.label,
    previews: r.previews,
    mode: r.mode,
    lastSuccessAt: r.last_success_at ? new Date(r.last_success_at).toISOString() : null,
    failureCount: Number(r.failure_count),
  };
}

/** "e:<id>" / "o:<id>" → its two halves; anything else is refused, not guessed at. */
function splitSubject(subject: string): { kind: "employee" | "operator"; id: string } {
  const prefix = subject.slice(0, 2);
  const id = subject.slice(2);
  if (!id || (prefix !== "e:" && prefix !== "o:")) {
    throw new Error(`not a push subject: ${subject}`);
  }
  return { kind: prefix === "e:" ? "employee" : "operator", id };
}

/**
 * Register a device, or refresh it when it subscribes again.
 *
 * Keyed by endpoint. A re-subscribe updates the keys and who it belongs to, and
 * leaves the person's own choices (previews, mode) exactly as they set them.
 */
export async function upsertPushSubscription(input: {
  subject: string;
  organizationId: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  label: string | null;
}): Promise<PushSubscriptionRow> {
  const { kind, id } = splitSubject(input.subject);
  const { rows } = await getPool().query<Row>(
    `insert into push_subscriptions (subject_kind, subject_id, organization_id, endpoint, p256dh, auth, user_agent, label)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (endpoint) do update
        set subject_kind = excluded.subject_kind,
            subject_id = excluded.subject_id,
            organization_id = excluded.organization_id,
            p256dh = excluded.p256dh,
            auth = excluded.auth,
            user_agent = excluded.user_agent,
            label = coalesce(excluded.label, push_subscriptions.label),
            failure_count = 0
     returning ${COLUMNS}`,
    [kind, id, input.organizationId, input.endpoint, input.p256dh, input.auth, input.userAgent, input.label]
  );
  return toRow(rows[0]);
}

/** This person's devices, newest first. */
export async function listPushSubscriptionsForSubject(subject: string): Promise<PushSubscriptionRow[]> {
  const { rows } = await getPool().query<Row>(
    `select ${COLUMNS} from push_subscriptions where subject = $1 order by created_at desc`,
    [subject]
  );
  return rows.map(toRow);
}

/**
 * Every device belonging to any of these people, whichever business they work
 * in. The dispatcher's question, asked from the worker with no request around it.
 */
export async function listPushSubscriptionsForSubjects(subjects: string[]): Promise<PushSubscriptionRow[]> {
  if (subjects.length === 0) return [];
  return withAllTenants("push: who to tell", async () => {
    const { rows } = await getPool().query<Row>(
      `select ${COLUMNS} from push_subscriptions where subject = any($1::text[])`,
      [subjects]
    );
    return rows.map(toRow);
  });
}

/** Change previews or mode on one of the caller's own devices; null when it is not theirs. */
export async function updatePushPreferences(
  id: string,
  subject: string,
  patch: { previews?: boolean; mode?: PushMode }
): Promise<PushSubscriptionRow | null> {
  const { rows } = await getPool().query<Row>(
    `update push_subscriptions
        set previews = coalesce($3, previews),
            mode = coalesce($4, mode)
      where id = $1 and subject = $2
      returning ${COLUMNS}`,
    [id, subject, patch.previews ?? null, patch.mode ?? null]
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/** Remove one of the caller's own devices; false when there was none to remove. */
export async function deletePushSubscription(id: string, subject: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `delete from push_subscriptions where id = $1 and subject = $2`,
    [id, subject]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * How one delivery went. A push service that says the device is gone (404/410)
 * means it never will be reached again, so the row goes; any other failure is
 * counted, and Settings shows a device at 5 as broken.
 */
export async function recordPushOutcome(id: string, outcome: "ok" | "gone" | "failed"): Promise<void> {
  await withAllTenants("push: a delivery outcome", async () => {
    if (outcome === "gone") {
      await getPool().query(`delete from push_subscriptions where id = $1`, [id]);
    } else if (outcome === "failed") {
      await getPool().query(`update push_subscriptions set failure_count = failure_count + 1 where id = $1`, [id]);
    } else {
      await getPool().query(
        `update push_subscriptions set last_success_at = now(), failure_count = 0 where id = $1`,
        [id]
      );
    }
  });
}

/**
 * What the dispatcher needs to know about a chat to decide who to tell: who has
 * it, who the customer is, and which business serves them (a chat can be on
 * one business's line and routed to another). Read cross-tenant because the
 * worker has no request scope and the answer spans two businesses.
 */
export async function getPushConversationFacts(conversationId: string): Promise<{
  assigneeEmployeeId: string | null;
  contactName: string | null;
  servingOrganizationId: string;
  servingName: string;
} | null> {
  return withAllTenants("push: what the chat is and who has it", async () => {
    const { rows } = await getPool().query<{
      employee_id: string | null;
      contact_name: string | null;
      serving_id: string;
      serving_name: string;
    }>(
      `select c.employee_id,
              nullif(trim(ct.display_name), '') as contact_name,
              srv.id as serving_id, srv.name as serving_name
         from conversations c
         join organizations srv on srv.id = coalesce(c.routed_organization_id, c.organization_id)
         left join contacts ct on ct.id = c.contact_id
        where c.id = $1`,
      [conversationId]
    );
    const r = rows[0];
    return r
      ? {
          assigneeEmployeeId: r.employee_id,
          contactName: r.contact_name,
          servingOrganizationId: r.serving_id,
          servingName: r.serving_name,
        }
      : null;
  });
}

/** "o:<adminId>" for every active admin account: the owners. */
export async function listOwnerPushSubjects(): Promise<string[]> {
  const { rows } = await getPool().query<{ id: string }>(`select id from admins where is_active = true`);
  return rows.map((r) => `o:${r.id}`);
}
