import {
  autoAssignLoad,
  busyEmployeeIds,
  claimForAutoAssign,
  conversationNeedsAssignee,
  getInboxSettings,
  listEmployees,
  stampAutoAssigned,
  withServingTenant,
} from "@nexus/db";
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
/**
 * `withServingTenant`, NOT `withTenant`, AND THE DIFFERENCE WAS INVISIBLE.
 *
 * This is asked about the SERVING business, from inside the reply pipeline's
 * transaction — which is scoped to the number's OWNER, because all five
 * businesses share Zipicka's number. `withTenant` nested inside `withTenant`
 * deliberately reuses the outer context, so the wrapper here did nothing at all:
 * the query ran as Zipicka, RLS matched none of Juris Prime's employees, and
 * `listEmployees` returned an empty array.
 *
 * Which lands on the `active.length === 0` line below and returns false. Not
 * "nobody is on shift" — the earlier, quieter branch that does not even log the
 * distinction it was written to log. For four of the five businesses this
 * function has been answering "you have no staff at all", so escalation has been
 * taking the FALLBACK_REPLY_NO_STAFF path regardless of who was actually at
 * their desk. Every container green, every reply plausible.
 */
export async function hasStaffOnShift(organizationId: string): Promise<boolean> {
  // ONE withServingTenant AROUND BOTH READS, not one each. Both are asked about
  // the SERVING business from inside the number owner's transaction, and the
  // comment above this function is the record of what happens when that is got
  // wrong: RLS matches nothing, the query returns an empty array, and the empty
  // array reads as a fact.
  const { active, busy } = await withServingTenant(organizationId, async () => {
    const employees = await listEmployees(organizationId);
    const live = employees.filter((employee) => employee.isActive);
    if (live.length === 0) return { active: live, busy: new Set<string>() };
    // A calendar that has never synced contributes an empty set, which means
    // nobody is blocked by it. That is the right default: this must never make
    // somebody unavailable on the strength of data it does not have.
    const inSomething = await busyEmployeeIds(live.map((employee) => employee.id)).catch(
      () => new Set<string>()
    );
    return { active: live, busy: inSomething };
  });

  if (active.length === 0) return false;

  const onShift = active.filter(
    (employee) => resolvePresence(employee, new Date(), busy.has(employee.id)).status === "online"
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
      inSomething: busy.size,
    },
    unscheduled.length === active.length
      ? "Staff exist but none has working hours configured — escalation will not promise them"
      : busy.size > 0 && busy.size === active.length
        ? // A third way of having nobody, and it needs a different action again:
          // everybody is at their desk and every one of them is in something.
          "Staff are on shift but every one of them is in a meeting — escalation falls back to answering directly"
        : "Staff exist but none is on shift right now — escalation falls back to answering directly"
  );
  return false;
}

/**
 * ROUND-ROBIN AUTO-ASSIGN — give a waiting chat to the next person on shift.
 *
 * Off unless the SERVING business turned it on (inbox settings, migration 092).
 * Returns who got it, or null when nothing was assigned — and never throws: a
 * failure here must leave the reply pipeline exactly as it was, answering as
 * the business.
 *
 * WHO IS ELIGIBLE, and why each condition is there:
 *   - active, and on shift now by their rota (resolvePresence "online"), and
 *     not in a calendar meeting — a chat handed to someone who is not there is
 *     a chat nobody answers;
 *   - their AI twin ON. An assigned chat is answered by the assignee's twin
 *     when they step away; with the twin off, the pipeline goes quiet for that
 *     chat instead. Auto-assigning to such a person would silence the AI on a
 *     customer the moment their shift ended. A person with the twin off can
 *     still be given chats by hand, knowingly.
 *
 * WHO GOES FIRST: fewest open chats, then whoever was auto-assigned longest ago
 * (never first), then name — the round in round-robin, weighted by load so a
 * person already carrying ten is not handed an eleventh because it is their
 * turn.
 *
 * SCOPES. The candidates are the serving business's people, so they are read in
 * withServingTenant (the reply pipeline runs as the number's OWNER, where RLS
 * shows none of a routed business's staff — see hasStaffOnShift above). The
 * conversation row belongs to the owner, so the claim is written in the
 * caller's scope. The claim re-checks "still unassigned" inside the UPDATE, so
 * a colleague assigning by hand at the same moment wins.
 */
export async function autoAssignIfEnabled(
  servingOrganizationId: string,
  conversationId: string
): Promise<{ id: string; fullName: string } | null> {
  try {
    if (!(await conversationNeedsAssignee(conversationId))) return null;

    const pick = await withServingTenant(servingOrganizationId, async () => {
      const settings = await getInboxSettings(servingOrganizationId);
      if (!settings.autoAssign) return null;

      const candidates = (await listEmployees(servingOrganizationId)).filter(
        (employee) => employee.isActive && employee.twinEnabled
      );
      if (candidates.length === 0) return null;
      const busy = await busyEmployeeIds(candidates.map((employee) => employee.id)).catch(
        () => new Set<string>()
      );
      const now = new Date();
      const onShift = candidates.filter(
        (employee) => resolvePresence(employee, now, busy.has(employee.id)).status === "online"
      );
      if (onShift.length === 0) return null;

      const load = await autoAssignLoad(onShift.map((employee) => employee.id));
      const ranked = [...onShift].sort((a, b) => {
        const la = load.get(a.id) ?? { open: 0, lastAutoAt: null };
        const lb = load.get(b.id) ?? { open: 0, lastAutoAt: null };
        if (la.open !== lb.open) return la.open - lb.open;
        const ta = la.lastAutoAt ? Date.parse(la.lastAutoAt) : 0;
        const tb = lb.lastAutoAt ? Date.parse(lb.lastAutoAt) : 0;
        if (ta !== tb) return ta - tb;
        return a.fullName.localeCompare(b.fullName);
      });
      return ranked[0];
    });
    if (!pick) return null;

    const claimed = await claimForAutoAssign(conversationId, pick.id, pick.fullName);
    if (!claimed) return null;
    await withServingTenant(servingOrganizationId, () => stampAutoAssigned(pick.id)).catch(() => undefined);
    logger.info({ conversationId, employeeId: pick.id, servingOrganizationId }, "Chat auto-assigned");
    return { id: pick.id, fullName: pick.fullName };
  } catch (err) {
    logger.warn({ err, conversationId, servingOrganizationId }, "Auto-assign skipped — the chat stays unassigned");
    return null;
  }
}
