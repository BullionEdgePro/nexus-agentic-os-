/**
 * Who gets told about an inbox event (spec 2026-10-09-nexus-mobile-app-design.md).
 *
 * Pure: the dispatcher gathers the facts, this decides, and the tests run it
 * for real. Subjects are the readerOf key push_subscriptions stores them by
 * ("e:<employeeId>", "o:<adminId>").
 *
 * - A customer's message in a chat assigned to an active person: that person,
 *   on shift or not. It is their chat; mode "mine" (and "all") hears it.
 * - A customer's message with nobody (active) on it: the business's active
 *   staff who are on shift, on devices set to "all". Nobody on shift: the owner.
 * - A chat handed to someone: the new assignee only.
 * - Anything the team did itself (a reply, a note, a status change): nobody.
 */
export interface PushContext {
  /** null for events that are not messages */
  direction: "inbound" | "outbound" | null;
  kind: "message" | "assigned" | "other";
  assigneeEmployeeId: string | null;
  /** for kind "assigned" */
  newAssigneeEmployeeId: string | null;
  /** the serving business's staff */
  staff: { employeeId: string; active: boolean; onShift: boolean }[];
  /** "o:<adminId>" of every owner */
  ownerSubjects: string[];
}

export interface PushRecipients {
  subjects: string[];
  /** "mine": devices in mode mine or all; "all": devices in mode all only */
  requiresMode: "mine" | "all";
}

const employee = (id: string) => `e:${id}`;

export function decideRecipients(ctx: PushContext): PushRecipients[] {
  const isActive = (id: string | null) => !!id && ctx.staff.some((s) => s.employeeId === id && s.active);

  if (ctx.kind === "assigned") {
    return isActive(ctx.newAssigneeEmployeeId)
      ? [{ subjects: [employee(ctx.newAssigneeEmployeeId!)], requiresMode: "mine" }]
      : [];
  }

  if (ctx.kind !== "message" || ctx.direction !== "inbound") return [];

  if (isActive(ctx.assigneeEmployeeId)) {
    return [{ subjects: [employee(ctx.assigneeEmployeeId!)], requiresMode: "mine" }];
  }

  const onShift = ctx.staff.filter((s) => s.active && s.onShift).map((s) => employee(s.employeeId));
  if (onShift.length > 0) return [{ subjects: onShift, requiresMode: "all" }];
  return ctx.ownerSubjects.length > 0 ? [{ subjects: ctx.ownerSubjects, requiresMode: "all" }] : [];
}
