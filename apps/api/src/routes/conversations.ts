import { Hono } from "hono";
import {
  findConversationById,
  getMessagesForConversation,
  insertOutboundMessage,
  pauseAiForContact,
  resumeAiForContact,
  setConversationHandoff,
  setConversationTags,
  setConversationCollaborators,
  getConversationDetails,
  updateContactDetails,
  listOrgStaffNames,
  getConversationRouting,
  createScheduledMessage,
  listPendingScheduledMessages,
  cancelScheduledMessage,
  listCustody,
  listCallLogs,
  createCallLog,
  deleteCallLog,
  setConversationStatus,
  listConversationEvents,
  markConversationRead,
  listConversationNotes,
  addConversationNote,
  deleteConversationNote,
  resolveActorNames,
  type CallDirection,
  type CallOutcome,
  type CallLog,
  type CustodyEvent,
  getInboundMediaRef,
} from "@nexus/db";
import type { ConversationEvent, TimelineItem } from "@nexus/shared";
import { completeText } from "@nexus/agents";
import { sendReplyOnChannel } from "../lib/reply-dispatch.js";
import { downloadWhatsAppMedia } from "../lib/whatsapp-client.js";
import { publishInboxEvent } from "../lib/pubsub.js";
import { logger } from "../lib/logger.js";
import { actorOf } from "../lib/actor.js";

export const conversationsRoute = new Hono();

// ============================================================
// The thread's timeline — what HAPPENED, beside what was SAID
// ============================================================
//
// Assignments, resolves, handoffs to and from the AI, and logged calls, each as
// one sentence the server writes so every client says the same thing. Merged
// into the message list by time on the client ("single threaded chat and call
// view"), so a colleague reading a thread sees who picked it up and when without
// opening a second panel.

const CALL_OUTCOME_WORDS: Record<CallOutcome, string> = {
  answered: "answered",
  "no-answer": "no answer",
  voicemail: "voicemail",
  busy: "busy",
  failed: "failed",
};

function duration(seconds: number | null): string {
  if (seconds == null) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return ` · ${m}:${String(s).padStart(2, "0")}`;
}

function eventSentence(e: ConversationEvent): { text: string; tone: TimelineItem["tone"] } {
  const who = e.actorName ?? "Someone";
  switch (e.kind) {
    case "assigned":
      return { text: `${who} assigned this chat to ${e.subjectName ?? "a colleague"}`, tone: "neutral" };
    case "unassigned":
      return { text: `${who} unassigned this chat`, tone: "neutral" };
    case "resolved":
      return { text: `${who} marked this conversation resolved`, tone: "good" };
    case "reopened":
      return { text: `Reopened by ${who}`, tone: "warn" };
  }
}

// Keyed by bare names on purpose: the route's quoted reason strings are the
// takeover calls below, which a guard test finds by their first occurrence.
const CUSTODY_WORDS: Record<
  CustodyEvent["reason"],
  (who: string, held: boolean) => { text: string; tone: TimelineItem["tone"] }
> = {
  agent_escalated: () => ({ text: "The AI handed this chat to a person", tone: "warn" }),
  human_replied: (who) => ({ text: `${who} replied — the AI is paused on this chat`, tone: "neutral" }),
  taken_by_employee: (who) => ({ text: `${who} took this chat over`, tone: "neutral" }),
  manual_toggle: (who, held) =>
    held
      ? { text: `${who} took this chat over from the AI`, tone: "neutral" }
      : { text: `${who} handed this chat back to the AI`, tone: "good" },
  stale_release: () => ({ text: "Handed back to the AI after a quiet spell", tone: "neutral" }),
};

function custodySentence(ev: CustodyEvent, name: string | null): { text: string; tone: TimelineItem["tone"] } {
  return CUSTODY_WORDS[ev.reason](name ?? "A colleague", ev.held);
}

function callSentence(call: CallLog): string {
  const dir = call.direction === "inbound" ? "Incoming call" : "Outgoing call";
  const notes = call.notes ? ` — ${call.notes.length > 140 ? `${call.notes.slice(0, 140)}…` : call.notes}` : "";
  return `📞 ${dir} · ${CALL_OUTCOME_WORDS[call.outcome]}${duration(call.durationSeconds)}${notes}`;
}

