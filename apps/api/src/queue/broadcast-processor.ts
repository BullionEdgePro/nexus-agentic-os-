import type { Job } from "bullmq";
import type { BroadcastSendJob } from "@nexus/shared";
import {
  updateBroadcastRecipientStatus,
  isBroadcastFullyProcessed,
  updateBroadcastStatus,
  withAllTenants,
} from "@nexus/db";
import { sendWhatsAppTemplate } from "../lib/whatsapp-client.js";
import { logger } from "../lib/logger.js";

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
    logger.error({ broadcastId, recipientId, err }, "Broadcast send failed for recipient");
    await updateBroadcastRecipientStatus(recipientId, "failed");
  }

  if (await isBroadcastFullyProcessed(broadcastId)) {
    await updateBroadcastStatus(broadcastId, "completed");
  }
  });
}
