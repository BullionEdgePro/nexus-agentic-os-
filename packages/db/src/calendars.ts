/**
 * Calendar connections and the busy time they produce.
 *
 * The ICS URL is bearer access to somebody's diary. It lives here because it
 * has to be fetched, and `CalendarRecord` deliberately does NOT carry it --
 * only `host`, which is enough for a person to recognise which link they
 * pasted. The one function that returns the URL says so in its name, and the
 * only caller is the sync job.
 */
import { getPool } from "./client.js";

export interface CalendarRecord {
  employeeId: string;
  employeeName: string;
  organizationId: string;
  /** "calendar.google.com". Never the URL: it is a credential. */
  host: string;
  isActive: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  unsupportedCount: number;
  /** Busy blocks currently stored for this person, inside the sync window. */
  busyBlocks: number;
  createdBy: string;
}

interface Row {
  employee_id: string;
  employee_name: string;
  organization_id: string;
  ics_url: string;
  is_active: boolean;
  last_synced_at: string | null;
  last_error: string | null;
  unsupported_count: number;
  busy_blocks: string;
  created_by: string;
}

/** The host, or a placeholder. Never throws on a URL the database already holds. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "an unreadable address";
  }
}

const SELECT = `
  select c.employee_id, e.full_name as employee_name, c.organization_id, c.ics_url,
         c.is_active, c.last_synced_at, c.last_error, c.unsupported_count, c.created_by,
         (select count(*) from calendar_busy b where b.employee_id = c.employee_id) as busy_blocks
    from employee_calendars c
    join employees e on e.id = c.employee_id`;

const toRecord = (row: Row): CalendarRecord => ({
  employeeId: row.employee_id,
  employeeName: row.employee_name,
  organizationId: row.organization_id,
  host: hostOf(row.ics_url),
  isActive: row.is_active,
  lastSyncedAt: row.last_synced_at,
  lastError: row.last_error,
  unsupportedCount: row.unsupported_count,
  busyBlocks: Number(row.busy_blocks ?? 0),
  createdBy: row.created_by,
});

export async function listCalendars(organizationId: string): Promise<CalendarRecord[]> {
  const { rows } = await getPool().query<Row>(
    `${SELECT} where c.organization_id = $1 order by e.full_name asc`,
    [organizationId]
  );
  return rows.map(toRecord);
}

/**
 * Connect or replace a person's calendar.
 *
 * Replacing clears the error and the unsupported count: they described the
 * previous link and would otherwise sit there describing a feed nobody is
 * reading any more. The busy blocks are cleared too -- they came from the old
 * calendar, and leaving them would keep somebody blocked for meetings that are
 * no longer in any feed this platform can see.
 */
export async function connectCalendar(input: {
  organizationId: string;
  employeeId: string;
  icsUrl: string;
  createdBy: string;
}): Promise<CalendarRecord | null> {
  await getPool().query(
    `insert into employee_calendars (organization_id, employee_id, ics_url, created_by)
     values ($1, $2, $3, $4)
     on conflict (employee_id) do update
        set ics_url           = excluded.ics_url,
            organization_id   = excluded.organization_id,
            is_active         = true,
            last_synced_at    = null,
            last_error        = null,
            unsupported_count = 0,
            updated_at        = now()`,
    [input.organizationId, input.employeeId, input.icsUrl, input.createdBy]
  );
  await getPool().query(`delete from calendar_busy where employee_id = $1`, [input.employeeId]);

  const { rows } = await getPool().query<Row>(`${SELECT} where c.employee_id = $1`, [
    input.employeeId,
  ]);
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function disconnectCalendar(
  organizationId: string,
  employeeId: string
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `delete from employee_calendars where employee_id = $1 and organization_id = $2`,
    [employeeId, organizationId]
  );
  // The busy blocks go with it. A disconnected calendar that kept blocking
  // somebody would be unfixable from any screen -- the row saying why is gone.
  await getPool().query(`delete from calendar_busy where employee_id = $1`, [employeeId]);
  return (rowCount ?? 0) > 0;
}

/**
 * Every calendar due a sync, WITH the URL.
 *
 * The only function here that returns the credential, named so that a call site
 * handing it to a response is visible in review.
 */
export async function listCalendarsForSync(): Promise<
  Array<{ employeeId: string; organizationId: string; icsUrl: string; timezone: string }>
> {
  const { rows } = await getPool().query<{
    employee_id: string;
    organization_id: string;
    ics_url: string;
    timezone: string | null;
  }>(
    `select c.employee_id, c.organization_id, c.ics_url, e.timezone
       from employee_calendars c
       join employees e on e.id = c.employee_id
      where c.is_active and e.is_active`
  );
  return rows.map((r) => ({
    employeeId: r.employee_id,
    organizationId: r.organization_id,
    icsUrl: r.ics_url,
    timezone: r.timezone || "UTC",
  }));
}

/**
 * Replace one person's busy time with what their calendar now says.
 *
 * Wholesale, in one transaction, for the reason written on the migration: a
 * merge would have to notice DELETED events, and a deletion that goes unnoticed
 * leaves somebody blocked for a meeting that is not happening.
 */
export async function replaceBusy(
  organizationId: string,
  employeeId: string,
  blocks: ReadonlyArray<{ uid: string; startsAt: Date; endsAt: Date }>,
  unsupportedCount: number
): Promise<void> {
  const pool = getPool();
  await pool.query("begin");
  try {
    await pool.query(`delete from calendar_busy where employee_id = $1`, [employeeId]);
    for (const block of blocks) {
      await pool.query(
        `insert into calendar_busy (organization_id, employee_id, uid, starts_at, ends_at)
         values ($1, $2, $3, $4, $5)`,
        [organizationId, employeeId, block.uid || "no-uid", block.startsAt, block.endsAt]
      );
    }
    await pool.query(
      `update employee_calendars
          set last_synced_at = now(), last_error = null, unsupported_count = $2, updated_at = now()
        where employee_id = $1`,
      [employeeId, unsupportedCount]
    );
    await pool.query("commit");
  } catch (err) {
    await pool.query("rollback").catch(() => undefined);
    throw err;
  }
}

/**
 * Record that a sync failed.
 *
 * THE BUSY BLOCKS ARE LEFT ALONE, deliberately. A feed that is unreachable for
 * an hour should not empty somebody's diary and make them look available all
 * afternoon; yesterday's answer is stale but it is not a fabrication. The error
 * is what tells a person the difference, which is why it is stored where they
 * can read it rather than only logged.
 */
export async function recordCalendarError(employeeId: string, reason: string): Promise<void> {
  await getPool().query(
    `update employee_calendars
        set last_error = $2, updated_at = now()
      where employee_id = $1`,
    [employeeId, reason.slice(0, 500)]
  );
}

/** Busy blocks covering this instant, for the people named. */
export async function busyEmployeeIds(
  employeeIds: readonly string[],
  at: Date = new Date()
): Promise<Set<string>> {
  if (employeeIds.length === 0) return new Set();
  const { rows } = await getPool().query<{ employee_id: string }>(
    `select distinct employee_id
       from calendar_busy
      where employee_id = any($1::uuid[])
        and starts_at <= $2
        and ends_at   >  $2`,
    [employeeIds as string[], at]
  );
  return new Set(rows.map((r) => r.employee_id));
}
