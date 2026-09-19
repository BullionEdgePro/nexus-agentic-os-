import type { Job } from "bullmq";
import type { MessageDto, SocialInboundJob } from "@nexus/shared";
import {
  organizationForConnectedPage,
  findOrCreateContactByExternalId,
  findOrCreateSocialConversation,
  insertInboundSocialMessage,
  findOrganizationById,
  withTenant,
} from "@nexus/db";
import { parseMessagingWebhook, type IncomingSocialMessage } from "../lib/messenger-client.js";
import { publishInboxEvent } from "../lib/pubsub.js";
import { logger } from "../lib/logger.js";

/**
 * Inbound Facebook Page (Messenger) and Instagram messages, filed into the inbox.
 *
 * ============================================================
 * INGEST ONLY — NO REPLY, AND DORMANT UNTIL A PAGE IS CONNECTED
 * ============================================================
 *
 * This is the receiving half of the FB/IG channels. It parses the delivery
 * (slice 1's parseMessagingWebhook), resolves which business owns the Page,
 * settles who the sender is (slice 2's external-identity resolver), and records
 * the message on a conversation of the right channel — so a Messenger thread
 * appears in the same inbox as WhatsApp. It does NOT compose or send a reply:
 * answering on Page/IG needs Meta App Review (pages_messaging /
 * instagram_manage_messages) and a page access token, and that is a later slice.
 *
 * It is dormant today by construction: organizationForConnectedPage returns null
 * for every Page until the connect flow writes a social_connections row, so every
 * delivery is logged and dropped. Nothing here fabricates a business or a reply.
 *
 * Each message is isolated in its own try/catch, exactly as the WhatsApp
 * processor isolates each message in a batch: one malformed delivery must not
 * make BullMQ retry the whole webhook and re-file the messages beside it.
 */
export async function processSocialInboundJob(job: Job<SocialInboundJob>): Promise<void> {
  const events = parseMessagingWebhook(job.data.payload as Parameters<typeof parseMessagingWebhook>[0]);
  for (const event of events) {
    try {
      await ingestOneSocialMessage(event);
    } catch (err) {
      logger.error(
        { err, channel: event.channel, pageId: event.pageId, messageId: event.messageId },
        "Failed to ingest a Messenger/Instagram message"
      );
    }
  }
}

async function ingestOneSocialMessage(event: IncomingSocialMessage): Promise<void> {
  // Text only, matching every other channel on this platform. A sticker or an
  // attachment parses (mid + sender present) but has no body to render, so it is
  // dropped rather than filed as a blank message. What must never happen is a
  // message invented from nothing — parseMessagingWebhook already guaranteed that.
  if (!event.text) {
    logger.info(
      { channel: event.channel, pageId: event.pageId },
      "Social message with no text (attachment/sticker) — not filed"
    );
    return;
  }

  const organizationId = await organizationForConnectedPage(event.pageId);
  if (!organizationId) {
    // DORMANT PATH: no business has connected this Page yet, so there is nobody
    // to file the message under. Logged, not errored — this is the expected
    // state of the whole channel until the connect flow exists.
    logger.info(
      { channel: event.channel, pageId: event.pageId },
      "Inbound social message for a Page no business has connected — dropped"
    );
    return;
  }

  const contact = await findOrCreateContactByExternalId({
    organizationId,
    channel: event.channel,
    externalId: event.senderId,
  });

  const filed = await withTenant(organizationId, async () => {
    const conversationId = await findOrCreateSocialConversation(
      organizationId,
      contact.contactId,
      event.channel
    );
    const stored = await insertInboundSocialMessage({
      organizationId,
      conversationId,
      contactId: contact.contactId,
      body: event.text,
      socialMessageId: event.messageId,
      receivedAtMs: event.timestamp,
    });
    // Null message id means Meta redelivered a message already stored — the first
    // delivery already filed it, so there is nothing to redo or re-publish.
    if (!stored.messageId) return null;
    return { conversationId, messageId: stored.messageId };
  });

  if (!filed) return;

  const organization = await findOrganizationById(organizationId);
  if (!organization) return;

  const inboundDto: MessageDto = {
    id: filed.messageId,
    conversationId: filed.conversationId,
    direction: "inbound",
    senderType: "contact",
    body: event.text,
    status: "delivered",
    createdAt: new Date(event.timestamp > 0 ? event.timestamp : Date.now()).toISOString(),
  };
  await publishInboxEvent({
    type: "message",
    organizationId: organization.id,
    organizationSlug: organization.slug,
    conversationId: filed.conversationId,
    message: inboundDto,
  });

  logger.info(
    { organizationId, conversationId: filed.conversationId, channel: event.channel },
    "Filed an inbound Messenger/Instagram message into the inbox"
  );
}
