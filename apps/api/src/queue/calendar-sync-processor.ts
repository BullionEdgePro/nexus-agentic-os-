import { syncAllCalendars } from "../services/calendar-sync.js";
import { logger } from "../lib/logger.js";
import { withJobHeartbeat } from "@nexus/db";

/**
 * Re-reads every connected calendar.
 *
 * The counts are logged rather than "done", for the reason the template sync
 * says out loud: a cycle that ran and read nothing looks identical to a healthy
 * one unless the numbers are stated. Here that matters more than usual, because
 * the failure mode is silence -- every feed unreachable, every diary stale, and
 * the platform still promising people to customers.
 */
async function processCalendarSyncJobBody(): Promise<void> {
  const result = await syncAllCalendars();

  if (result.failed > 0) {
    logger.warn(result, "Some calendars could not be read — their last known busy time still stands");
  }
  if (result.unsupported > 0) {
    // Said at cycle level as well as stored per calendar. A monthly recurrence
    // nobody expands is a person who looks free on the one day a month they
    // are not, and the whole design here is that such a gap is never silent.
    logger.info(
      { unsupported: result.unsupported },
      "Some calendar events use a repeat rule this cannot expand — those times are not blocked"
    );
  }
}

/**
 * Wrapped so this job cannot run without saying that it did (migration 050).
 *
 * `schedule-stalled` watches the heartbeat, which is the only thing that would
 * notice this cycle dying quietly -- and a dead calendar sync does not look
 * like an outage from any screen. Everyone simply stays as free as they were a
 * fortnight ago.
 */
export function processCalendarSyncJob(): Promise<void> {
  return withJobHeartbeat("calendar-sync", processCalendarSyncJobBody);
}
