/**
 * My queue's compact rules (26 Nov 2026, staff-first compact piece 2), kept
 * pure so they can be tested: whether the folder sidebar starts folded, how
 * many filters the "Filters" button reports, and whether a row names who it is
 * assigned to.
 * Spec: docs/superpowers/specs/2026-11-26-staff-first-my-queue-design.md §4
 */

/**
 * Whether the Filters sidebar starts open: this browser's last choice
 * (`nexus.inbox.filters`, "open" | "closed") wins; otherwise folded for a
 * staff member — My queue's chips already hold their views — and open for an
 * admin, as it always was.
 */
export function filtersStartOpen(isStaff: boolean, stored: string | null): boolean {
  if (stored === "open") return true;
  if (stored === "closed") return false;
  return !isStaff;
}

/**
 * How many filters are on beyond the person's ordinary view, so a folded panel
 * never hides one by surprise: a folder outside My queue's chips (staff only —
 * an admin has no queue view, so `queueKeys` is null), and each of a label, a
 * channel, a date range, a pipeline stage and a team member.
 */
export function activeFilterCount(
  f: { folder: string; tag: string | null; channel: string | null; dateRange: string; stage: string | null; owner: string },
  queueKeys: readonly string[] | null
): number {
  return (
    (queueKeys && !queueKeys.includes(f.folder) ? 1 : 0) +
    (f.tag ? 1 : 0) +
    (f.channel ? 1 : 0) +
    (f.dateRange !== "any" ? 1 : 0) +
    (f.stage ? 1 : 0) +
    (f.owner ? 1 : 0)
  );
}

/** A row's "assigned to" line, left out only on a staff member's own conversation (it would name them). */
export function showsAssignee(c: { assignedEmployeeId: string | null }, myEmployeeId: string | null): boolean {
  return !(myEmployeeId && c.assignedEmployeeId === myEmployeeId);
}
