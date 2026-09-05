import { Hono } from "hono";
import {
  findConversationById,
  getMessagesForConversation,
  insertOutboundMessage,
  pauseAiForContact,
  resumeAiForContact,
  setConversationHandoff,
  setConversationTags,
  getConversationDetails,
  updateContactDetails,
  listCustody,
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

/**
 * How this conversation has changed hands.
 *
 * Migration 062 started recording it; until this endpoint there was nowhere to
 * read it except psql, which makes it a feature that writes and never answers.
 *
 * SEPARATE FROM /messages, not folded into it. The inbox loads messages on
 * every conversation switch and this is opened deliberately, by somebody asking
 * a question the messages do not answer -- who has this, and since when. Making
 * every inbox click pay for a second query to serve the rare case would be the
 * wrong trade.
 *
 * AN EMPTY LIST MEANS "NOT RECORDED", NEVER "NEVER HELD". Migration 062
 * backfills nothing on purpose, so every conversation that changed hands before
 * it has no history and cannot be given one honestly. The response says which
 * of the two it is rather than leaving the caller to guess -- an absent record
 * answering a question it was never asked is the defect this whole table exists
 * to end, and it would be a poor joke to reintroduce it in the reader.
 */
conversationsRoute.get("/:id/custody", async (c) => {
  const conversationId = c.req.param("id");
  const conversation = await findConversationById(conversationId);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);

  const events = await listCustody(conversationId);
  return c.json({
    events,
    /**
     * True when this conversation predates custody recording, so the client can
     * say "not recorded" instead of drawing an empty timeline that reads as
     * "the agent has always had this".
     */
    predatesRecording: events.length === 0,
  });
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
    // A person typed to this customer, which is what takes the conversation --
    // the flag is a consequence of the reply, not a separate decision.
    setConversationHandoff(conversationId, true, "human_replied", body.senderId ?? null),
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

/**
 * The contact/details panel for one conversation, in a single read.
 */
conversationsRoute.get("/:id/details", async (c) => {
  const details = await getConversationDetails(c.req.param("id"));
  if (!details) return c.json({ error: "Conversation not found" }, 404);
  return c.json({ details });
});

/**
 * Update the hand-edited fields on the conversation's contact.
 *
 * Partial: only the keys present in the body are written. Everything is
 * normalised at the edge — a lead stage and notes trimmed and length-capped,
 * custom fields reduced to a flat string→string map (values coerced to text,
 * blank keys dropped, capped at 40 fields) so a jsonb column can never grow a
 * shape the panel cannot render.
 */
conversationsRoute.patch("/:id/details", async (c) => {
  const conversationId = c.req.param("id");
  const body = await c.req.json<{
    leadStage?: unknown;
    notes?: unknown;
    customFields?: unknown;
  }>().catch(() => null);
  if (!body) return c.json({ error: "Nothing to change." }, 400);

  const details = await getConversationDetails(conversationId);
  if (!details) return c.json({ error: "Conversation not found" }, 404);

  const patch: { leadStage?: string | null; notes?: string | null; customFields?: Record<string, string> } = {};

  if ("leadStage" in body) {
    const v = typeof body.leadStage === "string" ? body.leadStage.trim().slice(0, 60) : "";
    patch.leadStage = v || null;
  }
  if ("notes" in body) {
    const v = typeof body.notes === "string" ? body.notes.slice(0, 4000) : "";
    patch.notes = v.trim() ? v : null;
  }
  if ("customFields" in body) {
    const fields: Record<string, string> = {};
    if (body.customFields && typeof body.customFields === "object") {
      for (const [rawKey, rawVal] of Object.entries(body.customFields as Record<string, unknown>)) {
        const key = rawKey.trim().slice(0, 40);
        if (!key) continue;
        const value = (typeof rawVal === "string" ? rawVal : String(rawVal ?? "")).slice(0, 400);
        fields[key] = value;
        if (Object.keys(fields).length >= 40) break;
      }
    }
    patch.customFields = fields;
  }

  await updateContactDetails(details.contactId, patch);
  const updated = await getConversationDetails(conversationId);
  return c.json({ details: updated });
});

/**
 * Set the labels on a conversation.
 *
 * The whole set is sent and the whole set is stored — see setConversationTags.
 * Normalised HERE, at the edge, so nothing malformed reaches the column: each
 * label trimmed, empties dropped, de-duped case-insensitively (keeping the first
 * spelling), each capped at 40 characters and the set at 15. A jsonb-free text
 * array, so the cap is a courtesy to the UI, not a safety boundary.
 */
conversationsRoute.patch("/:id/tags", async (c) => {
  const conversationId = c.req.param("id");
  const body = await c.req.json<{ tags?: unknown }>().catch(() => null);
  if (!Array.isArray(body?.tags)) return c.json({ error: "tags (an array) is required" }, 400);

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of body.tags) {
    if (typeof raw !== "string") continue;
    const label = raw.trim().slice(0, 40);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(label);
    if (tags.length >= 15) break;
  }

  const conversation = await findConversationById(conversationId);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);

  await setConversationTags(conversationId, tags);
  return c.json({ tags });
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

  // The only writer that can go either way, so it is the only one whose
  // recorded `held` is not implied by its reason.
  // Read straight off the context rather than through a helper this route does
  // not have. Null when there is no session subject, which the column allows --
  // an unattributed toggle is still worth more than no record of the toggle.
  const actor = (c.get("scope") as { sub?: string } | undefined)?.sub ?? null;
  await setConversationHandoff(conversationId, body.isHumanHandoff, "manual_toggle", actor);
  // SYMMETRICAL, and it was not. Turning the handoff ON paused the agent for
  // a day; turning it OFF cleared the flag and left the pause standing, so a
  // customer writing back within that day reached a conversation nobody was
  // watching and an agent that would not answer.
  if (body.isHumanHandoff) {
    await pauseAiForContact(conversation.contactId, 24);
  } else {
    await resumeAiForContact(conversation.contactId);
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
