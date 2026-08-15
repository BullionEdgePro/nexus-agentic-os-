import { getPool } from "./client.js";
import {
  parseProcedureSteps,
  procedureStepsEqual,
  type ProcedureStep,
} from "@nexus/shared";

/**
 * Procedural memory (F10) — storage and review.
 *
 * A procedure is how a business works through a kind of enquiry: establish
 * which document, then which country, then quote, then offer a booking. It is
 * not what the business knows — that is `knowledge_chunks` — and the difference
 * is worth keeping in mind while reading this file, because the two look alike
 * and only one of them changes the SHAPE of a reply.
 *
 * Read migration 033 for why these rows never leave their business, and 034 for
 * why an active procedure's steps are frozen against the nightly writer.
 *
 * EVERY FUNCTION HERE ASSUMES A TENANT CONTEXT. `procedures` is in
 * TENANT_SCOPED_TABLES, so under DB_TENANT_ASSERT=strict an unwrapped call
 * throws rather than quietly reading nothing. Callers are the route (scoped by
 * the /api/organizations/:slug middleware) and the writer (its own withTenant).
 */

export type ProcedureSource = "operator" | "inferred";

export interface ProcedureRecord {
  id: string;
  organizationId: string;
  businessName: string;
  intentCategory: string;
  language: string;
  /** What the agent would follow. Frozen against the writer while active. */
  steps: ProcedureStep[];
  /** A newer inference waiting for a human. Null when there is nothing to consider. */
  proposedSteps: ProcedureStep[] | null;
  proposedAt: string | null;
  source: ProcedureSource;
  /** How many well-handled conversations this was drawn from. */
  derivedFromCount: number;
  timesApplied: number;
  timesSucceeded: number;
  isActive: boolean;
  lastInferredAt: string | null;
  dismissedAt: string | null;
  dismissedEvidence: number | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProcedureRow {
  id: string;
  organization_id: string;
  business_name: string;
  intent_category: string;
  language: string;
  steps: unknown;
  proposed_steps: unknown;
  proposed_at: string | null;
  source: ProcedureSource;
  derived_from_count: number;
  times_applied: number;
  times_succeeded: number;
  is_active: boolean;
  last_inferred_at: string | null;
  dismissed_at: string | null;
  dismissed_evidence: number | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Steps read back from jsonb, tolerantly.
 *
 * A row whose steps no longer parse is a row nobody can act on, and throwing
 * here would take the whole review screen down over one bad record — the one
 * place a person could have gone to fix it. So it degrades to a single visible
 * step saying so, which is the honest rendering of "stored, unreadable".
 */
function readSteps(value: unknown): ProcedureStep[] {
  const parsed = parseProcedureSteps(value);
  if (parsed.ok) return parsed.steps;
  return [{ text: "(this procedure was stored in a shape this version cannot read)" }];
}

const toProcedure = (row: ProcedureRow): ProcedureRecord => ({
  id: row.id,
  organizationId: row.organization_id,
  businessName: row.business_name,
  intentCategory: row.intent_category,
  language: row.language,
  steps: readSteps(row.steps),
  proposedSteps: row.proposed_steps === null ? null : readSteps(row.proposed_steps),
  proposedAt: row.proposed_at,
  source: row.source,
  derivedFromCount: row.derived_from_count,
  timesApplied: row.times_applied,
  timesSucceeded: row.times_succeeded,
  isActive: row.is_active,
  lastInferredAt: row.last_inferred_at,
  dismissedAt: row.dismissed_at,
  dismissedEvidence: row.dismissed_evidence,
  reviewedAt: row.reviewed_at,
  reviewedBy: row.reviewed_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const PROCEDURE_SELECT = `
  select p.id, p.organization_id,
         o.name as business_name,
         p.intent_category, p.language, p.steps, p.proposed_steps, p.proposed_at,
         p.source, p.derived_from_count, p.times_applied, p.times_succeeded,
         p.is_active, p.last_inferred_at, p.dismissed_at, p.dismissed_evidence,
         p.reviewed_at, p.reviewed_by, p.created_at, p.updated_at
    from procedures p
    join organizations o on o.id = p.organization_id
`;

/**
 * Everything stored for one business, in the order a reviewer should meet it.
 *
 * Active first — those are shaping replies right now and are the only rows with
 * consequences. Then whatever has a proposal outstanding, because that is the
 * decision actually waiting on somebody. Then drafts by weight of evidence.
 */
export async function listProcedures(organizationId: string): Promise<ProcedureRecord[]> {
  const { rows } = await getPool().query<ProcedureRow>(
    `${PROCEDURE_SELECT}
      where p.organization_id = $1
      order by p.is_active desc,
               (p.proposed_steps is not null) desc,
               p.derived_from_count desc,
               p.intent_category asc`,
    [organizationId]
  );
  return rows.map(toProcedure);
}

export async function getProcedure(
  organizationId: string,
  id: string
): Promise<ProcedureRecord | null> {
  const { rows } = await getPool().query<ProcedureRow>(
    `${PROCEDURE_SELECT} where p.organization_id = $1 and p.id = $2`,
    [organizationId, id]
  );
  return rows[0] ? toProcedure(rows[0]) : null;
}

/**
 * The procedure the agent should follow for this situation, or null.
 *
 * THE ONE FUNCTION HERE THAT RUNS ON THE LIVE REPLY PATH, which changes what it
 * is allowed to do. It takes a single indexed read and returns null for almost
 * every call — most businesses have no procedures and most enquiries have no
 * active one — so the common case costs one query that finds nothing.
 *
 * Active only. A draft is a suggestion nobody has agreed to, and this is the
 * function that would turn one into a customer's reply.
 *
 * Scoped to one business by argument AND by the caller's tenant context. On a
 * shared number the reply is composed for the SERVING business, so the caller
 * must wrap this in `withServingTenant` — read as the number's owner, RLS
 * returns nothing and the agent silently answers with no procedure at all,
 * which is indistinguishable from "this business has none".
 */
export async function getActiveProcedure(
  organizationId: string,
  intentCategory: string,
  language = "en"
): Promise<ProcedureRecord | null> {
  const { rows } = await getPool().query<ProcedureRow>(
    `${PROCEDURE_SELECT}
      where p.organization_id = $1
        and p.intent_category = $2
        and p.language = $3
        and p.is_active
      limit 1`,
    [organizationId, intentCategory, language]
  );
  return rows[0] ? toProcedure(rows[0]) : null;
}

export interface ProcedureCounts {
  /** Shaping replies right now. */
  active: number;
  /** Written and waiting, shaping nothing. */
  drafts: number;
  /** Active procedures with a newer suggestion a person has not ruled on. */
  proposals: number;
}

export async function countProcedures(organizationId: string): Promise<ProcedureCounts> {
  const { rows } = await getPool().query<{ active: string; drafts: string; proposals: string }>(
    `select count(*) filter (where is_active)::text                        as active,
            count(*) filter (where not is_active)::text                    as drafts,
            count(*) filter (where proposed_steps is not null)::text       as proposals
       from procedures
      where organization_id = $1`,
    [organizationId]
  );
  return {
    active: Number(rows[0]?.active ?? 0),
    drafts: Number(rows[0]?.drafts ?? 0),
    proposals: Number(rows[0]?.proposals ?? 0),
  };
}

/**
 * How much the evidence must grow before a dismissed suggestion may return.
 *
 * Doubled, not "a bit more". Somebody looked at this and said no; coming back
 * with 6 conversations instead of 5 is the same suggestion with a rounding
 * error attached, and a screen that does that trains its reader to dismiss
 * without reading — which is the state the operator deck was explicitly built
 * to avoid (migration 027).
 */
export const MIN_EVIDENCE_GROWTH_AFTER_DISMISSAL = 2;

export interface InferredProcedureInput {
  organizationId: string;
  intentCategory: string;
  language: string;
  steps: ProcedureStep[];
  /** Well-handled conversations behind this inference. */
  derivedFromCount: number;
}

/**
 * What the writer did, in the writer's own words.
 *
 * Returned rather than logged, so the caller can report a run honestly. "Wrote
 * 4 procedures" when three of them were unchanged re-statements of yesterday is
 * the kind of plausible wrong number this codebase keeps finding.
 */
export type InferenceOutcome =
  | "created"
  | "redrafted"
  | "proposed"
  | "unchanged"
  | "held-back"
  | "deferred-to-operator";

export interface InferenceWrite {
  outcome: InferenceOutcome;
  procedureId: string | null;
  /** Plain-language reason, present when nothing was written. */
  note?: string;
}

/**
 * Record one inference for one (business, intent, language).
 *
 * THE FOUR RULES THIS FUNCTION EXISTS TO KEEP, each of which is a way the
 * nightly writer could otherwise do damage while looking like it worked:
 *
 *   1. It never activates anything. `is_active` defaults to false in migration
 *      033 and is not touched here. A procedure changes how a business answers
 *      its customers; that is a person's decision, and a writer that could make
 *      it would make it 365 times a year unsupervised.
 *
 *   2. It never edits an ACTIVE procedure's steps. The newer inference goes to
 *      `proposed_steps` instead. Otherwise a procedure somebody read and
 *      approved would silently become a different one.
 *
 *   3. It defers to a person. If an operator-written procedure is active for
 *      this situation, the writer says nothing at all — 033's own argument, that
 *      conflating inferred with authoritative "would let a pattern the system
 *      invented outrank an instruction a person gave it", applied to the nagging
 *      as well as to the ranking.
 *
 *   4. It respects a refusal, until the evidence genuinely moves. See
 *      MIN_EVIDENCE_GROWTH_AFTER_DISMISSAL.
 *
 * Read-then-write, which is safe here for a reason worth stating rather than
 * assuming: the caller runs inside `withTenant`, so this is one transaction on
 * one connection, and the unique index from migration 034 is what catches the
 * case where two runs somehow overlap anyway.
 */
export async function upsertInferredProcedure(
  input: InferredProcedureInput
): Promise<InferenceWrite> {
  const { rows: existing } = await getPool().query<ProcedureRow>(
    `${PROCEDURE_SELECT}
      where p.organization_id = $1
        and p.intent_category = $2
        and p.language = $3`,
    [input.organizationId, input.intentCategory, input.language]
  );

  const rows = existing.map(toProcedure);

  // Rule 3.
  const authoritative = rows.find((row) => row.source === "operator" && row.isActive);
  if (authoritative) {
    return {
      outcome: "deferred-to-operator",
      procedureId: authoritative.id,
      note: "someone has written this one themselves",
    };
  }

  const inferred = rows.find((row) => row.source === "inferred");

  if (!inferred) {
    const { rows: created } = await getPool().query<{ id: string }>(
      `insert into procedures
         (organization_id, intent_category, language, steps, source,
          derived_from_count, last_inferred_at)
       values ($1, $2, $3, $4::jsonb, 'inferred', $5, now())
       returning id`,
      [
        input.organizationId,
        input.intentCategory,
        input.language,
        JSON.stringify(input.steps),
        input.derivedFromCount,
      ]
    );
    return { outcome: "created", procedureId: created[0]?.id ?? null };
  }

  // Rule 4.
  if (inferred.dismissedAt) {
    const threshold = (inferred.dismissedEvidence ?? 0) * MIN_EVIDENCE_GROWTH_AFTER_DISMISSAL;
    if (input.derivedFromCount < Math.max(threshold, 1)) {
      // The evidence count is still refreshed. It is a measurement, not a
      // suggestion, and letting it go stale would make the screen understate
      // how much the writer had seen when somebody comes back to reconsider.
      await getPool().query(
        `update procedures
            set derived_from_count = $2, last_inferred_at = now(), updated_at = now()
          where id = $1`,
        [inferred.id, input.derivedFromCount]
      );
      return {
        outcome: "held-back",
        procedureId: inferred.id,
        note: `dismissed at ${inferred.dismissedEvidence ?? 0} conversations; needs ${Math.max(
          threshold,
          1
        )} before asking again`,
      };
    }
  }

  const unchanged = procedureStepsEqual(inferred.steps, input.steps);

  // Rule 2 — active rows take a proposal, never an edit.
  if (inferred.isActive) {
    if (unchanged) {
      await getPool().query(
        `update procedures
            set derived_from_count = $2, last_inferred_at = now(), updated_at = now()
          where id = $1`,
        [inferred.id, input.derivedFromCount]
      );
      return { outcome: "unchanged", procedureId: inferred.id };
    }

    // An identical proposal already sitting there is not news either. Restamping
    // `proposed_at` nightly would make a suggestion from three weeks ago read as
    // this morning's.
    if (inferred.proposedSteps && procedureStepsEqual(inferred.proposedSteps, input.steps)) {
      await getPool().query(
        `update procedures
            set derived_from_count = $2, last_inferred_at = now(), updated_at = now()
          where id = $1`,
        [inferred.id, input.derivedFromCount]
      );
      return { outcome: "unchanged", procedureId: inferred.id };
    }

    await getPool().query(
      `update procedures
          set proposed_steps = $2::jsonb,
              proposed_at = now(),
              derived_from_count = $3,
              last_inferred_at = now(),
              updated_at = now()
        where id = $1`,
      [inferred.id, JSON.stringify(input.steps), input.derivedFromCount]
    );
    return { outcome: "proposed", procedureId: inferred.id };
  }

  // Inactive draft: nothing is following it, so it can simply be rewritten.
  await getPool().query(
    `update procedures
        set steps = $2::jsonb,
            derived_from_count = $3,
            last_inferred_at = now(),
            -- A redraft is a different suggestion from the one that was turned
            -- down, so the refusal no longer applies to it. Reaching here at all
            -- means the evidence had already grown past the threshold.
            dismissed_at = null,
            dismissed_evidence = null,
            updated_at = now()
      where id = $1`,
    [inferred.id, JSON.stringify(input.steps), input.derivedFromCount]
  );
  return { outcome: unchanged ? "unchanged" : "redrafted", procedureId: inferred.id };
}

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * Turn a procedure on or off.
 *
 * The 033 index allows one active procedure per (business, intent, language),
 * so switching one on while another is live is refused BY THE DATABASE. Caught
 * and turned into a sentence, because the alternative is a 500 on a button
 * press whose real meaning — "you already have one of these" — is knowable and
 * fixable in one click.
 */
export async function setProcedureActive(
  organizationId: string,
  id: string,
  isActive: boolean,
  reviewedBy: string
): Promise<ProcedureRecord | null> {
  try {
    const { rows } = await getPool().query<{ id: string }>(
      `update procedures
          set is_active = $3,
              reviewed_at = now(),
              reviewed_by = $4,
              updated_at = now()
        where organization_id = $1
          and id = $2
          and is_active <> $3
        returning id`,
      [organizationId, id, isActive, reviewedBy]
    );
    if (!rows[0]) return null;
    return getProcedure(organizationId, id);
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
      throw new Error(
        "Another procedure for this kind of enquiry is already active. Turn that one off first — " +
          "two active procedures for one situation is a coin toss the customer cannot see."
      );
    }
    throw err;
  }
}

/**
 * Replace the steps by hand.
 *
 * THIS CHANGES `source` TO 'operator', and that is the substantive part rather
 * than bookkeeping. Migration 033 draws the line between a procedure a person
 * gave the system and one the system inferred; an inferred draft a person has
 * rewritten is, from that moment, the person's. Leaving it labelled 'inferred'
 * would mean the nightly writer felt free to propose over the top of somebody's
 * own words, and the screen would keep calling their method a suggestion.
 *
 * Any outstanding proposal is dropped: it was a suggested revision to text that
 * no longer exists.
 */
export async function replaceProcedureSteps(
  organizationId: string,
  id: string,
  steps: ProcedureStep[],
  reviewedBy: string
): Promise<ProcedureRecord | null> {
  const { rows } = await getPool().query<{ id: string }>(
    `update procedures
        set steps = $3::jsonb,
            source = 'operator',
            proposed_steps = null,
            proposed_at = null,
            dismissed_at = null,
            dismissed_evidence = null,
            reviewed_at = now(),
            reviewed_by = $4,
            updated_at = now()
      where organization_id = $1 and id = $2
      returning id`,
    [organizationId, id, JSON.stringify(steps), reviewedBy]
  );
  if (!rows[0]) return null;
  return getProcedure(organizationId, id);
}

/** Adopt the suggested revision as the procedure the agent follows. */
export async function acceptProposal(
  organizationId: string,
  id: string,
  reviewedBy: string
): Promise<ProcedureRecord | null> {
  const { rows } = await getPool().query<{ id: string }>(
    `update procedures
        set steps = proposed_steps,
            proposed_steps = null,
            proposed_at = null,
            -- Accepting settles the earlier refusal too: this is the text the
            -- reviewer chose, so nothing is being held back any more.
            dismissed_at = null,
            dismissed_evidence = null,
            reviewed_at = now(),
            reviewed_by = $3,
            updated_at = now()
      where organization_id = $1
        and id = $2
        and proposed_steps is not null
      returning id`,
    [organizationId, id, reviewedBy]
  );
  if (!rows[0]) return null;
  return getProcedure(organizationId, id);
}

/**
 * Turn a suggestion down.
 *
 * Records WHAT WAS REFUSED AND ON WHAT EVIDENCE, not merely that a refusal
 * happened. `dismissed_evidence` is what lets the writer stay quiet until the
 * case is materially stronger; a timestamp alone would bring the same rejected
 * draft back on a schedule, which is how a review queue becomes wallpaper.
 *
 * Nothing is deleted. A dismissed draft is still the record of what the system
 * thought this business did, and the evidence behind it is still true.
 */
export async function dismissProcedureSuggestion(
  organizationId: string,
  id: string,
  reviewedBy: string
): Promise<ProcedureRecord | null> {
  const { rows } = await getPool().query<{ id: string }>(
    `update procedures
        set proposed_steps = null,
            proposed_at = null,
            dismissed_at = now(),
            dismissed_evidence = derived_from_count,
            reviewed_at = now(),
            reviewed_by = $3,
            updated_at = now()
      where organization_id = $1
        and id = $2
        -- An active procedure with no proposal has nothing to dismiss; turning
        -- it off is a different action with a different button.
        and (proposed_steps is not null or not is_active)
      returning id`,
    [organizationId, id, reviewedBy]
  );
  if (!rows[0]) return null;
  return getProcedure(organizationId, id);
}

/**
 * Recompute `times_applied` and `times_succeeded` from what was actually
 * stamped on the metric rows.
 *
 * RECOMPUTED, NEVER INCREMENTED. The reply path records one fact — this
 * procedure shaped this reply (migration 036) — and these two numbers are read
 * back out of it. A counter bumped from the reply path could not be
 * recomputed, could not be audited back to the conversations behind it, and
 * would drift the first time a job retried. Same argument as the quality
 * rollups, which is why this runs on the same cycle as them.
 *
 * WHAT `times_succeeded` HONESTLY MEANS, and it is not success.
 *
 * It counts conversations where the procedure was applied, no colleague joined,
 * and the customer wrote again after the agent's reply. That is the same
 * evidence the inference writer learns from, and it has the same hole: a
 * customer who gave up leaves silence, and so does one who was helped. The
 * column was named `times_succeeded` in migration 033 before there was a writer
 * to define it; the name is kept because renaming a column is not worth a
 * migration, but NOTHING IN THE UI IS ALLOWED TO CALL IT SUCCESS. The review
 * screen says "ended without a human", which is the measurable thing.
 *
 * Per CONVERSATION, not per reply. A chatty exchange where the agent answered
 * six times is one conversation the procedure was used on, and counting it as
 * six would make talkative customers look like proof.
 */
export async function rollUpProcedureOutcomes(organizationId: string): Promise<number> {
  const { rowCount } = await getPool().query(
    `with applied as (
       -- One row per (procedure, conversation), collapsing repeat replies.
       select distinct cm.procedure_id, cm.conversation_id
         from conversation_metrics cm
        where cm.organization_id = $1
          and cm.procedure_id is not null
     ),
     shape as (
       -- The same bar the inference writer uses, computed the same way: no
       -- human in the conversation at all, and the customer came back after the
       -- agent had answered. Aggregated separately from the CTE above and
       -- joined on conversation_id, because joining messages into that query
       -- would fan out and multiply every count.
       select m.conversation_id,
              count(*) filter (where m.sender_type = 'human_agent') as human,
              max(m.created_at) filter (where m.sender_type = 'contact')  as last_in,
              min(m.created_at) filter (where m.sender_type = 'ai_agent') as first_ai
         from messages m
        where m.organization_id = $1
        group by m.conversation_id
     ),
     tally as (
       select a.procedure_id,
              count(*)                                        as applied,
              count(*) filter (
                where s.human = 0 and s.last_in > s.first_ai
              )                                               as contained
         from applied a
         -- LEFT, so the two numbers answer two different questions. "Applied"
         -- is true the moment the procedure shaped a reply and must not depend
         -- on the conversation's later shape; only "contained" does. An inner
         -- join would silently drop a conversation whose messages could not be
         -- read and quietly shrink the denominator — which is the same bias
         -- migration 036 refuses on the escalation side.
         left join shape s on s.conversation_id = a.conversation_id
        group by a.procedure_id
     )
     update procedures p
        set times_applied   = coalesce(t.applied, 0),
            times_succeeded = coalesce(t.contained, 0),
            updated_at      = now()
       from (
         -- LEFT-joined against every procedure of this business, so one that
         -- stops being used falls back to zero rather than keeping the number
         -- it had when it was last applied. A stale count that only ever rises
         -- is the failure this whole function is written around.
         select p2.id, t2.applied, t2.contained
           from procedures p2
           left join tally t2 on t2.procedure_id = p2.id
          where p2.organization_id = $1
       ) t
      where p.id = t.id
        and (p.times_applied, p.times_succeeded)
            is distinct from (coalesce(t.applied, 0), coalesce(t.contained, 0))`,
    [organizationId]
  );
  return rowCount ?? 0;
}

export interface OperatorProcedureInput {
  organizationId: string;
  intentCategory: string;
  language: string;
  steps: ProcedureStep[];
  activate: boolean;
  reviewedBy: string;
}

/**
 * Write one by hand.
 *
 * The review screen would be a weaker thing without this. Given only accept and
 * reject, a person who knows the right answer has no way to say it — they can
 * only wait for the machine to guess it. And an operator-written procedure is
 * the authoritative kind by 033's own definition, so this is the better half of
 * the feature, not a convenience bolted onto it.
 */
export async function createOperatorProcedure(
  input: OperatorProcedureInput
): Promise<ProcedureRecord> {
  try {
    const { rows } = await getPool().query<{ id: string }>(
      `insert into procedures
         (organization_id, intent_category, language, steps, source, is_active,
          reviewed_at, reviewed_by)
       values ($1, $2, $3, $4::jsonb, 'operator', $5, now(), $6)
       returning id`,
      [
        input.organizationId,
        input.intentCategory,
        input.language,
        JSON.stringify(input.steps),
        input.activate,
        input.reviewedBy,
      ]
    );
    const created = await getProcedure(input.organizationId, rows[0].id);
    if (!created) throw new Error("The procedure was written but could not be read back.");
    return created;
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
      throw new Error(
        "There is already an active procedure for this kind of enquiry. Turn that one off first."
      );
    }
    throw err;
  }
}
