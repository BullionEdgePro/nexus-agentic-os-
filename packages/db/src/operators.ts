import { getPool } from "./client.js";

/**
 * Storage and reconciliation for operator findings (F8).
 *
 * The interesting function here is `reconcileFindings`. Everything else is
 * reading.
 */

export type FindingSeverity = "info" | "warn" | "urgent";

/** What an operator reports. Produced fresh on every run. */
export interface FindingInput {
  /** Stable within (organization, operator). Usually the subject's row id. */
  fingerprint: string;
  severity: FindingSeverity;
  title: string;
  detail?: string | null;
  subjectKind?: string | null;
  subjectId?: string | null;
  /**
   * The business this finding is ABOUT, when that is not the business whose
   * sweep found it.
   *
   * All five businesses answer on one WhatsApp number, so a routed conversation
   * is owned by the number's owner and served by somebody else. The sweep can
   * only see it from the owner's transaction, so the finding must stay owned
   * there -- see migration 053 for why filing it against the serving business
   * makes the next sweep retract it. This names who it is about.
   *
   * Null for the ten operators that read the business's own data, where owner
   * and subject are the same business by construction.
   */
  servingOrganizationId?: string | null;
}

export interface OperatorFinding {
  id: string;
  organizationId: string;
  businessName: string;
  businessSlug: string;
  operator: string;
  severity: FindingSeverity;
  title: string;
  detail: string | null;
  subjectKind: string | null;
  subjectId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}

interface FindingRow {
  id: string;
  organization_id: string;
  business_name: string;
  business_slug: string;
  operator: string;
  severity: FindingSeverity;
  title: string;
  detail: string | null;
  subject_kind: string | null;
  subject_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
}

const toFinding = (row: FindingRow): OperatorFinding => ({
  id: row.id,
  organizationId: row.organization_id,
  businessName: row.business_name,
  businessSlug: row.business_slug,
  operator: row.operator,
  severity: row.severity,
  title: row.title,
  detail: row.detail,
  subjectKind: row.subject_kind,
  subjectId: row.subject_id,
  firstSeenAt: row.first_seen_at,
  lastSeenAt: row.last_seen_at,
  resolvedAt: row.resolved_at,
});

export interface ReconcileResult {
  /** Findings currently true — opened or still open. */
  standing: number;
  /** Findings that were open and are no longer true. */
  retracted: number;
  /**
   * The ones that BECAME true in this sweep, which is a different question.
   *
   * `standing` counts everything still wrong, so it is the same number on the
   * sweep a problem appears and on the two hundred sweeps afterwards. Anything
   * that wants to tell somebody needs the transition, or it says the same thing
   * every ten minutes until they stop reading it.
   *
   * Deliberately carries no title and no subject: a finding's title names the
   * customer ("Ahmed has been waiting 3 hours"), and the caller for this is
   * dispatch to somewhere outside the platform.
   */
  raised: RaisedFinding[];
}

/** A finding at the moment it became true. Severity and where to look, nothing else. */
export interface RaisedFinding {
  organizationId: string;
  servingOrganizationId: string | null;
  operator: string;
  severity: FindingSeverity;
}

/**
 * Replace one operator's picture of one business with what is true NOW.
 *
 * This is the whole design. An operator does not "raise an alert"; it declares
 * the complete set of things currently wrong, and this reconciles the stored
 * set against it:
 *
 *   in the set, not stored   → opened
 *   in the set, stored       → touched, and un-resolved if it had come back
 *   stored, not in the set   → RESOLVED
 *
 * That last line is the one that matters. An alert list that only ever grows
 * gets ignored within a week, and an ignored list is indistinguishable from no
 * list while still looking like a working feature. Operators that can only
 * raise are the reason most alerting is wallpaper.
 *
 * AN EMPTY SET IS MEANINGFUL, NOT A NO-OP. Passing no findings means "nothing
 * is wrong", and every standing finding for that operator is retracted. The
 * `not in` below is deliberately allowed to match everything when `incoming` is
 * empty — an early return on an empty array would leave yesterday's resolved
 * problems on screen forever, which is the exact failure this function exists
 * to prevent.
 *
 * Done in ONE statement so a crash between "open the new ones" and "retract the
 * old ones" cannot leave a half-reconciled list that reads as authoritative.
 */
