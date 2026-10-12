import webpush from "web-push";
import { env } from "../config/env.js";

/**
 * Sending a notification to a phone (spec 2026-10-09-nexus-mobile-app-design.md).
 *
 * Two halves. The payload builders decide what a lock screen may say: who wrote
 * and to which business always, the customer's words only when that device has
 * previews turned on. The sender delivers one payload to one device and reports
 * what the push service said, so the caller can drop a device that is gone for
 * good and count one that is merely failing.
 */
export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
}

/** True when all three VAPID values are set; nothing is sent otherwise. */
export function pushConfigured(): boolean {
  return Boolean(env.vapidPublicKey && env.vapidPrivateKey && env.vapidSubject);
}

const PREVIEW_MAX = 120;

/** A customer's text as a lock screen may show it: no markup, one line, short. */
function previewOf(text: string | null): string | null {
  if (!text) return null;
  const plain = text.replace(/<[^>]*>/g, " ").replace(/[<>]/g, " ").replace(/\s+/g, " ").trim();
  if (!plain) return null;
  return plain.length <= PREVIEW_MAX ? plain : plain.slice(0, PREVIEW_MAX - 1).trimEnd() + "…";
}

export function buildMessagePayload(
  input: {
    conversationId: string;
    customer: string;
    business: string;
    kind: "message" | "assigned";
    text: string | null;
  },
  previews: boolean
): PushPayload {
  const said = input.kind === "assigned" ? "was assigned to you" : "sent a message";
  const words = input.kind === "message" && previews ? previewOf(input.text) : null;
  return {
    title: `${input.customer} · ${input.business}`,
    body: words ?? said,
    // One notification per chat: a second message replaces the first instead
    // of stacking ten banners for one conversation.
    tag: `conv-${input.conversationId}`,
    // The link the inbox already opens, and only if the chat is in the signed-in
    // person's own list (inbox/page.tsx, pendingConversation).
    url: `/inbox?conversation=${encodeURIComponent(input.conversationId)}`,
  };
}

/** An owner-only alert about the platform itself; it opens the deck's health strip. */
export function buildPlatformPayload(problem: string): PushPayload {
  const slug = problem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return { title: "Nexus needs a look", body: problem, tag: `platform-${slug}`, url: "/deck" };
}

let vapidSet = false;

/**
 * Deliver one payload to one device.
 *
 * "gone" means the push service no longer knows this device (404/410: the app
 * was uninstalled or notifications were turned off) and it never will again;
 * "failed" is anything else, worth retrying next time. A slow push service gets
 * 10 seconds, so one dead device never holds up the rest.
 */
export async function sendPush(
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: PushPayload
): Promise<"ok" | "gone" | "failed"> {
  if (!pushConfigured()) return "failed";
  if (!vapidSet) {
    webpush.setVapidDetails(env.vapidSubject, env.vapidPublicKey, env.vapidPrivateKey);
    vapidSet = true;
  }
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { timeout: 10_000, TTL: 60 * 60 * 24, urgency: "high" }
    );
    return "ok";
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    return status === 404 || status === 410 ? "gone" : "failed";
  }
}
