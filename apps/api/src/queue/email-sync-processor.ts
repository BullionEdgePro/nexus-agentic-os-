import { syncAllMailboxes } from "../services/email-sync.js";
import { logger } from "../lib/logger.js";
import { withJobHeartbeat } from "@nexus/db";

/**
 * Re-reads every connected staff mailbox.
 *
 * The counts are logged rather than "done", for the reason the calendar and
 * template syncs say out loud: a cycle that ran and read nothing looks identical
 * to a healthy one unless the numbers are stated. Here the silent failure is a
 * customer's email that never reaches the inbox — nobody sees an outage, the
 * thread simply never appears — so the count of what synced and what failed is
 * the only thing that tells the difference.
 */
async function processEmailSyncJobBody(): Promise<void> {
  const result = await syncAllMailboxes();

  if (result.failed > 0) {
    logger.warn(
      result,
      "Some mailboxes could not be synced — their owners' last known mail still stands; the reason is on each connection"
    );
  }
}

/**
 * Wrapped so this job cannot run without saying that it did (migration 050).
 *
 * `schedule-stalled` watches the heartbeat, which is the only thing that would
 * notice this cycle dying quietly — a dead email sync does not look like an
 * outage from any screen. Inbound customer email simply stops arriving, and the
 * inbox goes on showing whatever it last held.
 */
export function processEmailSyncJob(): Promise<void> {
  return withJobHeartbeat("email-sync", processEmailSyncJobBody);
}
