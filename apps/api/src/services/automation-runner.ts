/**
 * The hands. The operators are the eyes and stay the only pair.
 *
 * ============================================================
 * WHY IT READS THE DATABASE RATHER THAN THE SWEEP'S OWN LIST
 * ============================================================
 *
 * `runOperators` already collects `raisedThisSweep`, and passing that here would
 * be the obvious wiring. It would also quietly break a decision this repository
 * made on purpose: `RaisedFinding` "deliberately carries no title and no
 * subject", because a finding's title names a customer — "Ahmed has been waiting
 * three hours" — and that list is built for dispatch to somewhere OUTSIDE the
 * platform. Widening it so the automations could read the subject would put
 * customer names into the payload that leaves the building.
 *
 * So the runner reads the findings itself, scoped to one business, from inside
 * that business's transaction. Same facts, no new door.
 *
 * ============================================================
 * WHAT IT WILL NOT DO
 * ============================================================
 *
 * Speak to a customer. Both actions are things a colleague does — give somebody
 * the work, or write the work down — and the boundary is enforced by the shape
 * rather than by care: `AUTOMATION_ACTIONS` has two entries, and the pairs an
 * action may react to are an allow-list.
 *
 * It also never acts twice on one finding. A finding STANDS until it stops being
 * true, so it is present in six sweeps an hour; an automation acting on presence
 * would assign the same task six times before lunch. The claim is written to
 * `automation_runs` before the act, and only the writer that won the insert
 * proceeds.
 */
import {
  assignTask,
  automationActsOn,
  claimFinding,
  createTask,
  listActiveAutomationsForRun,
  listOpenFindings,
  recordAutomationFailure,
  withTenant,
  type AutomationRecord,
} from "@nexus/db";
import { logger } from "../lib/logger.js";

export interface AutomationOutcome {
  automationId: string;
  action: string;
  findingId: string;
  subjectId: string | null;
  ok: boolean;
  detail: string;
}

async function perform(
  automation: AutomationRecord,
  finding: { id: string; subjectId: string | null; title: string },
  organizationId: string
): Promise<string> {
  if (automation.action === "assign_followup") {
    if (!automation.assigneeId) throw new Error("this automation has nobody to assign to");
    const task = await assignTask(finding.subjectId as string, automation.assigneeId, organizationId);
    if (!task) throw new Error("that follow-up is no longer available to assign");
    return `assigned to ${automation.assigneeName ?? "somebody"}`;
  }

  if (automation.action === "create_followup") {
    // Unowned on purpose. A commitment somebody has to pick up is the honest
    // state, and unowned-followup will say so if nobody does — which is the
    // layer above this doing its job rather than a gap in this one.
    //
    // The title says what happened and does NOT quote the finding, whose own
    // title names the customer. This row is going onto a board that the
    // business reads, so a name would be fine here — but a follow-up whose
    // title is a sentence about waiting is more useful than one that repeats an
    // alarm, and the conversation is linked either way.
    await createTask({
      organizationId,
      conversationId: finding.subjectId,
      employeeId: null,
      title: "Reply to this conversation",
      notes: `Raised automatically because ${automation.triggerOperator.replace(/-/g, " ")} reported it.`,
      dueAt: null,
    });
    return "wrote a follow-up";
  }

  throw new Error(`unknown action "${automation.action}"`);
}

/**
 * Apply one business's automations to what is currently true of it.
 *
 * Returns what happened, for the caller to log. Failures are recorded against
 * the claim and NOT retried: an automation that cannot assign because the person
 * has left will not start working in ten minutes, and retrying would write the
 * same sentence into the log six times an hour.
 */
export async function runAutomationsFor(organizationId: string): Promise<AutomationOutcome[]> {
  return withTenant(organizationId, async () => {
    const automations = await listActiveAutomationsForRun(organizationId);
    if (automations.length === 0) return [];

    const findings = await listOpenFindings(organizationId);
    const outcomes: AutomationOutcome[] = [];

    for (const automation of automations) {
      for (const finding of findings) {
        if (
          !automationActsOn(
            {
              action: automation.action,
              triggerOperator: automation.triggerOperator,
              assigneeId: automation.assigneeId,
              isActive: automation.isActive,
            },
            finding
          )
        ) {
          continue;
        }

        // The claim comes first, and losing it is the normal case rather than a
        // problem: it means this finding has already been acted on, which is
        // exactly what should happen on the second of six sweeps an hour.
        const runId = await claimFinding(automation.id, finding.id, organizationId, automation.action, {
          kind: finding.subjectKind,
          id: finding.subjectId,
        });
        if (!runId) continue;

        try {
          const detail = await perform(automation, finding, organizationId);
          outcomes.push({
            automationId: automation.id,
            action: automation.action,
            findingId: finding.id,
            subjectId: finding.subjectId,
            ok: true,
            detail,
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          await recordAutomationFailure(runId, reason).catch(() => undefined);
          outcomes.push({
            automationId: automation.id,
            action: automation.action,
            findingId: finding.id,
            subjectId: finding.subjectId,
            ok: false,
            detail: reason,
          });
        }
      }
    }

    return outcomes;
  });
}

/** Every business, after the sweep. One business's failure must not stop the rest. */
export async function runAutomations(organizationIds: string[]): Promise<AutomationOutcome[]> {
  const all: AutomationOutcome[] = [];
  for (const organizationId of organizationIds) {
    try {
      const outcomes = await runAutomationsFor(organizationId);
      all.push(...outcomes);
      for (const outcome of outcomes) {
        logger[outcome.ok ? "info" : "warn"](
          { organizationId, action: outcome.action, subjectId: outcome.subjectId, detail: outcome.detail },
          outcome.ok ? "An automation acted" : "An automation could not act, and will not retry this finding"
        );
      }
    } catch (err) {
      logger.error({ organizationId, err }, "Automations failed for this business — the findings stand");
    }
  }
  return all;
}
