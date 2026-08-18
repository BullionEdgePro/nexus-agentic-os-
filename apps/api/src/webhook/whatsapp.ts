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
    logger.info(
      { wabaId: payload.entry?.[0]?.id, field: payload.entry?.[0]?.changes?.[0]?.field },
      "Webhook delivery accepted with no phone_number_id — nothing to route"
    );
    return c.text("OK", 200);
  }

  // Log every accepted delivery, not just rejected ones.
  //
  // This route used to log ONLY on an invalid signature, so a successful
  // delivery left no trace at all. That cost real time: inbound was reported as
  // broken on the strength of "no webhook entries in the logs", when in fact
  // every message had arrived and been handled correctly. Silence meant both
  // "nothing came" and "everything worked", which is no signal.
  //
  // The WABA id is included because it is the only place Meta exposes it to us
  // — `entry[].id` — and the platform had no other record of the real value.
  const value = payload.entry?.[0]?.changes?.[0]?.value;
  logger.info(
    {
      wabaId: payload.entry?.[0]?.id,
      phoneNumberId,
      messages: value?.messages?.length ?? 0,
      statuses: value?.statuses?.length ?? 0,
      from: value?.messages?.[0]?.from,
    },
    "Inbound webhook accepted"
  );

  // BullMQ reserves ":" as its own Redis-key separator and rejects any
  // custom jobId containing one — join with "-" instead (entry/message ids
  // never contain a hyphen-breaking char, so this stays unique and stable).
  //
  // A STATUS-ONLY DELIVERY USED TO FALL THROUGH TO `Date.now()`, which is not an
  // identity. Two receipts arriving in the same millisecond collided on one
  // jobId and BullMQ dropped the second, and Meta redelivering the SAME receipt
  // produced a fresh id and processed it twice. Both stopped mattering the day
  // statuses were actually read (migration 048), so the id now falls back to the
  // first status's wamid: stable across Meta's retries, distinct between
  // different receipts, and idempotent in the direction that matters.
  const jobKey = value?.messages?.[0]?.id ?? value?.statuses?.[0]?.id ?? Date.now();

  await getInboundWebhookQueue().add(
    "inbound",
    { receivedAt: new Date().toISOString(), phoneNumberId, payload },
    { jobId: payload.entry[0].id + "-" + jobKey }
  );

  return c.text("OK", 200);
});
