import { Redis } from "ioredis";
import type { InboxSocketEvent } from "@nexus/shared";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

export const INBOX_EVENTS_CHANNEL = "nexus:inbox-events";

// BullMQ workers and the Hono/WS API run as separate processes, so a plain
// in-memory event bus won't reach connected browser clients from the worker.
// Redis pub/sub is the bridge: the worker publishes, the API process (which
// owns the WebSocket connections) subscribes and fans out.
//
// maxRetriesPerRequest: null is required here, not just on the BullMQ
// connection — without it, a sustained Redis outage makes ioredis throw
// MaxRetriesPerRequestError after 20 attempts, which is an uncaught
// exception that kills the whole API process instead of just this feature.
function createResilientRedisClient(): Redis {
  const client = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
  client.on("error", (err) => logger.warn({ err }, "Redis connection error (will keep retrying)"));
  return client;
}

let publisher: Redis | undefined;
function getPublisher(): Redis {
  if (!publisher) publisher = createResilientRedisClient();
  return publisher;
}

export async function publishInboxEvent(event: InboxSocketEvent): Promise<void> {
  await getPublisher().publish(INBOX_EVENTS_CHANNEL, JSON.stringify(event));
}

export function subscribeToInboxEvents(onEvent: (event: InboxSocketEvent) => void): () => void {
  const subscriber = createResilientRedisClient();
  subscriber
    .subscribe(INBOX_EVENTS_CHANNEL)
    .catch((err) => logger.error({ err }, "Failed to subscribe to inbox events channel"));
  subscriber.on("message", (_channel, message) => {
    try {
      onEvent(JSON.parse(message) as InboxSocketEvent);
    } catch {
      // Ignore malformed frames.
    }
  });
  return () => {
    subscriber.disconnect();
  };
}
