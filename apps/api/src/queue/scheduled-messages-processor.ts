import type { Job } from "bullmq";
import {
  withAllTenants,
  withJobHeartbeat,
  claimDueScheduledMessages,
  markScheduledMessageSent,
  markScheduledMessageFailed,
  findConversationById,
  insertOutboundMessage,
  pauseAiForContact,
  setConversationHandoff,
} from "@nexus/db";
import { sendWhatsAppText } from "../lib/whatsapp-client.js";
import { publishInboxEvent } from "../lib/pubsub.js";
import { logger } from "../lib/logger.js";

/**
 * Send the scheduled messages that have come due.
 *
 * Cross-tenant because the queue is one across all five businesses; claiming is
 * atomic (`for update skip locked` + a flip to 'sending') so an overlapping run
 * cannot send a row twice. Each send is isolated — one that Meta refuses (the
 * usual cause is the 24-hour session window having closed) is marked failed WITH
 * the reason and the sweep moves on, never taking its siblings down and never
 * retrying blindly into the same wall.
 *
 * A sent message is recorded exactly like a human reply — an outbound row on the
 * thread, the AI paused on the contact, the conversation put in human custody —
 * because that is what it is: a person's words, written earlier.
 */
export async function processScheduledMessageSweep(_job: Job): Promise<void> {
  await withJobHeartbeat("scheduled-messages", () =>
    withAllTenants("scheduled messages: send the sends that are now due", async () => {
    const due = await claimDueScheduledMessages(50);
    if (due.length === 0) return;

    for (const m of due) {
      try {
        const convo = await findConversationById(m.conversationId);
        if (!convo) {
          await markScheduledMessageFailed(m.id, "The conversation no longer exists.");
          continue;
        }

        let waMessageId: string | null = null;
        try {
          waMessageId = await sendWhatsAppText(convo.phoneNumberId, convo.contactWaId, m.body);
        } catch (err) {
          // The commonest failure is Meta refusing a free-form message outside
          // the 24-hour window. Its own words are the most useful thing to keep.
          await markScheduledMessageFailed(m.id, err instanceof Error ? err.message : String(err));
          logger.warn({ id: m.id, conversationId: convo.id }, "Scheduled message refused by WhatsApp");
          continue;
        }

        const message = await insertOutboundMessage({
          organizationId: convo.organizationId,
          conversationId: convo.id,
          contactId: convo.contactId,
          senderType: "human_agent",
          senderId: m.createdBy ?? undefined,
          body: m.body,
          waMessageId: waMessageId ?? undefined,
        });

        // A person's message took this conversation, just on a delay: pause the
        // agent for the contact and put the thread in human custody, exactly as a
        // live human reply does.
        await Promise.all([
          pauseAiForContact(convo.contactId, 24),
          setConversationHandoff(convo.id, true, "human_replied", m.createdBy ?? null),
        ]);

        await publishInboxEvent({
          type: "message",
          organizationId: convo.organizationId,
          organizationSlug: convo.organizationSlug,
          conversationId: convo.id,
          message,
        });

        await markScheduledMessageSent(m.id, waMessageId);
        logger.info({ id: m.id, conversationId: convo.id }, "Sent a scheduled message");
      } catch (err) {
        // Anything past the send point — the recording — failing still marks the
        // row failed rather than leaving it stuck in 'sending' forever.
        await markScheduledMessageFailed(m.id, err instanceof Error ? err.message : String(err));
        logger.error({ id: m.id, err }, "Scheduled message send failed after dispatch");
      }
    }
    })
  );
}
