import {
  campaignForControl,
  campaignsWaitingForApproval,
  createAdminBroadcast,
  createBroadcastRecipients,
  getBroadcastTemplate,
  getContactsForAudience,
  isolated,
  pendingRecipients,
  setBroadcastStatusIf,
  updateBroadcastRecipientStatus,
  withTenant,
} from "@nexus/db";
import { getBroadcastSendQueue } from "../queue/broadcast-queue.js";
import { getEmailBroadcastQueue } from "../queue/email-broadcast-queue.js";
import { mailboxFromStamp } from "./campaign-mailbox.js";
import { NO_WHATSAPP_NUMBER } from "../lib/send-errors.js";
import { logger } from "../lib/logger.js";
import { sendingRefusal } from "../lib/sending-refusal.js";

/**
 * Resume and Stop, for a campaign on either channel (26 Oct 2026).
 *
 * A paused campaign used to be paused for ever: its untried people stayed
 * pending, the Staff work page said "1 campaign paused" indefinitely, and there
 * was no way to finish it either way. The caller has already checked the person
 * may act on this campaign; these only do it.
 */
export type ControlResult = { ok: true; requeued?: number } | { error: string; status: 404 | 409 | 422 };

export async function resumeCampaign(broadcastId: string): Promise<ControlResult> {
  const campaign = await campaignForControl(broadcastId);
  if (!campaign) return { error: "Campaign not found.", status: 404 };
  if (campaign.status !== "paused") return { error: "Only a paused campaign can be resumed.", status: 409 };
  const orgId = campaign.organizationId;

  if (campaign.channel === "email") {
    // The mailbox must work again before anything is queued: resuming onto a
    // broken sign-in would only pause it again on the first email.
    const mailbox = campaign.fromMailbox
      ? await mailboxFromStamp(orgId, campaign.fromMailbox, campaign.fromMailboxEmployeeId)
      : null;
    if (!mailbox) {
      return { error: "The mailbox this campaign sends from is not connected. Reconnect it first.", status: 422 };
    }
  } else if (!campaign.templateId || !campaign.fromPhoneNumberId) {
    return { error: "This campaign has no message or number on record to resume with.", status: 422 };
  } else {
    // The number is asked again, as Send and the release ask (audit, 4 Nov
    // 2026): resuming onto a number WhatsApp is blocking, or rates red, only
    // spends the rest of the campaign on refusals.
    const refusal = await sendingRefusal(campaign.fromPhoneNumberId);
    if (refusal) return { error: refusal, status: 409 };
  }

  const pending = await withTenant(orgId, () => pendingRecipients(broadcastId));
  if (!(await withTenant(orgId, () => setBroadcastStatusIf(broadcastId, ["paused"], "sending")))) {
    return { error: "This campaign changed while you were looking at it. Refresh and try again.", status: 409 };
  }

  if (campaign.channel === "email") {
    await getEmailBroadcastQueue().addBulk(
      pending.map((p) => ({
        name: "send",
        data: { broadcastId, recipientId: p.id },
        // A new job id: the original job for this person has already run (and
        // returned on the pause), so reusing its id would be ignored as a duplicate.
        //
        // And on the day it was planned for (audit, 4 Nov 2026): Resume used to
        // send every remaining day's emails at once, past the mailbox's daily cap.
        opts: {
          jobId: `email-${p.id}-resume-${Date.now()}`,
          delay: Math.max(AFTER_THE_REQUEST_MS, p.sendAfter ? new Date(p.sendAfter).getTime() - Date.now() : 0),
        },
      }))
    );
  } else {
    const queued = await queueWhatsAppRecipients(orgId, broadcastId, campaign.templateId!, campaign.fromPhoneNumberId!, pending, {
      delay: AFTER_THE_REQUEST_MS,
    });
    if (!queued) return { error: "The message this campaign used no longer exists.", status: 422 };
  }

  logger.info({ broadcastId, channel: campaign.channel, requeued: pending.length }, "Campaign resumed");
  return { ok: true, requeued: pending.length };
}

/**
 * How long a job queued inside a request waits before it may start (audit,
 * 4 Nov 2026). Every API request is one transaction that commits when the
 * request ends; a Resume's first jobs used to start before that, still read the
 * campaign as 'paused', and return for good — those people were never messaged
 * and the campaign never finished. Ten seconds is far longer than any request.
 */
export const AFTER_THE_REQUEST_MS = 10_000;

/**
 * Queue a WhatsApp campaign's untried people, with the first name in the
 * message's first blank. Resume and release share it. False when the message
 * the campaign uses no longer exists.
 */
async function queueWhatsAppRecipients(
  orgId: string,
  broadcastId: string,
  templateId: string,
  fromPhoneNumberId: string,
  pending: Awaited<ReturnType<typeof pendingRecipients>>,
  opts: { delay?: number } = {}
): Promise<boolean> {
  const template = await withTenant(orgId, () => getBroadcastTemplate(templateId));
  if (!template) return false;
  const queue = getBroadcastSendQueue();
  for (const p of pending) {
    if (!p.waId?.trim()) {
      await withTenant(orgId, () => updateBroadcastRecipientStatus(p.id, "failed", null, NO_WHATSAPP_NUMBER));
      continue;
    }
    const name = p.displayName?.trim().split(/\s+/)[0] || "there";
    await queue.add("send", {
      broadcastId,
      recipientId: p.id,
      contactWaId: p.waId,
      phoneNumberId: fromPhoneNumberId,
      templateName: template.metaTemplateName,
      templateLanguage: template.language,
      templateParams:
        template.bodyParamCount > 0
          ? Array.from({ length: template.bodyParamCount }, (_, i) => (i === 0 ? name : "-"))
          : [],
    }, opts.delay ? { delay: opts.delay } : undefined);
  }
  return true;
}

