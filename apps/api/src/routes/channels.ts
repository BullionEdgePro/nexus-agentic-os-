import { Hono } from "hono";
import { channelStatuses } from "../lib/channels.js";

/**
 * The Channels screen's data: where every messaging channel stands.
 *
 * Operator-only, mounted under /api/channels. It reads configuration, not tenant
 * data — the answer is the same for every business — so there is nothing to
 * scope, but it is still an owner's view: which channels the platform has
 * connected is a setup decision, not a sales executive's concern.
 */
export const channelsRoute = new Hono();

channelsRoute.get("/", (c) => {
  return c.json({ channels: channelStatuses() });
});