export async function reconcileFindings(
  organizationId: string,
  operator: string,
  found: FindingInput[]
): Promise<ReconcileResult> {
  // Deduplicated before it reaches Postgres.
  //
  // `on conflict do update` cannot touch the same row twice within one
  // statement — two findings sharing a fingerprint raise "ON CONFLICT DO UPDATE
  // command cannot affect row a second time", which would kill that operator
  // for that business on every single sweep until somebody read the log.
  //
  // No operator produces duplicates today; each keys on a row id from a query
  // that returns it once. This is here for the one somebody writes next, where
  // the mistake is easy (a join fanning out) and the failure is total rather
  // than partial. Last occurrence wins, which matches the upsert's own
  // semantics had they arrived as separate statements.
  const unique = new Map<string, FindingInput>();
  for (const finding of found) unique.set(finding.fingerprint, finding);
  const deduped = [...unique.values()];

  const { rows } = await getPool().query<{
    standing: string;
    retracted: string;
    raised: Array<{
      organizationId: string;
      servingOrganizationId: string | null;
      severity: FindingSeverity;
    }>;
  }>(
    `with incoming as (
       select * from unnest(
         $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::uuid[], $9::uuid[]
       ) as t(fingerprint, severity, title, detail, subject_kind, subject_id, serving_organization_id)
     ),
     upserted as (
       insert into operator_findings (
         organization_id, operator, fingerprint, severity, title, detail, subject_kind, subject_id,
         serving_organization_id
       )
       select $1, $2, fingerprint, severity, title, detail, subject_kind, subject_id,
              serving_organization_id from incoming
       on conflict (organization_id, operator, fingerprint) do update set
         severity     = excluded.severity,
         title        = excluded.title,
         detail       = excluded.detail,
         subject_kind = excluded.subject_kind,
         subject_id   = excluded.subject_id,
         -- Updated rather than left alone: a conversation can be routed after
         -- the finding was first raised, and the finding should follow it.
         serving_organization_id = excluded.serving_organization_id,
         last_seen_at = now(),
         -- A finding that had been resolved and is back is NEW again. Keeping
         -- the original first_seen_at would report something that returned
         -- yesterday as three weeks old, and age is most of the signal here.
         first_seen_at = case
                           when operator_findings.resolved_at is not null then now()
                           else operator_findings.first_seen_at
                         end,
         resolved_at  = null,
         updated_at   = now()
       -- NEWLY RAISED, distinguished without a second query.
       --
       -- now() is fixed for the whole statement, and first_seen_at is only
       -- set to it on an insert or on a finding coming back from resolved --
       -- every other path leaves the original. So the two timestamps being
       -- equal is exactly "this became true just now", and nothing else.
       returning organization_id, serving_organization_id, severity,
                 (first_seen_at = last_seen_at) as newly_raised
     ),
     retracted as (
       update operator_findings f
          set resolved_at = now(), updated_at = now()
        where f.organization_id = $1
          and f.operator = $2
          and f.resolved_at is null
          -- Reads the table as it was before this statement, which is exactly
          -- right: anything inserted by the upsert above is also in incoming,
          -- so it is excluded here anyway.
          and f.fingerprint not in (select fingerprint from incoming)
        returning 1
     )
     select (select count(*) from upserted)::text  as standing,
            (select count(*) from retracted)::text as retracted,
            coalesce(
              (select json_agg(json_build_object(
                 'organizationId', u.organization_id,
                 'servingOrganizationId', u.serving_organization_id,
                 'severity', u.severity
               ))
                 from upserted u where u.newly_raised),
              '[]'::json
            ) as raised`,
    [
      organizationId,
      operator,
      deduped.map((f) => f.fingerprint),
      deduped.map((f) => f.severity),
      deduped.map((f) => f.title),
      deduped.map((f) => f.detail ?? null),
      deduped.map((f) => f.subjectKind ?? null),
      deduped.map((f) => f.subjectId ?? null),
      deduped.map((f) => f.servingOrganizationId ?? null),
    ]
  );

  return {
    standing: Number(rows[0]?.standing ?? 0),
    retracted: Number(rows[0]?.retracted ?? 0),
    // Carries the operator through so a caller holding several results can tell
    // them apart without threading context back in.
    raised: (rows[0]?.raised ?? []).map((r) => ({ ...r, operator })),
  };
}

