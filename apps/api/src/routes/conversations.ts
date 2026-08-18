import { Hono } from "hono";
import {
  findConversationById,
  getMessagesForConversation,
  insertOutboundMessage,
  pauseAiForContact,
  setConversationHandoff,
} from "@nexus/db";
import { sendWhatsAppText } from "../lib/whatsapp-client.js";
import { publishInboxEvent } from "../lib/pubsub.js";
import { logger } from "../lib/logger.js";

export const conversationsRoute = new Hono();

conversationsRoute.get("/:id/messages", async (c) => {
  const conversationId = c.req.param("id");
  const messages = await getMessagesForConversation(conversationId);
  return c.json({ messages });
});

// A human agent replies from the Unified Inbox. Per spec, once a human
// steps in the AI agent is paused on this contact for 24 hours.
conversationsRoute.post("/:id/messages", async (c) => {
  const conversationId = c.req.param("id");
  const body = await c.req.json<{ text?: string; senderId?: string }>().catch(() => null);
  if (!body?.text) return c.json({ error: "text is required" }, 400);

  const conversation = await findConversationById(conversationId);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);

  // Declared out here so the insert below can carry Meta's receipt. Null when
  // Meta accepted the send without returning an id — rare, and not a failure.
  let waMessageId: string | null = null;
  try {
    waMessageId = await sendWhatsAppText(
      conversation.phoneNumberId,
      conversation.contactWaId,
      body.text
    );
  } catch (err) {
    logger.error({ conversationId, err }, "Failed to send human-agent reply via WhatsApp");
    return c.json({ error: "Failed to send message" }, 502);
  }

  const message = await insertOutboundMessage({
    organizationId: conversation.organizationId,
    conversationId,
    contactId: conversation.contactId,
    senderType: "human_agent",
    senderId: body.senderId,
    body: body.text,
    // A person's own words to a customer. If anything on this platform deserves
    // to know whether it arrived, it is this rather than an agent's reply.
    waMessageId: waMessageId ?? undefined,
  });

  await Promise.all([
    pauseAiForContact(conversation.contactId, 24),
    setConversationHandoff(conversationId, true),
  ]);

  await publishInboxEvent({
    type: "message",
    organizationId: conversation.organizationId,
    organizationSlug: conversation.organizationSlug,
    conversationId,
    message,
  });
  await publishInboxEvent({
    type: "handoff_changed",
    organizationId: conversation.organizationId,
    organizationSlug: conversation.organizationSlug,
    conversationId,
    isHumanHandoff: true,
  });

  return c.json({ message });
});

// Manual handoff toggle (the Unified Inbox checkbox). Turning it on also
// pauses the AI for 24h, matching the same-spirit reasoning as an actual
// human reply; turning it off hands the conversation back to the AI agent
// immediately (no residual pause).
conversationsRoute.patch("/:id/handoff", async (c) => {
  const conversationId = c.req.param("id");
  const body = await c.req.json<{ isHumanHandoff?: boolean }>().catch(() => null);
  if (typeof body?.isHumanHandoff !== "boolean") {
    return c.json({ error: "isHumanHandoff (boolean) is required" }, 400);
  }

  const conversation = await findConversationById(conversationId);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);

  await setConversationHandoff(conversationId, body.isHumanHandoff);
  if (body.isHumanHandoff) {
    await pauseAiForContact(conversation.contactId, 24);
  }

  await publishInboxEvent({
    type: "handoff_changed",
    organizationId: conversation.organizationId,
    organizationSlug: conversation.organizationSlug,
    conversationId,
    isHumanHandoff: body.isHumanHandoff,
  });

  return c.json({ isHumanHandoff: body.isHumanHandoff });
});
