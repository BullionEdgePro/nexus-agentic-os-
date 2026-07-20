import { Redis } from "ioredis";
import type { InboxSocketEvent } from "@nexus/shared";
import { env } from "../config/env.js";

export const INBOX_EVENTS_CHANNEL = "nexus:inbox-events";

// BullMQ workers and the Hono/WS API run as separate processes, so a plain
// in-memory event bus won't reach connected browser clients from the worker.
// Redis pub/sub is the bridge: the worker publishes, the API process (which
// owns the WebSocket connections) subscribes and fans out.
let publisher: Redis | undefined;
function getPublisher(): Redis {
  if (!publisher) publisher = new Redis(env.redisUrl);
  return publisher;
}

export async function publishInboxEvent(event: InboxSocketEvent): Promise<void> {
  await getPublisher().publish(INBOX_EVENTS_CHANNEL, JSON.stringify(event));
}

export function subscribeToInboxEvents(onEvent: (event: InboxSocketEvent) => void): () => void {
  const subscriber = new Redis(env.redisUrl);
  subscriber.subscribe(INBOX_EVENTS_CHANNEL).catch((err) => {
    throw err;
  });
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
