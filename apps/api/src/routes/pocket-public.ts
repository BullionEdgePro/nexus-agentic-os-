import { Hono, type Context } from "hono";
import { notePocketView, pocketPhoto, pocketShareView, recordPocketInterest } from "@nexus/db";
import { notifyPocketInterest } from "../services/push-dispatcher.js";

/**
 * A pocket listing's private page (7 Nov 2026) — no sign-in: the link's token
 * is the only key. Mounted at /pocket-shares, outside the business scope, like
 * the portal feed. Every answer says: do not store, do not send a referrer, do
 * not index. Every reason a link does not work gets the same answer, and a
 * malformed token is answered without reading anything.
 *
 * Spec: docs/superpowers/specs/2026-11-07-pocket-listings-design.md §5, §6, §9, §10
 */
export const pocketPublicRoute = new Hono();

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PHOTO_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jpg$/i;

function keepPrivate(c: Context): void {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Robots-Tag", "noindex, nofollow");
}
const unavailable = (c: Context) => {
  keepPrivate(c);
  return c.json({ error: "unavailable" }, 404);
};

pocketPublicRoute.get("/:token", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN.test(token)) return unavailable(c);
  const found = await pocketShareView(token);
  if (!found) return unavailable(c);
  // Counting a view is never in the way of the page.
  void notePocketView(found.organizationId, found.shareId).catch((err) =>
    console.error("[pocket] could not note the view:", err instanceof Error ? err.message : err)
  );
  keepPrivate(c);
  return c.json(found.view);
});

pocketPublicRoute.get("/:token/photos/:file", async (c) => {
  const token = c.req.param("token");
  const file = PHOTO_FILE.exec(c.req.param("file"));
  if (!TOKEN.test(token) || !file) return unavailable(c);
  const bytes = await pocketPhoto(token, file[1].toLowerCase());
  if (!bytes) return unavailable(c);
  return c.body(bytes, 200, {
    "content-type": "image/jpeg",
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow",
  });
});

pocketPublicRoute.post("/:token/interest", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN.test(token)) return unavailable(c);
  const interest = await recordPocketInterest(token);
  if (!interest) return unavailable(c);
  if (interest.first && interest.notify) {
    const who = interest.recipientFirstName ?? "A buyer";
    // The agent hears it once; an alert that fails is logged, never shown.
    void notifyPocketInterest(interest.notify, `${who} is interested in ${interest.title} (pocket listing)`).catch((err) =>
      console.error("[pocket] could not alert the agent:", err instanceof Error ? err.message : err)
    );
  }
  keepPrivate(c);
  return c.json({ ok: true, agentFirstName: interest.agentFirstName });
});
