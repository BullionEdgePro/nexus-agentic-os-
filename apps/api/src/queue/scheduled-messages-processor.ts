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
  withSavepoint,
} from "@nexus/db";
import { sendReplyOnChannel } from "../lib/reply-dispatch.js";
import { publishInboxEvent } from "../lib/pubsub.js";
import { logger } from "../lib/logger.js";

type ScheduledConversation = NonNullable<Awaited<ReturnType<typeof findConversationById>>>;
type RecordedMessage = Awaited<ReturnType<typeof insertOutboundMessage>>;

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
 *
 * SENT TWICE, EVERY MINUTE (3 Nov 2026). The whole sweep is one transaction,
 * claim included. A record that failed after a send left the transaction
 * aborted, so marking the row failed failed too, the sweep rolled back, every
 * row went back to 'pending' — and the next minute sent the earlier messages
 * again. Each message is now its own savepoint, and how its row ends is
 * decided by whether it went out: a message that was sent is marked sent even
 * when its record could not be saved, and is never sent again.
 */
export async function processScheduledMessageSweep(_job: Job): Promise<void> {
  await withJobHeartbeat("scheduled-messages", () =>
    withAllTenants("scheduled messages: send the sends that are now due", async () => {
    const due = await claimDueScheduledMessages(50);
    if (due.length === 0) return;

    for (const m of due) {
      // Set once the message has gone out: from then on it WAS sent, whatever
      // fails after it.
      const progress = { wentOut: false, waMessageId: null as string | null };
      let delivered: { convo: ScheduledConversation; message: RecordedMessage } | null = null;
      let reason = "";
      try {
        delivered = await withSavepoint(async () => {
          const convo = await findConversationById(m.conversationId);
          if (!convo) throw new Error("The conversation no longer exists.");

          let dispatched: Awaited<ReturnType<typeof sendReplyOnChannel>>;
          try {
            // Sent on the conversation's own channel, like a live reply. A
            // scheduled reply on a channel that is not connected (or unsupported)
            // fails here with the dispatcher's reason, which is the honest outcome.
            dispatched = await sendReplyOnChannel(
              {
                organizationId: convo.organizationId,
                channel: convo.channel,
                phoneNumberId: convo.phoneNumberId,
                contactWaId: convo.contactWaId,
                contactExternalId: convo.contactExternalId,
                conversationId: convo.id,
              },
              m.body
            );
          } catch (err) {
            // The commonest failure is Meta refusing a free-form message outside
            // the 24-hour window. Its own words are the most useful thing to keep.
            logger.warn({ id: m.id, conversationId: convo.id, channel: convo.channel }, "Scheduled message refused");
            throw err;
          }
          progress.wentOut = true;
          progress.waMessageId = dispatched.waMessageId;

          const message = await insertOutboundMessage({
            organizationId: convo.organizationId,
            conversationId: convo.id,
            contactId: convo.contactId,
            senderType: "human_agent",
            senderId: m.createdBy ?? undefined,
            body: m.body,
            waMessageId: dispatched.waMessageId ?? undefined,
            socialMessageId: dispatched.socialMessageId ?? undefined,
            emailMessageId: dispatched.emailMessageId ?? undefined,
            emailThreadId: dispatched.emailThreadId ?? undefined,
          });

          // A person's message took this conversation, just on a delay: pause the
          // agent for the contact and put the thread in human custody, exactly as a
          // live human reply does.
          await Promise.all([
            pauseAiForContact(convo.contactId, 24),
            setConversationHandoff(convo.id, true, "human_replied", m.createdBy ?? null),
          ]);
          return { convo, message };
        });
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err);
      }

      // How the row ends: sent if it went out, even when its record could not
      // be saved; failed, with the reason, if it never did.
      try {
        await withSavepoint(() =>
          progress.wentOut ? markScheduledMessageSent(m.id, progress.waMessageId) : markScheduledMessageFailed(m.id, reason)
        );
      } catch (err) {
        // Left 'sending': claimed, so it is never sent again, and this says why.
        logger.error({ id: m.id, err }, "A scheduled message's outcome could not be recorded");
      }

      if (delivered) {
        await publishInboxEvent({
          type: "message",
          organizationId: delivered.convo.organizationId,
          organizationSlug: delivered.convo.organizationSlug,
          conversationId: delivered.convo.id,
          message: delivered.message,
        }).catch((err) => logger.warn({ id: m.id, err }, "A sent scheduled message could not be announced to the inbox"));
        logger.info({ id: m.id, conversationId: delivered.convo.id }, "Sent a scheduled message");
      } else if (progress.wentOut) {
        logger.error({ id: m.id, reason }, "A scheduled message was sent but could not be recorded in its conversation");
      }
    }
    })
  );
}