/**
 * WHICH BUSINESS A FINDING IS ABOUT, which is not always the one that owns it.
 *
 * A routed conversation belongs to the shared number's owner, so the sweep can
 * only see it from the owner's transaction and the finding is owned there.
 * `serving_organization_id` names who it is actually about. Every read that a
 * person sees resolves through this; RECONCILIATION does not, and must not --
 * see migration 053.
 */
const FINDING_BUSINESS = "coalesce(f.serving_organization_id, f.organization_id)";

const FINDING_SELECT = `
  select f.id, ${FINDING_BUSINESS} as organization_id,
         o.name as business_name,
         o.slug as business_slug,
         f.operator, f.severity, f.title, f.detail,
         f.subject_kind, f.subject_id,
         f.first_seen_at, f.last_seen_at, f.resolved_at
    from operator_findings f
    join organizations o on o.id = ${FINDING_BUSINESS}
`;

/**
 * What is currently wrong.
 *
 * Ordered by severity then by age, oldest first — a problem standing for three
 * days matters more than the same problem noticed an hour ago, and burying it
 * under the newest arrival is how a list stops being read.
 */
export async function listOpenFindings(
  organizationId?: string | null,
  limit = 200
): Promise<OperatorFinding[]> {
  const { rows } = await getPool().query<FindingRow>(
    `${FINDING_SELECT}
      where f.resolved_at is null
        and ($1::uuid is null or ${FINDING_BUSINESS} = $1)
      order by case f.severity when 'urgent' then 0 when 'warn' then 1 else 2 end,
               f.first_seen_at asc
      limit $2`,
    [organizationId ?? null, limit]
  );
  return rows.map(toFinding);
}

export interface FindingCounts {
  urgent: number;
  warn: number;
  info: number;
}

export async function countOpenFindings(
  organizationId?: string | null
): Promise<FindingCounts> {
  const { rows } = await getPool().query<{ urgent: string; warn: string; info: string }>(
    `select count(*) filter (where severity = 'urgent')::text as urgent,
            count(*) filter (where severity = 'warn')::text   as warn,
            count(*) filter (where severity = 'info')::text   as info
       from operator_findings f
      where f.resolved_at is null
        and ($1::uuid is null or ${FINDING_BUSINESS} = $1)`,
    [organizationId ?? null]
  );
  return {
    urgent: Number(rows[0]?.urgent ?? 0),
    warn: Number(rows[0]?.warn ?? 0),
    info: Number(rows[0]?.info ?? 0),
  };
}

/**
 * When each operator last completed a pass, derived from its own findings.
 *
 * Deliberately NOT a separate run-log table. A second table recording "the
 * operator ran" can disagree with the findings themselves, and then there are
 * two answers to one question — the failure mode this codebase keeps meeting.
 *
 * The honest limitation, stated rather than hidden: an operator that has never
 * found anything has no rows and therefore no timestamp, so the UI cannot tell
 * "ran and found nothing" from "never ran". That is why the page lists the
 * registered operators from code and shows which ones are quiet, instead of
 * inferring the roster from this table.
 */
export async function lastSeenByOperator(
  organizationId?: string | null
): Promise<Record<string, string>> {
  const { rows } = await getPool().query<{ operator: string; last_seen_at: string }>(
    `select f.operator, max(f.last_seen_at) as last_seen_at
       from operator_findings f
      where ($1::uuid is null or ${FINDING_BUSINESS} = $1)
      group by f.operator`,
    [organizationId ?? null]
  );
  return Object.fromEntries(rows.map((row) => [row.operator, row.last_seen_at]));
}
