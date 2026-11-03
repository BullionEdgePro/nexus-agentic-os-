import type { Job } from "bullmq";
import type { BroadcastSendJob } from "@nexus/shared";
import {
  updateBroadcastRecipientStatus,
  broadcastOutcome,
  broadcastStatus,
  pauseBroadcastIfFailing,
  updateBroadcastStatus,
  withAllTenants,
  withSavepoint,
  isolated,
} from "@nexus/db";
import { sendWhatsAppTemplate } from "../lib/whatsapp-client.js";
import { isUpstreamUnavailable } from "../scripts/upstream.js";
import { logger } from "../lib/logger.js";
import { explainSendError, isPaymentRefusal, NO_WHATSAPP_NUMBER } from "../lib/send-errors.js";
import { notePaymentRefusal } from "../lib/payment-refusal.js";

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
    // A PAUSED CAMPAIGN SENDS NOTHING MORE (22 Oct 2026). Read fresh before
    // every send: the jobs were all queued up front, so the pause has to be
    // honoured here, one recipient at a time. The recipient stays 'pending' —
    // nothing was tried for them.
    const current = await broadcastStatus(broadcastId);
    if (current === "paused" || current === "stopped") return;

    // A CAMPAIGN THAT IS NOT THERE SENDS NOTHING (3 Nov 2026). The jobs are
    // queued inside the send request's transaction, so a job can run before that
    // commits, and a request that throws half-way through queueing rolls its
    // campaign back while the jobs already queued still run. Thrown, the queue
    // tries again after its backoff: a late commit is found, a rolled-back
    // campaign uses up its attempts and nobody is messaged.
    if (current === null) {
      throw new Error(
        `Campaign ${broadcastId} is not in the database (not committed yet, or rolled back); nothing was sent`
      );
    }

    // NOBODY TO SEND TO (26 Oct 2026). An empty number used to go to Meta, which
    // answered "The parameter to is required" fourteen times on 22 Oct. The
    // audience already excludes these; this is the last line if it ever doesn't.
    if (!contactWaId?.trim()) {
      await updateBroadcastRecipientStatus(recipientId, "failed", null, NO_WHATSAPP_NUMBER);
      return;
    }

    let failure: string | null = null;
    let wentOut = false;
    let waMessageId: string | null = null;
    try {
      // The receipt was already being returned and thrown away: the reply path was
      // wired to it on 17 August and this one was not. Without it 'sent' here can
      // only ever mean "Meta accepted", which on a campaign — sent by definition
      // to people who have NOT written in 24 hours — is the least trustworthy
      // moment to stop asking.
      waMessageId = await sendWhatsAppTemplate(
        phoneNumberId,
        contactWaId,
        templateName,
        templateLanguage,
        templateParams ?? []
      );
      wentOut = true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Refused at send time over payment: remembered for the number, so the
      // readiness screen says so before the next campaign (payment-refusal.ts).
      if (isPaymentRefusal(reason)) await notePaymentRefusal(phoneNumberId, reason).catch(() => undefined);

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
      failure = reason;
    }

    // THE 'SENT' MARK IS NOT PART OF THE SEND (caught-error audit, 3 Nov 2026).
    // Inside the send's try, its own failure read as a failed send: the 'failed'
    // mark was refused too, the job threw, and the queue's retry sent the
    // template to the customer again. In its own savepoint, and once the message
    // has gone nothing here throws: the row stays pending and the log says why.
    if (wentOut) {
      try {
        await withSavepoint(() => updateBroadcastRecipientStatus(recipientId, "sent", waMessageId));
      } catch (err) {
        logger.error(
          { broadcastId, recipientId, err },
          "A campaign message was sent but could not be marked sent; it stays pending, so check this campaign before resuming it"
        );
        return;
      }
    }

    // NOTHING AFTER THE SEND THROWS (final review, 3 Nov 2026). The progress
    // below ran after the 'sent' mark and could still throw, rolling the mark
    // back with it -- and the queue's retry sent the template again. Contained
    // and logged instead; the next recipient's job brings the progress up to date.
    try {
      await isolated(async () => {
        // COMPLETED IS NOT THE ONLY WAY TO FINISH. This wrote "completed" whenever
        // nothing was pending, so a campaign in which every message failed ended in
        // exactly the state of one where every message arrived. `failed` has been an
        // allowed status since the table was made and nothing had ever set it.
        const outcome = await broadcastOutcome(broadcastId);

        // THE CIRCUIT BREAKER (22 Oct 2026). After every recipient, not only a
        // failed one: refusals Meta reports later by webhook count too (review).
        const paused = await pauseBroadcastIfFailing(broadcastId);
        if (paused) {
          logger.warn(
            { broadcastId, ...paused, reason: failure ? explainSendError(failure) : "refused after sending (delivery receipts)" },
            "Campaign paused: most of its messages were refused"
          );
          return;
        }

        // Finishing never un-pauses: a paused campaign keeps pending recipients and
        // so is never "done", but a race between its last jobs must not overwrite
        // the pause either.
        if (outcome.done && (await broadcastStatus(broadcastId)) === "sending") {
          const status = outcome.sent === 0 && outcome.failed > 0 ? "failed" : "completed";
          await updateBroadcastStatus(broadcastId, status);
          logger.info({ broadcastId, ...outcome, status }, "Broadcast finished");
        }
      });
    } catch (err) {
      logger.error({ broadcastId, recipientId, err }, "A campaign's progress could not be updated after a send");
    }
  });
}
