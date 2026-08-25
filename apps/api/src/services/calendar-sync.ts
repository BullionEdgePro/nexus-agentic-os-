/**
 * Fetching everybody's calendar, on a schedule.
 *
 * ============================================================
 * WHAT A FAILED SYNC MUST NOT DO
 * ============================================================
 *
 * Empty somebody's diary. A feed that is unreachable for an hour -- a rotated
 * link, a Google blip, a DNS hiccup -- would otherwise make the person look
 * free all afternoon, and the agent would promise them to a customer. Stale
 * busy time is wrong in the safe direction; absent busy time is wrong in the
 * direction that ends with nobody answering.
 *
 * So a failure records the reason and leaves the blocks alone. `replaceBusy` is
 * only ever reached with a calendar this actually read.
 *
 * ============================================================
 * WHY THE SSRF GUARD IS BORROWED RATHER THAN REWRITTEN
 * ============================================================
 *
 * These URLs are pasted by people, which makes them the same class of input as
 * a knowledge-base URL: someone can paste http://169.254.169.254/ and turn this
 * platform into a proxy for its own metadata service. `assertPublicUrl` already
 * holds that rule and is now exported for this. A second copy would be a second
 * thing to keep right.
 */
import {
  busyEmployeeIds,
  listCalendarsForSync,
  recordCalendarError,
  replaceBusy,
  withAllTenants,
  withTenant,
} from "@nexus/db";
import { assertPublicUrl, UnsafeUrlError } from "@nexus/knowledge";
import { parseCalendar, CALENDAR_WINDOW_DAYS, MAX_ICS_BYTES } from "@nexus/employees";
import { logger } from "../lib/logger.js";

const FETCH_TIMEOUT_MS = 20_000;
const DAY_MS = 86_400_000;

export interface CalendarSyncResult {
  synced: number;
  failed: number;
  busyBlocks: number;
  unsupported: number;
}

/**
 * Fetch one feed.
 *
 * Deliberately NOT `fetchDocument`: that refuses anything which is not HTML or
 * plain text, and a calendar is served as text/calendar. The safety that
 * matters -- the address check -- is the same call it makes.
 */
async function fetchIcs(rawUrl: string): Promise<string> {
  const url = await assertPublicUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // `redirect: follow` rather than manual, and this is the one place this
      // codebase allows it: Google and Outlook both bounce a published link
      // through a signing host, and every hop is on the provider's own domain.
      // The trade is stated rather than assumed -- a redirect to a private
      // address would not be re-checked, which is why the size cap below is
      // enforced on what actually arrives.
      redirect: "follow",
      headers: { "user-agent": "NexusAgenticOS-CalendarSync/1.0", accept: "text/calendar,text/plain" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url.hostname}`);

    const body = await response.text();
    if (body.length > MAX_ICS_BYTES) {
      throw new Error("That calendar is too large to read. Publish a single calendar rather than a merged one.");
    }
    if (!body.includes("BEGIN:VCALENDAR")) {
      // The commonest paste mistake by a distance: the page you view the
      // calendar on rather than the feed you subscribe to. Said in those words
      // because "invalid response" sends somebody to the wrong place.
      throw new Error("That address did not return a calendar. Copy the secret iCal link, not the page address.");
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/** Every connected calendar. One person's failure must not stop the rest. */
export async function syncAllCalendars(): Promise<CalendarSyncResult> {
  // withAllTenants, and the reason is the whole point of this sweep: it reads
  // every business's calendars in one pass, which is exactly the deliberate
  // cross-tenant read that wrapper exists to make declarable.
  //
  // Left unwrapped for one deploy on 2026-08-25 and DB_TENANT_ASSERT=strict
  // threw on the first cycle, which is the assert doing its job -- without it
  // this would have returned zero rows under RLS and reported a clean sync of
  // nothing, forever, with every diary silently empty.
  const calendars = await withAllTenants(
    "calendar sync reads every business's connected feeds in one pass",
    () => listCalendarsForSync()
  );
  const result: CalendarSyncResult = { synced: 0, failed: 0, busyBlocks: 0, unsupported: 0 };

  const from = new Date();
  const to = new Date(from.getTime() + CALENDAR_WINDOW_DAYS * DAY_MS);

  for (const calendar of calendars) {
    try {
      const ics = await fetchIcs(calendar.icsUrl);
      // The employee's own timezone, for events that name none: a floating
      // 09:00 means nine in the morning where THEY are.
      const parsed = parseCalendar(ics, from, to, calendar.timezone);

      await withTenant(calendar.organizationId, () =>
        replaceBusy(calendar.organizationId, calendar.employeeId, parsed.busy, parsed.unsupported)
      );

      result.synced++;
      result.busyBlocks += parsed.busy.length;
      result.unsupported += parsed.unsupported;
    } catch (err) {
      result.failed++;
      const reason =
        err instanceof UnsafeUrlError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      // Recorded where the person who pasted the link can read it. They are the
      // only one who can rotate a revoked feed, and they do not read logs.
      await withTenant(calendar.organizationId, () =>
        recordCalendarError(calendar.employeeId, reason)
      ).catch(() => undefined);
      logger.warn(
        { organizationId: calendar.organizationId, employeeId: calendar.employeeId, reason },
        "A calendar could not be read — the busy time it produced last time still stands"
      );
    }
  }

  logger.info(result, "Calendars synced");
  return result;
}

/**
 * Which of these people are in something right now.
 *
 * Wrapped by the caller, not here: this is asked from inside the reply
 * pipeline's transaction, which is scoped to the number's OWNER on a shared
 * number. See `hasStaffOnShift`, which learned that the expensive way.
 */
export async function whoIsBusyNow(employeeIds: readonly string[]): Promise<Set<string>> {
  if (employeeIds.length === 0) return new Set();
  return busyEmployeeIds(employeeIds);
}