async function buildTimeline(conversationId: string): Promise<TimelineItem[]> {
  const [events, custody, calls] = await Promise.all([
    listConversationEvents(conversationId).catch(() => [] as ConversationEvent[]),
    listCustody(conversationId, 100).catch(() => [] as CustodyEvent[]),
    listCallLogs(conversationId).catch(() => [] as CallLog[]),
  ]);
  const names = await resolveActorNames(custody.map((ev) => ev.actor ?? "")).catch(
    () => new Map<string, string>()
  );

  const items: TimelineItem[] = [
    ...events.map((e) => ({ id: `ev-${e.id}`, kind: "event" as const, at: e.createdAt, ...eventSentence(e) })),
    ...custody.map((ev, i) => ({
      id: `cu-${ev.createdAt}-${i}`,
      kind: "custody" as const,
      at: ev.createdAt,
      ...custodySentence(ev, ev.actor ? names.get(ev.actor) ?? null : null),
    })),
    ...calls.map((call) => ({
      id: `call-${call.id}`,
      kind: "call" as const,
      at: call.occurredAt,
      text: callSentence(call),
      tone: (call.outcome === "answered" ? "good" : "neutral") as TimelineItem["tone"],
    })),
  ];
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

conversationsRoute.get("/:id/messages", async (c) => {
  const conversationId = c.req.param("id");
  const [messages, timeline] = await Promise.all([
    getMessagesForConversation(conversationId),
    buildTimeline(conversationId),
  ]);
  return c.json({ messages, timeline });
});

/**
 * The file a customer sent — a photo, video, voice note, document or sticker.
 *
 * Fetched from Meta on demand rather than stored: the bytes stay on Meta's side
 * (about 30 days) and Nexus keeps only the id. Behind the same conversation
 * scope as the thread itself, and the message must belong to this conversation,
 * so a guessed id from another chat returns 404.
 */
conversationsRoute.get("/:id/messages/:messageId/media", async (c) => {
  const ref = await getInboundMediaRef(c.req.param("id"), c.req.param("messageId"));
  if (!ref) return c.json({ error: "There is no file on that message." }, 404);
  const file = await downloadWhatsAppMedia(ref.phoneNumberId, ref.mediaId).catch((err) => {
    logger.warn({ err, messageId: c.req.param("messageId") }, "Attachment download failed");
    return null;
  });
  if (!file) {
    return c.json(
      { error: "WhatsApp no longer has this file. Attachments expire about 30 days after they're sent." },
      410
    );
  }
  const safeName = (ref.filename ?? "attachment").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
  return new Response(file.bytes, {
    headers: {
      "Content-Type": ref.mimeType ?? file.mimeType,
      "Content-Disposition": `inline; filename="${safeName}"`,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

/** "I have seen this thread" — per person, for the Unread folder and badges. */
conversationsRoute.post("/:id/read", async (c) => {
  const { reader } = await actorOf(c);
  if (!reader) return c.json({ error: "Sign in to track what you have read." }, 401);
  await markConversationRead(c.req.param("id"), reader);
  return c.json({ ok: true });
});

/**
 * Resolve a conversation, or open it again.
 *
 * Resolving never sends anything and never touches the AI — it files the thread
 * as done. A customer who writes again reopens it (migration 090 trigger), so
 * "resolved" cannot silently swallow a new message.
 */
conversationsRoute.patch("/:id/status", async (c) => {
  const conversationId = c.req.param("id");
  const body = await c.req.json<{ status?: unknown }>().catch(() => null);
  const status = body?.status;
  if (status !== "resolved" && status !== "open") {
    return c.json({ error: "status must be 'resolved' or 'open'" }, 400);
  }

  const conversation = await findConversationById(conversationId);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);

  const actor = await actorOf(c);
  await setConversationStatus(conversationId, status, actor.id, actor.name);

  await publishInboxEvent({
    type: "status_changed",
    organizationId: conversation.organizationId,
    organizationSlug: conversation.organizationSlug,
    conversationId,
    status,
  });
  return c.json({ status });
});

// ============================================================
// Internal notes — a timeline, never sent to the customer
// ============================================================

conversationsRoute.get("/:id/notes", async (c) => {
  const notes = await listConversationNotes(c.req.param("id"));
  return c.json({ notes });
});

conversationsRoute.post("/:id/notes", async (c) => {
  const conversationId = c.req.param("id");
  const body = await c.req.json<{ body?: unknown }>().catch(() => null);
  const text = typeof body?.body === "string" ? body.body.trim() : "";
  if (!text) return c.json({ error: "Write the note first." }, 400);
  if (text.length > 4000) return c.json({ error: "That note is too long — keep it under 4,000 characters." }, 400);

  const actor = await actorOf(c);
  const note = await addConversationNote({ conversationId, author: actor.id, authorName: actor.name, body: text });
  if (!note) return c.json({ error: "Conversation not found" }, 404);
  return c.json({ note }, 201);
});

conversationsRoute.delete("/:id/notes/:noteId", async (c) => {
  const actor = await actorOf(c);
  const ok = await deleteConversationNote(c.req.param("id"), c.req.param("noteId"), actor.id);
  if (!ok) return c.json({ error: "Only the person who wrote a note can delete it." }, 403);
  return c.json({ ok: true });
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
  const body = await c.req.json<{ text?: string }>().catch(() => null);
  if (!body?.text) return c.json({ error: "text is required" }, 400);

  // WHO IS TYPING comes from the session, never the body — this read a
  // `senderId` the client never sent, so every human reply was unattributed.
  const actor = await actorOf(c);

  const conversation = await findConversationById(conversationId);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);

  // Sent on the channel the conversation is actually on — WhatsApp, Messenger or
  // Instagram — not always WhatsApp. The dispatcher returns the provider's id in
  // the field that belongs to that channel; both null when it accepted without
  // one, which is rare and not a failure.
  let dispatched: {
    waMessageId: string | null;
    socialMessageId: string | null;
    emailMessageId: string | null;
    emailThreadId: string | null;
  };
  try {
    dispatched = await sendReplyOnChannel(
      {
        organizationId: conversation.organizationId,
        channel: conversation.channel,
        phoneNumberId: conversation.phoneNumberId,
        contactWaId: conversation.contactWaId,
        contactExternalId: conversation.contactExternalId,
        conversationId,
      },
      body.text
    );
  } catch (err) {
    logger.error({ conversationId, channel: conversation.channel, err }, "Failed to send human-agent reply");
    return c.json({ error: err instanceof Error ? err.message : "Failed to send message" }, 502);
  }

  const message = await insertOutboundMessage({
    organizationId: conversation.organizationId,
    conversationId,
    contactId: conversation.contactId,
    senderType: "human_agent",
    senderId: actor.id ?? undefined,
    body: body.text,
    // A person's own words to a customer. If anything on this platform deserves
    // to know whether it arrived, it is this rather than an agent's reply.
    waMessageId: dispatched.waMessageId ?? undefined,
    socialMessageId: dispatched.socialMessageId ?? undefined,
    // An email reply stores its Gmail id (so the sweep dedups it) and thread.
    emailMessageId: dispatched.emailMessageId ?? undefined,
    emailThreadId: dispatched.emailThreadId ?? undefined,
  });

  await Promise.all([
    pauseAiForContact(conversation.contactId, 24),
    // A person typed to this customer, which is what takes the conversation --
    // the flag is a consequence of the reply, not a separate decision.
    setConversationHandoff(conversationId, true, "human_replied", actor.id),
  ]);

  await publishInboxEvent({
    type: "message",
    organizationId: conversation.organizationId,
    organizationSlug: conversation.organizationSlug,
    conversationId,
    message: { ...message, senderName: actor.name },
  });
  await publishInboxEvent({
    type: "handoff_changed",
    organizationId: conversation.organizationId,
    organizationSlug: conversation.organizationSlug,
    conversationId,
    isHumanHandoff: true,
  });

  return c.json({ message: { ...message, senderName: actor.name } });
});

// ============================================================
// Scheduled messages
// ============================================================

/** The still-pending scheduled sends on this conversation. */
conversationsRoute.get("/:id/scheduled", async (c) => {
  const scheduled = await listPendingScheduledMessages(c.req.param("id"));
  return c.json({ scheduled });
});

/**
 * Schedule a reply to send later.
 *
 * The one inbox action that reaches a customer with no human at the moment of
 * sending, so it is validated hard: a real message, a time that is actually in
 * the future and not absurdly far off. It records who scheduled it. It does NOT
 * check the 24-hour window here — that window is about when it FIRES, not when it
 * is set, and the sweep marks a send Meta refuses as failed-with-reason rather
 * than pretending at schedule time to know what the window will be then.
 */
conversationsRoute.post("/:id/scheduled", async (c) => {
  const conversationId = c.req.param("id");
  const body = await c.req.json<{ body?: unknown; sendAt?: unknown }>().catch(() => null);

  const text = typeof body?.body === "string" ? body.body.trim() : "";
  if (!text) return c.json({ error: "Write the message to schedule." }, 400);
  if (text.length > 4000) return c.json({ error: "That message is too long." }, 400);

  const when = typeof body?.sendAt === "string" ? new Date(body.sendAt) : new Date(NaN);
  if (Number.isNaN(when.getTime())) return c.json({ error: "That is not a valid time." }, 400);
  if (when.getTime() < Date.now() + 30_000) {
    return c.json({ error: "Pick a time at least a minute from now." }, 400);
  }
  if (when.getTime() > Date.now() + 60 * 24 * 3600_000) {
    return c.json({ error: "That is more than 60 days away — closer, please." }, 400);
  }

  const conversation = await findConversationById(conversationId);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);

  const createdBy = (c.get("scope") as { sub?: string } | undefined)?.sub ?? null;
  const scheduled = await createScheduledMessage({
    organizationId: conversation.organizationId,
    conversationId,
    contactId: conversation.contactId,
    body: text,
    sendAt: when,
    createdBy,
  });
  return c.json({ scheduled }, 201);
});

/** Cancel a pending scheduled send before it fires. */
conversationsRoute.delete("/:id/scheduled/:scheduledId", async (c) => {
  const ok = await cancelScheduledMessage(c.req.param("id"), c.req.param("scheduledId"));
  if (!ok) return c.json({ error: "That message has already sent or been cancelled." }, 409);
  return c.json({ ok: true });
});

// ============================================================
// Call logs
// ============================================================
//
// A record that a phone call happened — logged by hand today, and by a
// telephony provider automatically once one is wired in. The platform cannot
// place a call itself, so this deliberately does not pretend to: it stores what
// a person tells it about a call that already occurred. A call is not a message,
// so it lives in its own table and its own panel rather than in the transcript.

const CALL_DIRECTIONS: CallDirection[] = ["inbound", "outbound"];
const CALL_OUTCOMES: CallOutcome[] = ["answered", "no-answer", "voicemail", "busy", "failed"];

/** The calls logged on this conversation, most recent first. */
conversationsRoute.get("/:id/calls", async (c) => {
  const calls = await listCallLogs(c.req.param("id"));
  return c.json({ calls });
});

/**
 * Log a call. Validated at the edge: a known direction and outcome, a duration
 * that is a non-negative whole number of seconds if given, notes length-capped.
 * The org and contact are taken from the resolved conversation, never the body,
 * so a call cannot be filed against a tenant the caller does not hold.
 */
conversationsRoute.post("/:id/calls", async (c) => {
  const conversationId = c.req.param("id");
  const body = await c.req.json<{
    direction?: unknown;
    outcome?: unknown;
    durationSeconds?: unknown;
    notes?: unknown;
    occurredAt?: unknown;
  }>().catch(() => null);

  const direction = body?.direction;
  if (typeof direction !== "string" || !CALL_DIRECTIONS.includes(direction as CallDirection)) {
    return c.json({ error: "Say whether the call was inbound or outbound." }, 400);
  }
  const outcome = body?.outcome;
  if (typeof outcome !== "string" || !CALL_OUTCOMES.includes(outcome as CallOutcome)) {
    return c.json({ error: "Pick how the call went." }, 400);
  }

  let durationSeconds: number | null = null;
  if (body?.durationSeconds != null && body.durationSeconds !== "") {
    const n = Number(body.durationSeconds);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      return c.json({ error: "Duration must be a whole number of seconds." }, 400);
    }
    if (n > 24 * 3600) return c.json({ error: "That call is longer than a day — check the duration." }, 400);
    durationSeconds = n;
  }

  const notes = typeof body?.notes === "string" ? body.notes.slice(0, 2000).trim() || null : null;

  let occurredAt: Date | undefined;
  if (typeof body?.occurredAt === "string" && body.occurredAt) {
    const when = new Date(body.occurredAt);
    if (Number.isNaN(when.getTime())) return c.json({ error: "That is not a valid time." }, 400);
    if (when.getTime() > Date.now() + 60_000) return c.json({ error: "A call cannot be in the future." }, 400);
    occurredAt = when;
  }

  const conversation = await findConversationById(conversationId);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);

  const loggedBy = (c.get("scope") as { sub?: string } | undefined)?.sub ?? null;
  const call = await createCallLog({
    organizationId: conversation.organizationId,
    conversationId,
    contactId: conversation.contactId,
    direction: direction as CallDirection,
    outcome: outcome as CallOutcome,
    durationSeconds,
    notes,
    loggedBy,
    occurredAt,
  });
  return c.json({ call }, 201);
});

/** Remove a logged call — a mistyped entry, not a way to rewrite history. */
conversationsRoute.delete("/:id/calls/:callId", async (c) => {
  const ok = await deleteCallLog(c.req.param("id"), c.req.param("callId"));
  if (!ok) return c.json({ error: "That call log is already gone." }, 409);
  return c.json({ ok: true });
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
      "You draft the next reply for a business's support team, in a customer messaging thread (WhatsApp, email, Messenger or Instagram). Write one concise, warm, professional message answering the customer's latest point, using the conversation so far. NEVER invent facts, prices, availability, dates or promises — if the answer is not in the conversation, write a short holding reply a colleague can finish. Return ONLY the reply text, with no preamble, labels or quotation marks.",
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
 * The whole thread in five lines — AI chat summary.
 *
 * For the colleague picking a conversation up cold: who this is, what they
 * want, what has been answered or promised, what is still open, and the next
 * step. Read from the thread's latest 60 messages and nothing else; the model
 * is told to leave out anything the thread does not say, because a summary that
 * invents a promise is worse than no summary — the reader acts on it without
 * scrolling up to check.
 *
 * Nothing is stored: a summary is only as current as the thread, and a saved
 * one would go stale the moment the customer wrote again.
 */
conversationsRoute.post("/:id/summary", async (c) => {
  const conversationId = c.req.param("id");
  const conversation = await findConversationById(conversationId);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);

  const messages = await getMessagesForConversation(conversationId, 60);
  const transcript = messages
    .filter((m) => m.body)
    .map((m) => {
      const who =
        m.direction === "inbound"
          ? "Customer"
          : m.senderType === "ai_agent"
            ? "AI agent"
            : m.senderType === "system"
              ? "System"
              : (m.senderName ?? "Staff");
      return `${who}: ${m.body}`;
    })
    .join("\n")
    .slice(-12_000);
  if (!transcript) return c.json({ error: "There is nothing in this conversation to summarise yet." }, 400);

  const summary = await completeText({
    system:
      "You summarise a customer conversation for a colleague who is about to take it over. Write at most five short bullet lines, each starting with '• ', covering only what the conversation actually says: who the customer is and what they want; what has been answered; anything promised (with dates or amounts exactly as stated); what is still open; and the sensible next step. Never add facts, prices, dates or promises the conversation does not contain. If the thread is spam or a sales pitch to the business, say so in one line. Return only the bullets.",
    prompt: transcript,
    maxTokens: 350,
  });
  if (!summary) {
    return c.json({ error: "The assistant is not available right now — read the thread instead." }, 503);
  }
  return c.json({ summary, messageCount: messages.length });
});

/**
 * The contact/details panel for one conversation, in a single read.
 *
 * Also carries the two things the Collaborators control needs: who is already on
 * the thread (resolved to names) and the roster to pick more from. Names come
 * from the org's employee list, so a rename or a departure needs no backfill on
 * the conversation — a collaborator whose row is gone simply drops off the list.
 */
conversationsRoute.get("/:id/details", async (c) => {
  const conversationId = c.req.param("id");
  const details = await getConversationDetails(conversationId);
  if (!details) return c.json({ error: "Conversation not found" }, 404);

  // WHO CAN WORK THIS THREAD is the SERVING business's staff, not the owner's.
  // On the shared number a conversation is OWNED by the number's org but ROUTED
  // to another, and the assign endpoint (POST /:id/assign) enforces exactly
  // that. Collaborators follow the same rule — they used to be offered from the
  // OWNER's roster, so on a routed chat the picker listed the wrong business's
  // people. Names still resolve from both rosters, so a collaborator added
  // before this fix keeps a name rather than turning into a mystery id.
  const routing = await getConversationRouting(conversationId).catch(() => null);
  const servingOrgId = routing?.routedOrganizationId ?? details.organizationId;
  const assignableTeam = (await listOrgStaffNames(servingOrgId))
    .filter((e) => e.isActive)
    .map((e) => ({ id: e.id, name: e.name }));
  const team = assignableTeam;
  const ownerRoster = await listOrgStaffNames(details.organizationId);
  const nameById = new Map([...ownerRoster, ...assignableTeam].map((e) => [e.id, e.name]));
  // Drop any whose employee row is gone — a departed colleague simply falls off.
  const collaborators = details.collaboratorIds
    .filter((id) => nameById.has(id))
    .map((id) => ({ id, name: nameById.get(id)! }));

  return c.json({ details, collaborators, team, assignableTeam });
});

/**
 * Set who else is on this thread.
 *
 * Whole-set replace, normalised to ids that are actually active staff of THIS
 * business — a collaborator from another org would be a cross-tenant leak by
 * request body, so the roster is the allow-list. Returns the resolved names so
 * the panel updates without a second read.
 */
conversationsRoute.patch("/:id/collaborators", async (c) => {
  const conversationId = c.req.param("id");
  const body = await c.req.json<{ employeeIds?: unknown }>().catch(() => null);
  if (!Array.isArray(body?.employeeIds)) return c.json({ error: "employeeIds (an array) is required" }, 400);

  const details = await getConversationDetails(conversationId);
  if (!details) return c.json({ error: "Conversation not found" }, 404);

  // The serving business's active staff — the same set the details panel offers.
  const routing = await getConversationRouting(conversationId).catch(() => null);
  const roster = await listOrgStaffNames(routing?.routedOrganizationId ?? details.organizationId);
  const active = new Map(roster.filter((e) => e.isActive).map((e) => [e.id, e.name]));
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const raw of body.employeeIds) {
    if (typeof raw !== "string" || !active.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    ids.push(raw);
  }

  await setConversationCollaborators(conversationId, ids);
  return c.json({ collaborators: ids.map((id) => ({ id, name: active.get(id)! })) });
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
    leadSource?: unknown;
  }>().catch(() => null);
  if (!body) return c.json({ error: "Nothing to change." }, 400);

  const details = await getConversationDetails(conversationId);
  if (!details) return c.json({ error: "Conversation not found" }, 404);

  const patch: {
    leadStage?: string | null;
    notes?: string | null;
    customFields?: Record<string, string>;
    leadSource?: string | null;
  } = {};

  if ("leadStage" in body) {
    const v = typeof body.leadStage === "string" ? body.leadStage.trim().slice(0, 60) : "";
    patch.leadStage = v || null;
  }
  if ("leadSource" in body) {
    const v = typeof body.leadSource === "string" ? body.leadSource.trim().slice(0, 80) : "";
    patch.leadSource = v || null;
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
