import { getPool } from "./client.js";
import { contactServedBy } from "./contacts.js";

/**
 * Customer lists that keep themselves up to date — DoubleTick's Segmentation
 * Studio, as saved filters (migration 093).
 *
 * ============================================================
 * WHAT NO LIST CAN SWITCH OFF
 * ============================================================
 *
 * Every evaluation, whatever the filter, is:
 *   - this business's customers — `contactServedBy`, the shared-number-aware
 *     predicate; never `organization_id`, which is the number's owner;
 *   - never an opted-out contact (`reengagement_opted_out`);
 *   - only a contact with a WhatsApp number — a list is a broadcast audience,
 *     and since migration 088 a contact can exist with none.
 *
 * Those three are the BASE clause below, not options on the filter, so a list
 * built wrong still cannot message someone who said stop.
 */

export interface SegmentFilter {
  /** Any of these labels on one of their conversations with this business. */
  tags?: string[];
  /** Any of these pipeline stages. */
  stages?: string[];
  /** Wrote to us within the last N days. */
  activeWithinDays?: number;
  /** Has NOT written for at least N days (or never). */
  quietForDays?: number;
  /** Lead source, exactly (case-insensitive). */
  leadSource?: string;
  /** A custom field equal to a value. */
  field?: { key: string; value: string };
  /** Lead score at least this. */
  minScore?: number;
}

export interface Segment {
  id: string;
  name: string;
  filter: SegmentFilter;
  createdAt: string;
  updatedAt: string;
}

export interface SegmentContact {
  id: string;
  waId: string;
  displayName: string | null;
}

const int = (v: unknown, min: number, max: number): number | undefined => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
};
const words = (v: unknown, max: number): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean))]
    .map((x) => x.slice(0, 60))
    .slice(0, max);
  return out.length ? out : undefined;
};

/**
 * Only what this file knows how to evaluate is kept — an unrecognised key would
 * be stored, shown as part of the list, and silently ignored when it is used.
 */
export function normaliseSegmentFilter(raw: unknown): SegmentFilter {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: SegmentFilter = {};
  const tags = words(r.tags, 20);
  if (tags) out.tags = tags;
  const stages = words(r.stages, 20);
  if (stages) out.stages = stages;
  const active = int(r.activeWithinDays, 1, 3650);
  if (active) out.activeWithinDays = active;
  const quiet = int(r.quietForDays, 1, 3650);
  if (quiet) out.quietForDays = quiet;
  if (typeof r.leadSource === "string" && r.leadSource.trim()) out.leadSource = r.leadSource.trim().slice(0, 80);
  const f = r.field as { key?: unknown; value?: unknown } | undefined;
  if (f && typeof f.key === "string" && f.key.trim() && typeof f.value === "string") {
    out.field = { key: f.key.trim().slice(0, 60), value: f.value.trim().slice(0, 200) };
  }
  const score = int(r.minScore, 0, 100);
  if (score !== undefined && score > 0) out.minScore = score;
  return out;
}

/** The WHERE clause for a filter. $1 is always the serving business. */
function whereFor(filter: SegmentFilter, params: unknown[]): string {
  const clauses = [
    contactServedBy("$1"),
    "ct.reengagement_opted_out = false",
    "coalesce(ct.wa_id, '') <> ''",
  ];
  const p = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (filter.tags?.length) {
    clauses.push(
      `exists (select 1 from conversations c
                where c.contact_id = ct.id
                  and coalesce(c.routed_organization_id, c.organization_id) = $1
                  and c.tags && ${p(filter.tags)}::text[])`
    );
  }
  if (filter.stages?.length) clauses.push(`ct.lead_stage = any(${p(filter.stages)}::text[])`);
  if (filter.activeWithinDays) {
    clauses.push(`ct.last_message_at > now() - (${p(filter.activeWithinDays)}::int * interval '1 day')`);
  }
  if (filter.quietForDays) {
    clauses.push(
      `(ct.last_message_at is null or ct.last_message_at < now() - (${p(filter.quietForDays)}::int * interval '1 day'))`
    );
  }
  if (filter.leadSource) clauses.push(`lower(ct.lead_source) = lower(${p(filter.leadSource)})`);
  if (filter.field) {
    clauses.push(`ct.custom_fields ->> ${p(filter.field.key)} = ${p(filter.field.value)}`);
  }
  if (filter.minScore) clauses.push(`coalesce(ct.lead_score, 0) >= ${p(filter.minScore)}`);
  return clauses.join("\n        and ");
}

