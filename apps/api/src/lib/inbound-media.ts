import type { AttachmentKind, WhatsAppTextMessage } from "@nexus/shared";

/**
 * EVERY KIND OF WHATSAPP MESSAGE, AS A LINE A PERSON CAN READ.
 *
 * Until 2026-09-30 the inbound processor handled plain text and nothing else:
 * `if (message.type !== "text") continue`. A product photo, a voice note, a
 * PDF, a shared location, the tap on a template's quick-reply button — all
 * skipped before they were saved. Nothing in the inbox, nobody alerted, no
 * reply. The customer had written to the business and the business never knew.
 *
 * Now each message becomes a short labelled line ("[Photo] is this in blue?",
 * "[Voice note]", "Yes, interested") and goes through the SAME pipeline as
 * text: recorded, shown in the inbox, scored, assigned, answered. The original
 * payload is kept as the row's raw_payload, so the file itself stays one click
 * away for staff (GET /api/conversations/:id/messages/:messageId/media).
 *
 * Returns null only for what is not a new message from the customer at all:
 * a reaction to an earlier message. Answering a thumbs-up would be noise.
 */
export interface DescribedMessage {
  /** What is stored, shown in the inbox, and read by the AI. */
  body: string;
  /** A file staff can open, or null for text-like messages. */
  attachment: AttachmentKind | null;
  /**
   * Said to the AI alongside the body, never stored or shown: it cannot see or
   * hear attachments, so it must not describe one. Null for text-like messages.
   */
  aiNote: string | null;
}

const MAX = 1000;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function part(message: WhatsAppTextMessage, key: string): Record<string, unknown> {
  const v = message[key];
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function withCaption(label: string, caption: string): string {
  return (caption ? `${label} ${caption}` : label).slice(0, MAX);
}

const ATTACHMENT_NOTE =
  "The customer sent an attachment. You cannot see, open or hear attachments. " +
  "Never describe or guess what it contains. If it has a caption, answer the caption. " +
  "Otherwise thank them, say a colleague will look at it, and ask them to type any key details.";

export function describeInboundMessage(message: WhatsAppTextMessage): DescribedMessage | null {
  const text = (body: string): DescribedMessage => ({ body: body.slice(0, MAX), attachment: null, aiNote: null });
  const file = (kind: AttachmentKind, body: string): DescribedMessage => ({ body, attachment: kind, aiNote: ATTACHMENT_NOTE });

  switch (message.type) {
    case "text": {
      const body = str(message.text?.body);
      return body ? text(body) : null;
    }
    // A tap on a template's quick-reply button. The label IS what they said —
    // including "Stop promotions", which the opt-out check must see as text.
    case "button": {
      const b = part(message, "button");
      const label = str(b.text) || str(b.payload);
      return label ? text(label) : null;
    }
    case "interactive": {
      const i = part(message, "interactive");
      const reply = (i.button_reply ?? i.list_reply ?? {}) as Record<string, unknown>;
      const title = str(reply.title);
      const description = str(reply.description);
      if (title) return text(description ? `${title} (${description})` : title);
      return text("[A form or menu reply]");
    }
    case "image":
      return file("image", withCaption("[Photo]", str(part(message, "image").caption)));
    case "video":
      return file("video", withCaption("[Video]", str(part(message, "video").caption)));
    case "audio":
      return file("audio", part(message, "audio").voice === true ? "[Voice note]" : "[Audio]");
    case "document": {
      const d = part(message, "document");
      const name = str(d.filename) || "file";
      return file("document", withCaption(`[Document: ${name}]`, str(d.caption)));
    }
    case "sticker":
      return file("sticker", "[Sticker]");
    case "location": {
      const l = part(message, "location");
      const place = [str(l.name), str(l.address)].filter(Boolean).join(", ");
      const lat = typeof l.latitude === "number" ? l.latitude : null;
      const lng = typeof l.longitude === "number" ? l.longitude : null;
      const coords = lat !== null && lng !== null ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : "";
      return text(`[Location: ${[place, coords].filter(Boolean).join(" — ") || "shared"}]`);
    }
    case "contacts": {
      const list = Array.isArray(message.contacts) ? (message.contacts as Array<Record<string, unknown>>) : [];
      const first = list[0] ?? {};
      const nameParts = (first.name ?? {}) as Record<string, unknown>;
      const name = str(nameParts.formatted_name);
      const phones = Array.isArray(first.phones) ? (first.phones as Array<Record<string, unknown>>) : [];
      const phone = str(phones[0]?.phone);
      return text(`[Contact card: ${[name, phone].filter(Boolean).join(", ") || "shared"}]`);
    }
    case "order": {
      const items = part(message, "order").product_items;
      const n = Array.isArray(items) ? items.length : 0;
      return text(`[Order from the catalogue: ${n} item${n === 1 ? "" : "s"}]`);
    }
    case "reaction":
      return null;
    default:
      // "unsupported", "system", view-once, polls — still a customer reaching
      // out, so it is recorded; staff can see it and nobody is left unanswered.
      return {
        body: "[A message WhatsApp couldn't deliver here]",
        attachment: null,
        aiNote:
          "The customer sent something WhatsApp could not deliver to you. Do not guess what it was. " +
          "Ask them politely to send it again as a text or a photo.",
      };
  }
}
