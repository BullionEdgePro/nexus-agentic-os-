import type { Job } from "bullmq";
import type { BroadcastSendJob } from "@nexus/shared";
import { updateBroadcastRecipientStatus, isBroadcastFullyProcessed, updateBroadcastStatus } from "@nexus/db";
import { sendWhatsAppTemplate } from "../lib/whatsapp-client.js";
import { logger } from "../lib/logger.js";

export async function processBroadcastSendJob(job: Job<BroadcastSendJob>): Promise<void> {
  const { broadcastId, recipientId, contactWaId, phoneNumberId, templateName, templateLanguage, templateParams } =
    job.data;

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
}
