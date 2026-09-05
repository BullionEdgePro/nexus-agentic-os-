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
import { completeText } from "@nexus/agents";
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
 * Draft a reply for the human to send — AI Assist.
 *
 * Reads the recent transcript and drafts the next reply in the business's voice.
 * It NEVER sends: the text comes back to the compose box for a person to read,
 * edit and send (or discard). The model is told not to invent facts, prices or
 * promises and to leave a holding reply it cannot answer confidently — the same
 * discipline the auto-reply path keeps, because a suggestion a tired person
 * sends unread is an auto-reply by another name.
 */
conversationsRoute.post("/:id/suggest", async (c) => {
  const conversationId = c.req.param("id");
  const conversation = await findConversationById(conversationId);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);

  const messages = await getMessagesForConversation(conversationId, 14);
  const transcript = messages
    .filter((m) => m.body)
    .map((m) => `${m.direction === "inbound" ? "Customer" : "Us"}: ${m.body}`)
    .join("\n");
  if (!transcript) return c.json({ error: "Nothing to reply to yet." }, 400);

  const suggestion = await completeText({
    system:
      "You draft the next reply for a business's support team on WhatsApp. Write one concise, warm, professional message answering the customer's latest point, using the conversation so far. NEVER invent facts, prices, availability, dates or promises — if the answer is not in the conversation, write a short holding reply a colleague can finish. Return ONLY the reply text, with no preamble, labels or quotation marks.",
    prompt: `Conversation so far:\n${transcript}\n\nDraft the next reply from Us.`,
    maxTokens: 400,
  });

  if (!suggestion) {
    return c.json({ error: "The assistant is not available right now — write the reply yourself." }, 503);
  }
  return c.json({ suggestion });
});

/**
 * Polish a draft's spelling and grammar without changing what it says.
 *
 * Takes whatever is in the box and returns a cleaner version — meaning, tone and
 * every specific fact or number left exactly as written. Body-only; it does not
 * read the conversation, so a half-typed reply is polished on its own terms.
 */
conversationsRoute.post("/:id/polish", async (c) => {
  const body = await c.req.json<{ text?: unknown }>().catch(() => null);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "Nothing to polish." }, 400);
  if (text.length > 2000) return c.json({ error: "That is longer than the polisher takes at once." }, 413);

  const polished = await completeText({
    system:
      "You fix spelling, grammar and clarity in a support agent's draft reply. Keep the meaning, the tone, and every specific fact, name, price and number exactly as written. Do not add or remove information, and do not answer anything — only correct. Return ONLY the corrected text, with no preamble or quotation marks.",
    prompt: text,
    maxTokens: 500,
  });

  if (!polished) {
    return c.json({ error: "The polisher is not available right now." }, 503);
  }
  return c.json({ text: polished });
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
