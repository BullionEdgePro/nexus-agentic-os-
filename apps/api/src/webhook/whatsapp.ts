import { Hono } from "hono";
import type { WhatsAppWebhookPayload } from "@nexus/shared";
import { env } from "../config/env.js";
import { verifyMetaSignature } from "../lib/signature.js";
import { getInboundWebhookQueue } from "../queue/queue.js";
import { logger } from "../lib/logger.js";

export const whatsappWebhook = new Hono();

// Meta calls this once when the webhook subscription is configured/verified.
whatsappWebhook.get("/", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");

  if (mode === "subscribe" && token === env.metaWebhookVerifyToken && challenge) {
    return c.text(challenge, 200);
  }
  return c.text("Forbidden", 403);
});

// Meta delivers every inbound message / status update here. Responds
// immediately after enqueueing so we never risk Meta's webhook timeout
// (Meta retries aggressively on slow/non-2xx responses).
whatsappWebhook.post("/", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("x-hub-signature-256");

  if (!verifyMetaSignature(rawBody, signature, env.metaAppSecret)) {
    logger.warn("Rejected webhook delivery with invalid signature");
    return c.text("Invalid signature", 401);
  }

  let payload: WhatsAppWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.text("Invalid JSON", 400);
  }

  const phoneNumberId = payload.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
  if (!phoneNumberId) {
    // Nothing we can route (e.g. an unrelated field subscription) — ack and drop.
    return c.text("OK", 200);
  }

  // BullMQ reserves ":" as its own Redis-key separator and rejects any
  // custom jobId containing one — join with "-" instead (entry/message ids
  // never contain a hyphen-breaking char, so this stays unique and stable).
  await getInboundWebhookQueue().add(
    "inbound",
    { receivedAt: new Date().toISOString(), phoneNumberId, payload },
    { jobId: payload.entry[0].id + "-" + (payload.entry[0].changes[0].value.messages?.[0]?.id ?? Date.now()) }
  );

  return c.text("OK", 200);
});
