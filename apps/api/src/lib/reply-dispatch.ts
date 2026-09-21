import type { ConversationChannel } from "@nexus/shared";
import { pageConnectionForOutbound } from "@nexus/db";
import { sendWhatsAppText } from "./whatsapp-client.js";
import { sendPageMessage } from "./messenger-client.js";
import { sendEmailReply } from "../services/email-sync.js";

/**
 * Send a reply on the channel the conversation is actually on.
 *
 * ============================================================
 * ONE DOOR OUT, PER CHANNEL
 * ============================================================
 *
 * Every human and scheduled reply used to go straight to sendWhatsAppText, which
 * was correct while every conversation was WhatsApp. Now a conversation carries a
 * `channel`, and a reply must leave by the matching door: a WhatsApp number, a
 * Messenger PSID, an Instagram IGSID. This is that switch, in one place so the
 * inbox send, the scheduled sweep and anything later cannot each get it subtly
 * wrong.
 *
 * It returns the provider's own message id in the field that belongs to that
 * channel — a wamid in waMessageId, a Meta mid in socialMessageId — so the caller
 * stores it on the right column without re-deciding the channel.
 *
 * DORMANT for FB/IG until a Page is connected: pageConnectionForOutbound returns
 * null for every business today, so a social reply throws a clear, honest error
 * rather than pretending to send. Email leaves by its own door — the owner's
 * mailbox, threaded onto the conversation. sms/phone have no send path built and
 * still throw, never silently falling back to WhatsApp.
 */
export interface OutboundReplyTarget {
  organizationId: string;
  channel: ConversationChannel;
  phoneNumberId: string;
  contactWaId: string | null;
  contactExternalId: string | null;
  /** The conversation itself — email resolves its mailbox and thread from this. */
  conversationId: string;
}

export interface DispatchedReply {
  waMessageId: string | null;
  socialMessageId: string | null;
  /** Gmail id of an email reply, stored so the sync dedups it; null otherwise. */
  emailMessageId: string | null;
  /** The Gmail thread an email reply went out on; null otherwise. */
  emailThreadId: string | null;
}

export async function sendReplyOnChannel(
  target: OutboundReplyTarget,
  text: string
): Promise<DispatchedReply> {
  if (target.channel === "facebook" || target.channel === "instagram") {
    if (!target.contactExternalId) {
      throw new Error("This conversation has no Messenger/Instagram recipient to reply to.");
    }
    const connection = await pageConnectionForOutbound(target.organizationId, target.channel);
    if (!connection) {
      throw new Error(
        "No Facebook Page or Instagram account is connected for this business yet, so this reply cannot be sent."
      );
    }
    const mid = await sendPageMessage({
      pageId: connection.pageId,
      pageAccessToken: connection.token,
      recipientId: target.contactExternalId,
      text,
    });
    return { waMessageId: null, socialMessageId: mid, emailMessageId: null, emailThreadId: null };
  }

  if (target.channel === "email") {
    // Its own door: the owner's mailbox, threaded onto the conversation. The
    // service resolves who sends and where from the conversation id, and returns
    // the Gmail id so the caller stores it and the sync later dedups it.
    const sent = await sendEmailReply(target.conversationId, text);
    return {
      waMessageId: null,
      socialMessageId: null,
      emailMessageId: sent.gmailMessageId,
      emailThreadId: sent.threadId,
    };
  }

  if (target.channel === "whatsapp") {
    if (!target.contactWaId) {
      throw new Error("This conversation has no WhatsApp recipient to reply to.");
    }
    const wamid = await sendWhatsAppText(target.phoneNumberId, target.contactWaId, text);
    return { waMessageId: wamid, socialMessageId: null, emailMessageId: null, emailThreadId: null };
  }

  // sms / phone: recorded channels with no outbound send wired here. Refuse
  // rather than send on the wrong channel.
  throw new Error(`Replying on the ${target.channel} channel is not available yet.`);
}
