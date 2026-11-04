/**
 * Who gets told about an inbox event (spec 2026-10-09-nexus-mobile-app-design.md).
 *
 * Pure: the dispatcher gathers the facts, this decides, and the tests run it
 * for real. Subjects are the readerOf key push_subscriptions stores them by
 * ("e:<employeeId>", "o:<adminId>").
 *
 * - A customer's message in a chat assigned to an active person: that person,
 *   on shift or not. It is their chat; mode "mine" (and "all") hears it.
 * - A customer's message with nobody (active) on it: the owners (admins), on
 *   devices set to "all". Not the staff on shift (4 Nov 2026): under the
 *   own-book rule an unassigned chat is the admins', a staff member who tapped
 *   the alert could not open it, and the alert carried the customer's name and,
 *   with previews on, their words.
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
  /** the serving business's staff; adminId is set on an admin's seat (migration 108) */
  staff: { employeeId: string; active: boolean; onShift: boolean; adminId?: string | null }[];
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
  // Nobody signs in AS an admin's seat: its chats reach the admin's own devices
  // ("o:<adminId>") as well, or messages on their line would arrive silently.
  const holder = (id: string) => {
    const adminId = ctx.staff.find((s) => s.employeeId === id)?.adminId;
    return adminId ? [employee(id), `o:${adminId}`] : [employee(id)];
  };

  if (ctx.kind === "assigned") {
    return isActive(ctx.newAssigneeEmployeeId)
      ? [{ subjects: holder(ctx.newAssigneeEmployeeId!), requiresMode: "mine" }]
      : [];
  }

  if (ctx.kind !== "message" || ctx.direction !== "inbound") return [];

  if (isActive(ctx.assigneeEmployeeId)) {
    return [{ subjects: holder(ctx.assigneeEmployeeId!), requiresMode: "mine" }];
  }

  return ctx.ownerSubjects.length > 0 ? [{ subjects: ctx.ownerSubjects, requiresMode: "all" }] : [];
}
