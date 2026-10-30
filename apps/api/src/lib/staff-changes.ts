import { getRedisConnection } from "../queue/queue.js";
import { logger } from "./logger.js";

/**
 * Who last removed or restored a staff member, and when (30 Oct 2026).
 *
 * Two SFS staff were removed on 29 Oct and nothing recorded who did it — the
 * only clue was an owner sign-in six minutes earlier. Removal and restore now
 * note the person who clicked, and Team shows it beside the name. Kept with the
 * other per-person notes in Redis, without expiry: one small entry per change,
 * and the employees table stays as it is (no migration for a label).
 */

export interface StaffChange {
  action: "removed" | "restored";
  byId: string | null;
  byName: string | null;
  at: string;
}

const KEY = (employeeId: string) => `staff-change:${employeeId}`;

export async function recordStaffChange(employeeId: string, change: Omit<StaffChange, "at">): Promise<void> {
  const value: StaffChange = { ...change, at: new Date().toISOString() };
  await getRedisConnection()
    .set(KEY(employeeId), JSON.stringify(value))
    .catch((err) => logger.warn({ err, employeeId }, "Could not record who changed a staff member"));
}

/** The last change for each of these people; absent when none was recorded. */
export async function readStaffChanges(employeeIds: string[]): Promise<Map<string, StaffChange>> {
  if (employeeIds.length === 0) return new Map();
  try {
    const values = await getRedisConnection().mget(...employeeIds.map(KEY));
    const out = new Map<string, StaffChange>();
    values.forEach((raw, i) => {
      if (raw) out.set(employeeIds[i], JSON.parse(raw) as StaffChange);
    });
    return out;
  } catch {
    return new Map();
  }
}
