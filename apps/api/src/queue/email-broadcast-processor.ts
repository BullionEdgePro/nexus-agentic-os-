import type { Job } from "bullmq";
import type { EmailBroadcastSendJob } from "@nexus/shared";
import {
  broadcastOutcome,
  broadcastStatus,
  emailRecipientForSend,
  findOrCreateEmailConversation,
  insertSyncedEmailMessage,
  markEmailRecipientFailed,
  markEmailRecipientSent,
  pauseBroadcastIfFailing,
  setBroadcastStatusIf,
  updateBroadcastStatus,
  withAllTenants,
  withTenant,
} from "@nexus/db";
import { classifyEmailSendError, explainEmailSendError, renderCampaignEmail } from "../lib/campaign-email.js";
import { apiBaseUrl } from "../lib/public-urls.js";
import { unsubscribeUrl } from "../routes/unsubscribe.js";
import { mailboxFromStamp, sendFromMailbox } from "../services/campaign-mailbox.js";
import { logger } from "../lib/logger.js";

/**
 * Sending one email of a campaign (26 Oct 2026).
 *
 * Everything is read fresh: the job carries two ids. So a campaign paused or
 * stopped after it was queued sends nothing more, and a customer who clicked
 * unsubscribe on yesterday's email is not sent today's.
 *
 * Three kinds of failure, three answers (lib/campaign-email.ts):
 *  - the mailbox will not sign in: pause the whole campaign now, since every
 *    remaining email would fail the same way, and leave this person pending so
 *    Resume reaches them;
 *  - a busy server: rethrow, and the queue tries again with backoff;
 *  - this address refused: failed, with the reason in words.
 */
export async function processEmailBroadcastJob(job: Job<EmailBroadcastSendJob>): Promise<void> {
  const { broadcastId, recipientId } = job.data;
  const r = await emailRecipientForSend(recipientId);
  if (!r) return;
  // Paused or stopped by a person or by the breaker: nothing more goes out.
  if (r.campaignStatus === "paused" || r.campaignStatus === "stopped") return;
  if (r.status !== "pending") return;

  if (r.optedOut) {
    await markEmailRecipientFailed(recipientId, "Unsubscribed before it was sent");
    return finish(broadcastId);
  }
  if (r.bounced) {
    await markEmailRecipientFailed(recipientId, "Address bounced earlier");
    return finish(broadcastId);
  }
  if (!r.toAddress) {
    await markEmailRecipientFailed(recipientId, "This customer has no email address.");
    return finish(broadcastId);
  }

  const mailbox = await mailboxFromStamp(r.organizationId, r.fromMailbox, r.fromMailboxEmployeeId);
  if (!mailbox) {
    await pauseForMailbox(broadcastId, "The mailbox this campaign sends from is no longer connected — reconnect it, then Resume.");
    return;
  }

  const mail = renderCampaignEmail({
    subject: r.subject,
    body: r.body,
    displayName: r.displayName,
    unsubscribeUrl: unsubscribeUrl(apiBaseUrl(), r.unsubscribeToken),
    businessName: r.businessName,
    fromAddress: mailbox.address,
  });

  let messageId: string;
  try {
    messageId = await sendFromMailbox(r.organizationId, mailbox, { to: r.toAddress, ...mail });
  } catch (err) {
    const kind = classifyEmailSendError(err);
    if (kind === "auth") {
      await pauseForMailbox(broadcastId, explainEmailSendError(err));
      return;
    }
    const attemptsAllowed = job.opts.attempts ?? 1;
    if (kind === "transient" && job.attemptsMade + 1 < attemptsAllowed) {
      logger.warn({ broadcastId, recipientId, attempt: job.attemptsMade + 1, err }, "Campaign email: server busy — retrying");
      throw err;
    }
    await markEmailRecipientFailed(recipientId, explainEmailSendError(err));
    return finish(broadcastId);
  }

  await markEmailRecipientSent(recipientId, messageId);

  // The email joins the customer's email conversation, so the inbox shows what
  // they were sent and their reply lands under it. Best effort: the email has
  // gone, and a history write that fails must not make it look as if it had not.
  try {
    await withTenant(r.organizationId, async () => {
      const conversationId = await findOrCreateEmailConversation(r.organizationId, r.contactId, r.employeeId);
      await insertSyncedEmailMessage({
        organizationId: r.organizationId,
        conversationId,
        contactId: r.contactId,
        direction: "outbound",
        body: `${mail.subject}\n\n${mail.text}`.slice(0, 20_000),
        emailMessageId: messageId || `campaign-${recipientId}`,
        emailThreadId: null,
        receivedAt: null,
      });
    });
  } catch (err) {
    logger.warn({ err, broadcastId, recipientId }, "Campaign email sent, but not recorded in the conversation");
  }
  return finish(broadcastId);
}

/** Every remaining email would fail the same way: stop here, say why, keep the rest pending. */
async function pauseForMailbox(broadcastId: string, reason: string): Promise<void> {
  const paused = await withAllTenants("email campaign: pausing on a mailbox that will not send", () =>
    setBroadcastStatusIf(broadcastId, ["sending"], "paused")
  );
  if (paused) logger.warn({ broadcastId, reason }, "Email campaign paused: its mailbox stopped working");
}

/** The breaker, then the finish — the same two steps as a WhatsApp campaign. */
async function finish(broadcastId: string): Promise<void> {
  await withAllTenants(`email campaign delivery: ${broadcastId}`, async () => {
    const paused = await pauseBroadcastIfFailing(broadcastId);
    if (paused) {
      logger.warn({ broadcastId, ...paused }, "Email campaign paused: most of its emails were refused");
      return;
    }
    const outcome = await broadcastOutcome(broadcastId);
    const status = await broadcastStatus(broadcastId);
    if (outcome.done && status === "sending") {
      await updateBroadcastStatus(broadcastId, outcome.sent === 0 && outcome.failed > 0 ? "failed" : "completed");
      logger.info({ broadcastId, ...outcome }, "Email campaign finished");
    }
  });
}
