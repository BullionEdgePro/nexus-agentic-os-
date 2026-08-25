/**
 * Storing what a lead turned out to be.
 *
 * Beside persist.ts and for the same reason it is separate from the scorer:
 * the assessment is what this platform decided, and a label is what a person
 * decided about that. Keeping the two apart is what makes the second usable as
 * evidence about the first.
 */
import { getPool } from "@nexus/db";
import { scorerAccuracy, type LabelledAssessment, type ScorerAccuracy } from "./accuracy.js";

export interface LeadLabelInput {
  organizationId: string;
  assessmentId: string;
  worthAttention: boolean;
  outcome: string | null;
  note: string | null;
  labelledBy: string;
}

/**
 * Record or replace a label.
 *
 * Scoped on organization_id in the WHERE of the conflict path as well as the
 * insert, so a mistyped assessment id cannot label another business's lead --
 * RLS would already stop it, and this makes the intent readable without
 * knowing that.
 */
export async function recordLeadLabel(input: LeadLabelInput): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `insert into lead_labels
       (organization_id, assessment_id, worth_attention, outcome, note, labelled_by)
     select $1, a.id, $3, $4, $5, $6
       from lead_assessments a
      where a.id = $2 and a.organization_id = $1
     on conflict (assessment_id) do update
        set worth_attention = excluded.worth_attention,
            outcome         = excluded.outcome,
            note            = excluded.note,
            labelled_by     = excluded.labelled_by,
            updated_at      = now()`,
    [
      input.organizationId,
      input.assessmentId,
      input.worthAttention,
      input.outcome,
      input.note,
      input.labelledBy,
    ]
  );
  // Zero rows means the assessment does not exist, or belongs to somebody else.
  // The caller turns both into the same 404 rather than distinguishing them.
  return (rowCount ?? 0) > 0;
}

/** Labels already given, keyed by assessment, so a list can show its own state. */
export async function labelsForAssessments(
  organizationId: string,
  assessmentIds: readonly string[]
): Promise<Map<string, { worthAttention: boolean; outcome: string | null; labelledBy: string }>> {
  if (assessmentIds.length === 0) return new Map();
  const { rows } = await getPool().query<{
    assessment_id: string;
    worth_attention: boolean;
    outcome: string | null;
    labelled_by: string;
  }>(
    `select assessment_id, worth_attention, outcome, labelled_by
       from lead_labels
      where organization_id = $1 and assessment_id = any($2::uuid[])`,
    [organizationId, assessmentIds as string[]]
  );
  return new Map(
    rows.map((r) => [
      r.assessment_id,
      { worthAttention: r.worth_attention, outcome: r.outcome, labelledBy: r.labelled_by },
    ])
  );
}

/**
 * How the scorer has actually been doing, for one business.
 *
 * The maths is pure and lives in accuracy.ts; this only fetches the pairs. That
 * split is what lets the refusal be tested without a database, which matters
 * because the refusal is the part that must not quietly stop working.
 */
export async function leadScorerAccuracy(organizationId: string): Promise<ScorerAccuracy> {
  const { rows } = await getPool().query<{ priority: string; worth_attention: boolean }>(
    `select a.priority, l.worth_attention
       from lead_labels l
       join lead_assessments a on a.id = l.assessment_id
      where l.organization_id = $1`,
    [organizationId]
  );
  const labels: LabelledAssessment[] = rows.map((r) => ({
    priority: r.priority,
    worthAttention: r.worth_attention,
  }));
  return scorerAccuracy(labels);
}