/**
 * The customers ticked on Bulk messaging, waiting for a new message to be
 * approved (3 Nov 2026): a campaign created as for Send, then left `scheduled`
 * so nothing is queued until releaseApprovedCampaigns finds the message
 * approved. Null when none of the chosen people can be messaged.
 */
export async function createWaitingCampaign(input: {
  organizationId: string;
  templateId: string;
  fromPhoneNumberId: string;
  numberOwnerEmployeeId: string | null;
  sentBy: string | null;
  contactIds: string[];
}): Promise<{ broadcastId: string; recipients: number } | null> {
  const chosen = new Set(input.contactIds);
  const audience = (await withTenant(input.organizationId, () => getContactsForAudience(input.organizationId, {}))).filter(
    (person) => chosen.has(person.id)
  );
  if (audience.length === 0) return null;
  return withTenant(input.organizationId, async () => {
    const broadcast = await createAdminBroadcast({
      organizationId: input.organizationId,
      templateId: input.templateId,
      fromPhoneNumberId: input.fromPhoneNumberId,
      numberOwnerEmployeeId: input.numberOwnerEmployeeId,
      sentBy: input.sentBy,
      recipients: audience.length,
    });
    await createBroadcastRecipients(broadcast.id, audience.map((person) => person.id));
    await setBroadcastStatusIf(broadcast.id, ["draft"], "scheduled");
    return { broadcastId: broadcast.id, recipients: audience.length };
  });
}

/** WhatsApp's verdicts after which a message can never be sent as it is. */
const NEVER_APPROVED = new Set(["REJECTED", "DISABLED", "PAUSED", "DELETED"]);

/**
 * SEND WHEN APPROVED (3 Nov 2026). An admin's own message for customers who
 * have not written in 24 hours must be an approved template, and WhatsApp takes
 * minutes to a day to approve one; the admin used to have to come back and send
 * it. A campaign can now wait for its message as `scheduled`: this sends the
 * waiting ones whose message is approved, and fails the ones WhatsApp turned
 * down. Run after every template sync and on "Check again". Claiming the status
 * first means two runs at once can never both send a campaign.
 *
 * Review, 3 Nov 2026: the number is checked again when it is released, up to a
 * day after it was checked at creation; one that WhatsApp would refuse keeps
 * the campaign waiting, with the reason for Check again to show. Each campaign
 * is its own savepoint, and one the queue half-refused goes back to waiting, so
 * the next run queues whoever is still pending -- the send job's own check of
 * the person makes a second job for someone already queued send nothing.
 */
export type ReleaseResult = {
  released: Array<{ broadcastId: string; templateId: string; recipients: number }>;
  held: Array<{ broadcastId: string; templateId: string; reason: string }>;
  failed: number;
};

export async function releaseApprovedCampaigns(organizationId: string): Promise<ReleaseResult> {
  const waiting = await withTenant(organizationId, () => campaignsWaitingForApproval(organizationId));
  const result: ReleaseResult = { released: [], held: [], failed: 0 };
  for (const campaign of waiting) {
    try {
      await isolated(async () => {
        if (campaign.templateApproved) {
          const from = campaign.fromPhoneNumberId;
          if (!from) return;
          const refusal = await sendingRefusal(from);
          if (refusal) {
            result.held.push({ broadcastId: campaign.id, templateId: campaign.templateId, reason: refusal });
            logger.warn({ broadcastId: campaign.id, refusal }, "Campaign approved but held: WhatsApp would refuse its number");
            return;
          }
          const pending = await withTenant(organizationId, () => pendingRecipients(campaign.id));
          // Claimed first: a cancel, or another release, that got there already wins.
          if (!(await withTenant(organizationId, () => setBroadcastStatusIf(campaign.id, ["scheduled"], "sending")))) return;
          try {
            await queueWhatsAppRecipients(organizationId, campaign.id, campaign.templateId, from, pending);
          } catch (err) {
            await withTenant(organizationId, () => setBroadcastStatusIf(campaign.id, ["sending"], "scheduled"));
            throw err;
          }
          result.released.push({ broadcastId: campaign.id, templateId: campaign.templateId, recipients: pending.length });
          logger.info({ broadcastId: campaign.id, recipients: pending.length }, "Campaign released: WhatsApp approved its message");
        } else if (NEVER_APPROVED.has(campaign.templateStatus ?? "")) {
          if (await withTenant(organizationId, () => setBroadcastStatusIf(campaign.id, ["scheduled"], "failed"))) {
            result.failed += 1;
            logger.warn({ broadcastId: campaign.id, status: campaign.templateStatus }, "Campaign failed: WhatsApp did not approve its message");
          }
        }
      });
    } catch (err) {
      logger.error({ broadcastId: campaign.id, err }, "Releasing a campaign waiting for approval failed; it waits for the next try");
    }
  }
  return result;
}

/** Close a campaign for good. Its untried people stay pending and read as "not sent". */
export async function stopCampaign(broadcastId: string): Promise<ControlResult> {
  const campaign = await campaignForControl(broadcastId);
  if (!campaign) return { error: "Campaign not found.", status: 404 };
  const stopped = await withTenant(campaign.organizationId, () =>
    setBroadcastStatusIf(broadcastId, ["paused", "sending", "scheduled", "draft"], "stopped")
  );
  if (!stopped) return { error: "This campaign has already finished.", status: 409 };
  logger.info({ broadcastId, channel: campaign.channel }, "Campaign stopped");
  return { ok: true };
}
