/**
 * Reading and writing automations, and recording every act exactly once.
 *
 * The judgement about what an automation MAY be lives in automation-rules.ts,
 * pure and tested. This is the part that talks to Postgres.
 */
import { getPool } from "./client.js";
import { automationRefusal, type AutomationSpec } from "./automation-rules.js";

export interface AutomationRecord {
  id: string;
  organizationId: string;
  businessName: string;
  triggerOperator: string;
  action: string;
  assigneeId: string | null;
  assigneeName: string | null;
  isActive: boolean;
  createdBy: string;
  createdAt: string;
  /** How many times this has acted. The only number that says whether it earns its keep. */
  timesRun: number;
  lastRanAt: string | null;
}

const SELECT = `
  select a.id, a.organization_id, o.name as business_name, a.trigger_operator, a.action,
         a.assignee_id, e.full_name as assignee_name, a.is_active, a.created_by, a.created_at,
         (select count(*) from automation_runs r where r.automation_id = a.id and r.failed_reason is null)::text as times_run,
         (select max(r.ran_at) from automation_runs r where r.automation_id = a.id) as last_ran_at
    from automations a
    join organizations o on o.id = a.organization_id
    left join employees e on e.id = a.assignee_id
`;

interface Row {
  id: string;
  organization_id: string;
  business_name: string;
  trigger_operator: string;
  action: string;
  assignee_id: string | null;
  assignee_name: string | null;
  is_active: boolean;
  created_by: string;
  created_at: string;
  times_run: string;
  last_ran_at: string | null;
}

const toAutomation = (row: Row): AutomationRecord => ({
  id: row.id,
  organizationId: row.organization_id,
  businessName: row.business_name,
  triggerOperator: row.trigger_operator,
  action: row.action,
  assigneeId: row.assignee_id,
  assigneeName: row.assignee_name,
  isActive: row.is_active,
  createdBy: row.created_by,
  createdAt: row.created_at,
  timesRun: Number(row.times_run ?? 0),
  lastRanAt: row.last_ran_at,
});

export async function listAutomations(organizationId?: string | null): Promise<AutomationRecord[]> {
  const { rows } = await getPool().query<Row>(
    `${SELECT}
      where ($1::uuid is null or a.organization_id = $1)
      order by o.name asc, a.created_at asc`,
    [organizationId ?? null]
  );
  return rows.map(toAutomation);
}

/** Every active automation, for the sweep. Cross-tenant by design — see the runner. */
export async function listActiveAutomationsForRun(organizationId: string): Promise<AutomationRecord[]> {
  const { rows } = await getPool().query<Row>(
    `${SELECT} where a.organization_id = $1 and a.is_active order by a.created_at asc`,
    [organizationId]
  );
  return rows.map(toAutomation);
}

export async function createAutomation(input: {
  organizationId: string;
  triggerOperator: string;
  action: string;
  assigneeId: string | null;
  createdBy: string;
}): Promise<AutomationRecord> {
  // The rules refuse first, so a nonsense pair never reaches the unique index
  // and comes back as a constraint error nobody can read.
  const refusal = automationRefusal(input as AutomationSpec);
  if (refusal) throw new Error(refusal.reason);

  if (input.assigneeId) {
    // The same cross-business check createTask and assignTask both make, for
    // the same reason: an automation that assigns to somebody at another
    // company would produce work in a diary that is not theirs, and it would
    // read as ordinary.
    const { rows } = await getPool().query<{ n: string }>(
      `select count(*)::text as n from employees
        where id = $1 and organization_id = $2 and is_active = true`,
      [input.assigneeId, input.organizationId]
    );
    if (Number(rows[0]?.n ?? 0) !== 1) {
      throw new Error("That person does not work for this business, so work cannot be assigned to them.");
    }
  }

  const { rows } = await getPool().query<{ id: string }>(
    `insert into automations (organization_id, trigger_operator, action, assignee_id, created_by)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [input.organizationId, input.triggerOperator, input.action, input.assigneeId, input.createdBy]
  );

  const created = await listAutomations(input.organizationId);
  const found = created.find((a) => a.id === rows[0].id);
  if (!found) throw new Error("The automation was created and could not be read back.");
  return found;
}

export async function setAutomationActive(
  organizationId: string,
  id: string,
  isActive: boolean
): Promise<AutomationRecord | null> {
  const { rows } = await getPool().query<{ id: string }>(
    `update automations set is_active = $3, updated_at = now()
      where id = $2 and organization_id = $1 and is_active <> $3
      returning id`,
    [organizationId, id, isActive]
  );
  if (!rows[0]) return null;
  return (await listAutomations(organizationId)).find((a) => a.id === id) ?? null;
}

export async function deleteAutomation(organizationId: string, id: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `delete from automations where id = $2 and organization_id = $1`,
    [organizationId, id]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Claim this finding for this automation, or discover somebody already did.
 *
 * THE IDEMPOTENCY, and it is a claim rather than a check because the check
 * version has a race in it: two sweeps overlapping would both read "no run
 * yet", both act, and both insert. `on conflict do nothing` makes the database
 * decide, and the caller acts only if it won.
 *
 * Written BEFORE the action, deliberately. If the process dies between the
 * claim and the act, the finding is not retried — which is the safe direction
 * here for the same reason the reply path's is: this platform can see a
 * follow-up that was never assigned, because unowned-followup is still standing
 * and will say so on the next sweep. It cannot see one assigned twice.
 */
export async function claimFinding(
  automationId: string,
  findingId: string,
  organizationId: string,
  action: string,
  subject: { kind: string | null; id: string | null }
): Promise<string | null> {
  const { rows } = await getPool().query<{ id: string }>(
    `insert into automation_runs (automation_id, finding_id, organization_id, action, subject_kind, subject_id)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (automation_id, finding_id) do nothing
     returning id`,
    [automationId, findingId, organizationId, action, subject.kind, subject.id]
  );
  return rows[0]?.id ?? null;
}

/** Record that a claimed act failed. The claim stands, so it is not retried. */
export async function recordAutomationFailure(runId: string, reason: string): Promise<void> {
  await getPool().query(`update automation_runs set failed_reason = $2 where id = $1`, [
    runId,
    reason.slice(0, 500),
  ]);
}

export interface AutomationRun {
  id: string;
  automationId: string;
  action: string;
  subjectKind: string | null;
  subjectId: string | null;
  failedReason: string | null;
  ranAt: string;
}

/** What the automations have actually done, newest first. The audit trail. */
export async function listAutomationRuns(
  organizationId: string,
  limit = 50
): Promise<AutomationRun[]> {
  const { rows } = await getPool().query<{
    id: string;
    automation_id: string;
    action: string;
    subject_kind: string | null;
    subject_id: string | null;
    failed_reason: string | null;
    ran_at: string;
  }>(
    `select id, automation_id, action, subject_kind, subject_id, failed_reason, ran_at
       from automation_runs
      where organization_id = $1
      order by ran_at desc
      limit $2`,
    [organizationId, limit]
  );
  return rows.map((row) => ({
    id: row.id,
    automationId: row.automation_id,
    action: row.action,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    failedReason: row.failed_reason,
    ranAt: row.ran_at,
  }));
}
