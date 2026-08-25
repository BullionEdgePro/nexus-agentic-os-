import { getPool, withAllTenants } from "./client.js";

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
  /** When a person accepted it. Null for everything nobody has looked at. */
  dismissedAt: string | null;
  /** Who accepted it. A dismissal is an act by somebody. */
  dismissedBy: string | null;
  /** Why, if they said. Optional, and usually empty. */
  dismissedReason: string | null;
  /** When the acceptance runs out. Shown, so an acceptance has a visible end. */
  dismissedUntil: string | null;
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
  dismissed_at: string | null;
  dismissed_by: string | null;
  dismissed_reason: string | null;
  dismissed_until: string | null;
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
  dismissedAt: row.dismissed_at,
  dismissedBy: row.dismissed_by,
  dismissedReason: row.dismissed_reason,
  dismissedUntil: row.dismissed_until,
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
         -- A DISMISSAL LAPSES EXACTLY WHEN THE AGE RESETS, and the shared
         -- predicate is the point. "I have accepted this" is about the
         -- occurrence somebody looked at, not about the fingerprint forever:
         -- accepting that three firms have no staff today must not silence the
         -- same finding next March, when it would mean something else.
         --
         -- Split these two branches apart and you get a permanent, silent mute
         -- that looks like a working feature. The test named
         -- a-dismissal-lapses-when-the-finding-does fails if they stop
         -- matching. (No backticks in here: this is a template literal, and a
         -- backtick in a SQL comment ends the string. Fourth time today.)
         --
         -- Note this is the ONLY write to dismissed_at in the sweep path, and
         -- it only ever writes NULL. An operator can retract a finding; it can
         -- never accept one. That is a person's act by definition.
         -- THE SECOND WAY AN ACCEPTANCE ENDS, added 2026-08-25 because the
         -- first way is not enough on its own. Resolution clears it for
         -- everything that ENDS. For a condition that stays continuously true
         -- there is no resolution, so that branch never fires and the
         -- acceptance is permanent -- the exact "silent mute that looks like a
         -- working feature" this file's test warned about. Production had four
         -- of them, one an urgent finding accepted at 118 hours of a customer
         -- waiting and unable to come back at 142.
         --
         -- All four branches share the predicate, for the same reason the
         -- original two did: split them and one field outlives the others,
         -- which is a row that is dismissed by nobody or accepted with no end.
         dismissed_at = case
                          when operator_findings.resolved_at is not null
                            or operator_findings.dismissed_until <= now() then null
                          else operator_findings.dismissed_at
                        end,
         dismissed_by = case
                          when operator_findings.resolved_at is not null
                            or operator_findings.dismissed_until <= now() then null
                          else operator_findings.dismissed_by
                        end,
         dismissed_reason = case
                          when operator_findings.resolved_at is not null
                            or operator_findings.dismissed_until <= now() then null
                          else operator_findings.dismissed_reason
                        end,
         dismissed_until = case
                          when operator_findings.resolved_at is not null
                            or operator_findings.dismissed_until <= now() then null
                          else operator_findings.dismissed_until
                        end,
         resolved_at  = null,
         updated_at   = now()
       -- NEWLY RAISED, distinguished without a second query.
       --
       -- now() is fixed for the whole statement, and first_seen_at is only
       -- set to it on an insert or on a finding coming back from resolved --
       -- every other path leaves the original. So the two timestamps being
       -- equal is exactly "this became true just now", and nothing else.
       -- The dismissed_at test below is belt and braces: by the reasoning
       -- above a dismissed row cannot be newly-raised, because the only path
       -- that sets first_seen_at = now() also clears the dismissal in the same
       -- statement. It is written down because "cannot happen" arguments are
       -- how alerting starts firing at somebody who already said they knew.
       returning organization_id, serving_organization_id, severity,
                 (first_seen_at = last_seen_at and dismissed_at is null) as newly_raised
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
         f.first_seen_at, f.last_seen_at, f.resolved_at,
         f.dismissed_at, f.dismissed_by, f.dismissed_reason, f.dismissed_until
    from operator_findings f
    join organizations o on o.id = ${FINDING_BUSINESS}
