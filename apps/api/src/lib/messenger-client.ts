import { env } from "../config/env.js";

/**
 * Facebook Page (Messenger) and Instagram messaging — the platform edge.
 *
 * ============================================================
 * THE FOUNDATION, DORMANT UNTIL META SAYS YES
 * ============================================================
 *
 * These two channels ride the SAME Meta plumbing as WhatsApp: one app webhook
 * receives every object Meta sends (`whatsapp_business_account`, `page`,
 * `instagram`), and a Graph Send API sends the reply. What is different is the
 * payload shape and the send endpoint, and that is exactly what this file pins
 * down — parsing an inbound Messenger/IG delivery into one normalized shape, and
 * building the outbound send.
 *
 * It does NOT go live on its own: answering Page/IG messages needs Meta App
 * Review (`pages_messaging`, `instagram_manage_messages`) and a connected Page/IG
 * whose page access token the send uses. Until then nothing calls these — they
 * are unit-tested platform code waiting for the webhook branch, the identity
 * model and the connect flow that come next. Everything here is pure and
 * side-effect-free except the one network send, so it can be trusted before it
 * can be exercised end to end.
 */

import type { ConversationChannel } from "@nexus/shared";

/** One inbound message, normalized across Messenger and Instagram. */
export interface IncomingSocialMessage {
  /** "facebook" for a Page (Messenger) delivery, "instagram" for an IG one. */
  channel: Extract<ConversationChannel, "facebook" | "instagram">;
  /** The Page id (Messenger) or IG account id — where the reply is sent FROM. */
  pageId: string;
  /** The person who wrote: a page-scoped id (PSID) or IG-scoped id (IGSID). */
  senderId: string;
  /** The account the message was sent TO (the Page/IG id). */
  recipientId: string;
  /** Meta's message id (mid) — the dedup key, like a wamid on WhatsApp. */
  messageId: string;
  /** The text. Empty string for a non-text message (attachment/sticker). */
  text: string;
  /** Milliseconds since epoch, from Meta's own timestamp. */
  timestamp: number;
}

interface MessagingEvent {
  sender?: { id?: unknown };
  recipient?: { id?: unknown };
  timestamp?: unknown;
  message?: { mid?: unknown; text?: unknown; is_echo?: unknown };
}

interface WebhookEntry {
  id?: unknown;
  messaging?: MessagingEvent[];
}

interface MessagingWebhookPayload {
  object?: unknown;
  entry?: WebhookEntry[];
}

/**
 * Turn a Messenger or Instagram webhook delivery into normalized messages.
 *
 * The `object` field decides the channel: "page" is Messenger, "instagram" is IG.
 * Anything else (a WhatsApp delivery, a non-messaging field subscription) returns
 * nothing here — the caller routes those elsewhere. Echoes (`is_echo`, our own
 * outbound reflected back) and messages with no text (an attachment or sticker)
 * are dropped, so what comes back is only real inbound text to answer.
 */
export function parseMessagingWebhook(payload: MessagingWebhookPayload): IncomingSocialMessage[] {
  const object = payload?.object;
  const channel: IncomingSocialMessage["channel"] | null =
    object === "page" ? "facebook" : object === "instagram" ? "instagram" : null;
  if (!channel) return [];

  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  const out: IncomingSocialMessage[] = [];

  for (const entry of entries) {
    const pageId = typeof entry?.id === "string" ? entry.id : "";
    const events = Array.isArray(entry?.messaging) ? entry.messaging : [];
    for (const event of events) {
      const message = event?.message;
      if (!message) continue; // delivery receipt, read, postback — not a message
      if (message.is_echo === true) continue; // our own message, reflected back
      const messageId = typeof message.mid === "string" ? message.mid : "";
      const senderId = typeof event.sender?.id === "string" ? event.sender.id : "";
      if (!messageId || !senderId || !pageId) continue;
      out.push({
        channel,
        pageId,
        senderId,
        recipientId: typeof event.recipient?.id === "string" ? event.recipient.id : "",
        messageId,
        text: typeof message.text === "string" ? message.text : "",
        timestamp: typeof event.timestamp === "number" ? event.timestamp : Date.now(),
      });
    }
  }

  return out;
}

/** Meta accepted the send and returned its id; null when it accepted without one. */
export type SentSocialMessageId = string | null;

/**
 * Send a text reply on Messenger or Instagram, as the connected Page.
 *
 * The endpoint and body are identical for both — an Instagram Business account is
 * addressed through the Page it is linked to — so one function covers both
 * channels. `messaging_type: "RESPONSE"` is the honest tag: we only ever reply to
 * someone who messaged first, inside the platform's standard window. The page
 * access token comes from the connected account, never a global one, so the send
 * acts only for the business that connected the Page.
 */
export async function sendPageMessage(input: {
  pageId: string;
  pageAccessToken: string;
  recipientId: string;
  text: string;
}): Promise<SentSocialMessageId> {
  const url = `https://graph.facebook.com/${env.metaGraphApiVersion}/${input.pageId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.pageAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      recipient: { id: input.recipientId },
      messaging_type: "RESPONSE",
      message: { text: input.text },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Messenger/Instagram send failed (${response.status}): ${errorBody}`);
  }

  const payload = (await response.json().catch(() => null)) as { message_id?: unknown } | null;
  return typeof payload?.message_id === "string" && payload.message_id ? payload.message_id : null;
}
