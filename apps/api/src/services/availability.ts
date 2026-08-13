import { listEmployees, withTenant } from "@nexus/db";
import { resolvePresence } from "@nexus/employees";
import { logger } from "../lib/logger.js";

/**
 * Is there actually somebody who could pick this conversation up right now?
 *
 * TWO PARTS OF THE SYSTEM WERE ANSWERING THIS QUESTION DIFFERENTLY, and the one
 * that fired was the one that did not check.
 *
 * `hasActiveEmployees()` is plain SQL — `is_active = true`, nothing else.
 * Escalation asked that, so the moment a name existed on a rota the agent began
 * telling customers "a specialist is following up" and pausing itself on the
 * conversation. Meanwhile `resolvePresence()` reads the same employee's working
 * hours and reported them **offline**, because a newly created employee has no
 * schedule and an empty schedule matches no window, ever.
 *
 * So a customer messaging at 3am got a promise, the AI stopped answering, and
 * the platform's own presence engine already knew nobody was there. That is the
 * §9.5 failure the empty-rota work was written to end, returning through a
 * different door — and worse, because this time the system HAS the information
 * and does not consult it.
 *
 * WHAT THIS CHANGES, STATED PLAINLY: adding someone to a rota is no longer
 * enough to make the agent promise them. Their working hours have to say they
 * are on shift. An employee with no schedule configured is treated as NOT
 * available — deliberately, because the alternative is promising a person the
 * system cannot show is there, which is the exact failure above. The log line
 * names that case separately so "nobody is working right now" and "nobody has
 * told us when this person works" are never confused for one another.
 */
export async function hasStaffOnShift(organizationId: string): Promise<boolean> {
  const employees = await withTenant(organizationId, () => listEmployees(organizationId));
  const active = employees.filter((employee) => employee.isActive);
  if (active.length === 0) return false;

  const onShift = active.filter(
    (employee) => resolvePresence(employee).status === "online"
  );
  if (onShift.length > 0) return true;

  // Distinguish the two ways of having nobody, because they need different
  // actions from a human: one waits for a shift to start, the other needs
  // somebody to fill in a schedule that was never set.
  const unscheduled = active.filter(
    (employee) => Object.keys(employee.workingHours ?? {}).length === 0
  );
  logger.warn(
    {
      organizationId,
      activeStaff: active.length,
      withoutSchedule: unscheduled.map((employee) => employee.employeeCode),
    },
    unscheduled.length === active.length
      ? "Staff exist but none has working hours configured — escalation will not promise them"
      : "Staff exist but none is on shift right now — escalation falls back to answering directly"
  );
  return false;
}