`;

/**
 * What is currently wrong.
 *
 * Ordered by severity then by age, oldest first — a problem standing for three
 * days matters more than the same problem noticed an hour ago, and burying it
 * under the newest arrival is how a list stops being read.
 *
 * RETURNS DISMISSED FINDINGS TOO, each carrying its `dismissedAt`. Filtering
 * them out here would be the cheaper implementation and the wrong one: the deck
 * has to be able to show how many were accepted and by whom, and a caller that
 * cannot see them cannot say so. Hiding them at the source is how a list starts
 * lying by omission, which is the failure this whole screen is built against.
 * The caller partitions; the reader is told.
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
  /**
   * Open, still true, and accepted by somebody.
   *
   * Counted SEPARATELY rather than folded into the three above, because those
   * three drive a badge that means "this needs you" and an accepted finding
   * does not. Counted rather than dropped, because a screen that silently knows
   * about four problems it is not mentioning is the thing this deck exists not
   * to be.
   */
  dismissed: number;
}

/**
 * How much needs attention, and how much has been accepted.
 *
 * The severity counts EXCLUDE dismissed findings. That is the single decision
 * in this function and it is what makes dismissal worth having: a badge that
 * still reads "1 urgent" after somebody has accepted the only urgent finding is
 * a badge nobody can ever clear, and an uncleafable badge is ignored within a
 * week — the same disease as an alert list that only grows.
 */
export async function countOpenFindings(
  organizationId?: string | null
): Promise<FindingCounts> {
  const { rows } = await getPool().query<{
    urgent: string;
    warn: string;
    info: string;
    dismissed: string;
  }>(
    `select count(*) filter (where severity = 'urgent' and dismissed_at is null)::text as urgent,
            count(*) filter (where severity = 'warn'   and dismissed_at is null)::text as warn,
            count(*) filter (where severity = 'info'   and dismissed_at is null)::text as info,
            count(*) filter (where dismissed_at is not null)::text                     as dismissed
       from operator_findings f
      where f.resolved_at is null
        and ($1::uuid is null or ${FINDING_BUSINESS} = $1)`,
    [organizationId ?? null]
  );
  return {
    urgent: Number(rows[0]?.urgent ?? 0),
    warn: Number(rows[0]?.warn ?? 0),
    info: Number(rows[0]?.info ?? 0),
    dismissed: Number(rows[0]?.dismissed ?? 0),
  };
}

/**
 * A person accepts a finding, or takes the acceptance back.
 *
 * NOT A DELETE. The row stays, stays reconciled, and stays counted in its own
 * bucket. Deleting would lose the fact that somebody looked, and would also let
 * the very next sweep re-raise it as brand new — the upsert would insert rather
 * than update, first_seen_at would be now(), and the alert dispatcher would
 * treat it as a transition and tell somebody about a finding they had just
 * dismissed thirty seconds earlier.
 *
 * Scoped by the finding's OWNING organization, not the business it is about.
 * `${FINDING_BUSINESS}` resolves who a finding concerns for display, but the
 * row lives under the number owner's tenant and RLS is enforced on
 * organization_id — so an update filtered on the resolved business would match
 * zero rows and report success, which is instance ten of the defect this
 * codebase has met nine times. The caller wraps this in withServingTenant and
 * the predicate below stays on the owning column.
 *
 * Returns false when nothing matched, so the route can 404 rather than tell
 * somebody it worked.
 */
export async function setFindingDismissal(
  findingId: string,
  by: string | null,
  reason: string | null,
  horizonHours: number | null
): Promise<boolean> {
  // The interval is built from a NUMBER of hours, never from a string handed in
  // by a caller. `dismissalHorizon` is what turns a key into that number and it
  // refuses anything not on the menu, so there is no path from a request body
  // to this expression.
  const { rowCount } = await getPool().query(
    `update operator_findings
        set dismissed_at     = case when $2::text is null then null else now() end,
            dismissed_by     = $2,
            dismissed_reason = case when $2::text is null then null else $3 end,
            dismissed_until  = case
                                 when $2::text is null then null
                                 else now() + make_interval(hours => $4::int)
                               end,
            updated_at       = now()
      where id = $1
        and resolved_at is null`,
    [findingId, by, reason, horizonHours]
  );
  return (rowCount ?? 0) > 0;
}

/** Who owns a finding's row, and which business it is actually about. */
export interface FindingScope {
  /** The tenant the ROW lives under. RLS is enforced on this. */
  organizationId: string;
  /** The business the finding CONCERNS. Authorise on this. */
  businessId: string;
}

/**
 * The two organizations a finding has, which is the whole reason this exists.
 *
 * ============================================================
 * AUTHORISE ON ONE, WRITE IN THE OTHER
 * ============================================================
 *
 * All five firms answer on one WhatsApp number. A routed conversation is owned
 * by the number's owner, so a finding about Juris Prime's customer is a row
 * under Zipicka's tenant with serving_organization_id = Juris Prime. Juris
 * Prime's staff see it on their deck, correctly, because every read resolves
 * through coalesce(serving, owner).
 *
 * A dismissal has to go the other way. The row is under Zipicka, and RLS filters
 * on organization_id — so an update run in Juris Prime's transaction matches
 * ZERO ROWS AND REPORTS SUCCESS. The person clicks dismiss, the finding stays,
 * and nothing anywhere says why. That is instance ten of the defect this
 * codebase has met nine times, and it is why this returns both ids instead of
 * letting the route pick one and be right by luck.
 *
 * Read across tenants deliberately: which transaction to open is precisely the
 * question being asked, so it cannot be asked from inside one. It returns two
 * ids and nothing else — no title, no detail, no customer name — so somebody
 * probing for a finding they are not entitled to learns only that a row exists.
 */
export async function findingScope(findingId: string): Promise<FindingScope | null> {
  const { rows } = await getPool().query<{
    organization_id: string;
    business_id: string;
  }>(
    `select organization_id,
            coalesce(serving_organization_id, organization_id) as business_id
       from operator_findings
      where id = $1`,
    [findingId]
  );
  const row = rows[0];
  return row ? { organizationId: row.organization_id, businessId: row.business_id } : null;
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

/**
 * How many knowledge sources the whole platform tracks.
 *
 * SELF-WRAPPING, like listJobHeartbeats, and for the same reason: the caller is
 * an operator running inside one business's transaction, and the number it
 * needs is deliberately not that business's. Opening the cross-tenant scope
 * here rather than at the call site keeps the operator from nesting one scope
 * inside another, and makes the cross-tenant read a property of this function
 * that can be read once instead of a habit every caller has to remember.
 *
 * Used by knowledge-not-refreshing to say WHY a business's pages are ageing:
 * the sweep revisits a fixed number a day, so once the estate outgrows that,
 * the oldest pages age without limit and no single business can fix it.
 */
export async function countKnowledgeSourcesAcrossPlatform(): Promise<number> {
  return withAllTenants(
    "knowledge-not-refreshing: the estate is a platform-wide number by definition",
    async () => {
      const { rows } = await getPool().query<{ n: string }>(
        `select count(*)::text as n from knowledge_sources`
      );
      return Number(rows[0]?.n ?? 0);
    }
  );
}
