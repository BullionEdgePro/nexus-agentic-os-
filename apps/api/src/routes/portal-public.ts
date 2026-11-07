import { Hono } from "hono";
import { feedByToken, noteFeedRead, publicPhoto, publishedListings } from "@nexus/db";
import { bayutFeedXml } from "@nexus/shared";
import { apiBaseUrl } from "../lib/public-urls.js";

/**
 * The portals' own addresses (7 Nov 2026): the Bayut/dubizzle feed and the
 * photos it points at. Bayut's reader carries no session, so these sit outside
 * /api, like /links. What they hand out is what the portals publish anyway.
 *
 * A token or file name of the wrong shape is refused before any lookup; an
 * unknown one is a plain 404 (it says nothing about which tokens exist); a
 * failed "last read" note never costs Bayut the feed.
 *
 * Spec: docs/superpowers/specs/2026-11-07-portal-listings-design.md §2.2, §6, §9
 */
/** Mounted at /portal-feeds. */
export const portalFeedRoute = new Hono();
/** Mounted at /portal-photos. */
export const portalPhotoRoute = new Hono();

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PHOTO_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jpg$/i;

const todayIn = (timezone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());

portalFeedRoute.get("/:token/:file", async (c) => {
  const token = c.req.param("token");
  if (c.req.param("file") !== "bayut.xml" || !TOKEN.test(token)) return c.text("Not found", 404);
  const business = await feedByToken(token);
  if (!business) return c.text("Not found", 404);
  const listings = await publishedListings(
    business.organizationId,
    ["bayut", "dubizzle"],
    todayIn(business.timezone),
    (photoId) => `${apiBaseUrl()}/portal-photos/${photoId}.jpg`
  );
  // "Bayut last read it 10:42" on the card; never in the way of the feed itself.
  void noteFeedRead(business.organizationId, c.req.header("user-agent") ?? "").catch((err) =>
    console.error("[portal-feed] could not note the read:", err instanceof Error ? err.message : err)
  );
  return c.body(bayutFeedXml(listings, new Date().toISOString()), 200, {
    "content-type": "application/xml; charset=utf-8",
    "cache-control": "no-store",
  });
});

portalPhotoRoute.get("/:file", async (c) => {
  const match = PHOTO_FILE.exec(c.req.param("file"));
  if (!match) return c.text("Not found", 404);
  const bytes = await publicPhoto(match[1].toLowerCase());
  if (!bytes) return c.text("Not found", 404);
  return c.body(bytes, 200, { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" });
});
