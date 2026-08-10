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
    await sendWhatsAppTemplate(phoneNumberId, contactWaId, templateName, templateLanguage, templateParams ?? []);
    await updateBroadcastRecipientStatus(recipientId, "sent");
  } catch (err) {
    logger.error({ broadcastId, recipientId, err }, "Broadcast send failed for recipient");
    await updateBroadcastRecipientStatus(recipientId, "failed");
  }

  if (await isBroadcastFullyProcessed(broadcastId)) {
    await updateBroadcastStatus(broadcastId, "completed");
  }
  });
}