/** Everyone the list reaches right now — the audience, evaluated fresh. */
export async function segmentContacts(organizationId: string, filter: SegmentFilter): Promise<SegmentContact[]> {
  const params: unknown[] = [organizationId];
  const where = whereFor(normaliseSegmentFilter(filter), params);
  const { rows } = await getPool().query<{ id: string; wa_id: string; display_name: string | null }>(
    `select ct.id, ct.wa_id, ct.display_name from contacts ct
      where ${where}
      order by ct.last_message_at desc nulls last`,
    params
  );
  return rows.map((r) => ({ id: r.id, waId: r.wa_id, displayName: r.display_name }));
}

/** How many the list reaches now, and a few names so the reader can sanity-check it. */
export async function previewSegment(
  organizationId: string,
  filter: SegmentFilter
): Promise<{ count: number; sample: string[] }> {
  const params: unknown[] = [organizationId];
  const where = whereFor(normaliseSegmentFilter(filter), params);
  const { rows } = await getPool().query<{ count: string; sample: string[] | null }>(
    `select count(*)::text as count,
            (array_agg(coalesce(ct.display_name, '+' || ct.wa_id) order by ct.last_message_at desc nulls last))[1:5] as sample
       from contacts ct
      where ${where}`,
    params
  );
  return { count: Number(rows[0]?.count ?? 0), sample: rows[0]?.sample ?? [] };
}

export async function listSegments(organizationId: string): Promise<Segment[]> {
  const { rows } = await getPool().query<{
    id: string;
    name: string;
    filter: SegmentFilter;
    created_at: string;
    updated_at: string;
  }>(
    `select id, name, filter, created_at, updated_at from contact_segments
      where organization_id = $1 order by name`,
    [organizationId]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    filter: normaliseSegmentFilter(r.filter),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function getSegment(organizationId: string, segmentId: string): Promise<Segment | null> {
  const { rows } = await getPool().query<{
    id: string;
    name: string;
    filter: SegmentFilter;
    created_at: string;
    updated_at: string;
  }>(
    `select id, name, filter, created_at, updated_at from contact_segments
      where organization_id = $1 and id = $2`,
    [organizationId, segmentId]
  );
  const r = rows[0];
  return r
    ? { id: r.id, name: r.name, filter: normaliseSegmentFilter(r.filter), createdAt: r.created_at, updatedAt: r.updated_at }
    : null;
}

export async function createSegment(
  organizationId: string,
  name: string,
  filter: SegmentFilter,
  createdBy: string | null
): Promise<Segment> {
  const { rows } = await getPool().query<{ id: string; created_at: string; updated_at: string }>(
    `insert into contact_segments (organization_id, name, filter, created_by)
     values ($1, $2, $3::jsonb, $4)
     returning id, created_at, updated_at`,
    [organizationId, name, JSON.stringify(normaliseSegmentFilter(filter)), createdBy]
  );
  return {
    id: rows[0].id,
    name,
    filter: normaliseSegmentFilter(filter),
    createdAt: rows[0].created_at,
    updatedAt: rows[0].updated_at,
  };
}

export async function deleteSegment(organizationId: string, segmentId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `delete from contact_segments where organization_id = $1 and id = $2`,
    [organizationId, segmentId]
  );
  return (rowCount ?? 0) > 0;
}
