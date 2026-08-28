import type { Job } from "bullmq";
import type { BroadcastSendJob } from "@nexus/shared";
import {
  updateBroadcastRecipientStatus,
  broadcastOutcome,
  updateBroadcastStatus,
  withAllTenants,
} from "@nexus/db";
import { sendWhatsAppTemplate } from "../lib/whatsapp-client.js";
import { isUpstreamUnavailable } from "../scripts/upstream.js";
import { logger } from "../lib/logger.js";

/**
 * Delivering one message of a campaign.
 *
 * ============================================================
 * THE RETRY THAT NEVER RETRIED
 * ============================================================
 *
 * The queue is configured `attempts: 3` with exponential backoff. It has never
 * retried anything, and could not have: this processor caught every error and
 * returned normally, so BullMQ saw a job that succeeded. Three attempts,
 * configured, dead. Resilience that reads correctly in the queue file and does
 * nothing in the one that matters.
 *
 * The cost lands on a bulk send specifically. WhatsApp rate-limits throughput,
 * so a campaign of any size will meet 429s partway through — and every one of
 * those became a person permanently marked failed, on the first try, with the
 * reason discarded.
 *
 * So a failure the vendor might answer differently next time is now RETHROWN,
 * and the queue does what it was already configured to do. A failure that will
 * never succeed — a malformed number, a template Meta has withdrawn — is marked
 * failed immediately, because retrying it three times with backoff only delays
 * the same answer.
 *
 * The same distinction, and the same function, as the two gates that stand down
 * when the model provider is unreachable rather than reporting a platform
 * defect. Narrow on purpose: every widening turns a real error into a shrug.
 */
export async function processBroadcastSendJob(job: Job<BroadcastSendJob>): Promise<void> {
  const { broadcastId, recipientId, contactWaId, phoneNumberId, templateName, templateLanguage, templateParams } =
    job.data;

  // The job carries a recipient id, not an organization id — the audience was
  // already resolved and frozen when the broadcast was queued, so this step is
  // only marking outcomes against rows that were chosen under a tenant scope
  // upstream. Naming that here rather than re-deriving the tenant keeps the
  // send path from re-resolving an audience that must not change mid-send.
  await withAllTenants(`broadcast delivery: recipient ${recipientId}`, async () => {
    try {
      // The receipt was already being returned and thrown away: the reply path was
      // wired to it on 17 August and this one was not. Without it 'sent' here can
      // only ever mean "Meta accepted", which on a campaign — sent by definition
      // to people who have NOT written in 24 hours — is the least trustworthy
      // moment to stop asking.
      const waMessageId = await sendWhatsAppTemplate(
        phoneNumberId,
        contactWaId,
        templateName,
        templateLanguage,
        templateParams ?? []
      );
      await updateBroadcastRecipientStatus(recipientId, "sent", waMessageId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);

      // `attemptsMade` counts the attempt that has just failed. On the last one
      // there is nothing left to wait for, so the row must be settled rather
      // than left pending for ever — a recipient stuck at pending would also
      // hold the whole broadcast open, since completion is "nothing pending".
      const attemptsAllowed = job.opts.attempts ?? 1;
      const canRetry = isUpstreamUnavailable(err) && job.attemptsMade + 1 < attemptsAllowed;

      if (canRetry) {
        logger.warn(
          { broadcastId, recipientId, attempt: job.attemptsMade + 1, of: attemptsAllowed, err },
          "Broadcast send failed transiently — leaving pending for the queue to retry"
        );
        // Rethrown so BullMQ counts a failure and schedules the backoff. The row
        // stays `pending`, which is true: nothing has been decided about this
        // person yet.
        throw err;
      }

      logger.error({ broadcastId, recipientId, err }, "Broadcast send failed for recipient");
      await updateBroadcastRecipientStatus(recipientId, "failed", null, reason);
    }

    // COMPLETED IS NOT THE ONLY WAY TO FINISH. This wrote "completed" whenever
    // nothing was pending, so a campaign in which every message failed ended in
    // exactly the state of one where every message arrived. `failed` has been an
    // allowed status since the table was made and nothing had ever set it.
    const outcome = await broadcastOutcome(broadcastId);
    if (outcome.done) {
      const status = outcome.sent === 0 && outcome.failed > 0 ? "failed" : "completed";
      await updateBroadcastStatus(broadcastId, status);
      logger.info({ broadcastId, ...outcome, status }, "Broadcast finished");
    }
  });
}
