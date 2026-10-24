import { Redis } from "ioredis";
import type { TeamMessage } from "@nexus/db";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

/**
 * Team chat events, on their own channel so the inbox stream never carries a
 * staff conversation (24 Oct 2026). Published after the row is saved: a
 * message that reaches a screen is always one that exists.
 */
export const TEAM_EVENTS_CHANNEL = "nexus:team-events";

export interface TeamEvent {
  type: "team_message" | "team_message_removed" | "team_read";
  organizationId: string;
  organizationSlug: string;
  threadId: string;
  kind: "room" | "direct";
  /** The two people in a direct chat; empty for a room. */
  members: string[];
  message?: TeamMessage;
  /** Who read, for team_read. */
  reader?: string;
}

function client(): Redis {
  const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
  redis.on("error", (err) => logger.warn({ err }, "Redis connection error on team chat (will keep retrying)"));
  return redis;
}

let publisher: Redis | undefined;

export async function publishTeamEvent(event: TeamEvent): Promise<void> {
  publisher ??= client();
  await publisher.publish(TEAM_EVENTS_CHANNEL, JSON.stringify(event));
}

export function subscribeToTeamEvents(onEvent: (event: TeamEvent) => void): () => void {
  const subscriber = client();
  subscriber
    .subscribe(TEAM_EVENTS_CHANNEL)
    .catch((err) => logger.error({ err }, "Failed to subscribe to team chat events"));
  subscriber.on("message", (_channel, message) => {
    try {
      onEvent(JSON.parse(message) as TeamEvent);
    } catch {
      // A malformed event is dropped; the screens re-read on reconnect anyway.
    }
  });
  return () => {
    subscriber.disconnect();
  };
}
