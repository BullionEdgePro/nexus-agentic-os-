import {
  campaignForControl,
  getBroadcastTemplate,
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
        opts: { jobId: `email-${p.id}-resume-${Date.now()}` },
      }))
    );
  } else {
    const template = await withTenant(orgId, () => getBroadcastTemplate(campaign.templateId!));
    if (!template) return { error: "The message this campaign used no longer exists.", status: 422 };
    const queue = getBroadcastSendQueue();
    for (const p of pending) {
      if (!p.waId?.trim()) {
        await withTenant(orgId, () => updateBroadcastRecipientStatus(p.id, "failed", null, NO_WHATSAPP_NUMBER));
        continue;
      }
      const name = p.displayName?.trim() || "there";
      await queue.add("send", {
        broadcastId,
        recipientId: p.id,
        contactWaId: p.waId,
        phoneNumberId: campaign.fromPhoneNumberId!,
        templateName: template.metaTemplateName,
        templateLanguage: template.language,
        templateParams:
          template.bodyParamCount > 0
            ? Array.from({ length: template.bodyParamCount }, (_, i) => (i === 0 ? name : "-"))
            : [],
      });
    }
  }

  logger.info({ broadcastId, channel: campaign.channel, requeued: pending.length }, "Campaign resumed");
  return { ok: true, requeued: pending.length };
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
