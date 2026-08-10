import { getPool } from "./client.js";

/**
 * What we remember about one customer of one business.
 *
 * Keyed on contact_id, which is already unique per (organization, wa_id) — see
 * migration 021 for why that distinction is load-bearing on a shared number.
 */

export interface ContactMemory {
  summary: string;
  sourceMessages: number;
  lastSeenAt: string | null;
  updatedAt: string;
}

export async function getContactMemory(
  organizationId: string,
  contactId: string
): Promise<ContactMemory | null> {
  const { rows } = await getPool().query<{
    summary: string;
    source_messages: number;
    last_seen_at: string | null;
    updated_at: string;
  }>(
    `select summary, source_messages, last_seen_at, updated_at
       from contact_memory
      where organization_id = $1 and contact_id = $2 and expires_at > now()`,
    [organizationId, contactId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    summary: row.summary,
    sourceMessages: row.source_messages,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Writes or replaces a memory, and restarts its retention clock.
 *
 * `expires_at` is reset on every write rather than left from the first one, so
 * an actively-served customer's memory stays current while someone who has not
 * been heard from in six months falls out on their own.
 */
export async function upsertContactMemory(input: {
  organizationId: string;
  contactId: string;
  summary: string;
  sourceMessages: number;
}): Promise<void> {
  await getPool().query(
    `insert into contact_memory
       (organization_id, contact_id, summary, source_messages, last_seen_at, updated_at, expires_at)
     values ($1, $2, $3, $4, now(), now(), now() + interval '180 days')
     on conflict (organization_id, contact_id) do update
       set summary         = excluded.summary,
           source_messages = excluded.source_messages,
           last_seen_at    = now(),
           updated_at      = now(),
           expires_at      = now() + interval '180 days'`,
    [input.organizationId, input.contactId, input.summary, input.sourceMessages]
  );
}

/** Deletes lapsed memories. Returns how many, so a silent no-op is visible. */
export async function purgeExpiredContactMemory(): Promise<number> {
  const { rowCount } = await getPool().query(`delete from contact_memory where expires_at < now()`);
  return rowCount ?? 0;
}

/**
 * Forgets one customer entirely.
 *
 * Exists because "delete what you hold about me" is a request a customer can
 * make, and an answer of "we would have to write some code" is not one.
 */
export async function forgetContact(organizationId: string, contactId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `delete from contact_memory where organization_id = $1 and contact_id = $2`,
    [organizationId, contactId]
  );
  return (rowCount ?? 0) > 0;
}
