// The public portal addresses (7 Nov 2026): the Bayut/dubizzle feed and the
// photos it points at. No session — Bayut's reader has none — so they live
// outside /api. A token or file name of the wrong shape never reaches the
// database; an unknown one is a plain 404; a failed "last read" note never
// costs Bayut the feed.
// Spec: docs/superpowers/specs/2026-11-07-portal-listings-design.md §2.2, §6, §9
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

delete process.env.PUBLIC_API_URL;
delete process.env.API_DOMAIN;

const calls = [];
let answers = {};
let noteFails = false;
const stub = (name) => async (...args) => {
  calls.push([name, args]);
  return answers[name];
};

mock.module("@nexus/db", {
  exports: {
    feedByToken: stub("feedByToken"),
    publishedListings: async (...args) => {
      calls.push(["publishedListings", args]);
      return answers.publishedListings;
    },
    noteFeedRead: async (...args) => {
      calls.push(["noteFeedRead", args]);
      if (noteFails) throw new Error("db down");
    },
    publicPhoto: stub("publicPhoto"),
  },
});

const { portalFeedRoute, portalPhotoRoute } = await import("../src/routes/portal-public.ts");
const { Hono } = await import("hono");
const app = new Hono();
app.route("/portal-feeds", portalFeedRoute);
app.route("/portal-photos", portalPhotoRoute);

const TOKEN = "A".repeat(43);
const UUID = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";

beforeEach(() => {
  calls.length = 0;
  answers = {};
  noteFails = false;
});

const LISTING = {
  reference: "u-1",
  updatedAt: "2026-11-06T09:30:00.000Z",
  purpose: "rent",
  priceAed: 95000,
  propertyType: "apartment",
  bedrooms: 1,
  bathrooms: 2,
  sizeSqft: 812,
  furnishing: null,
  title: "Bright 1-bed with canal view",
  description: "A bright one-bedroom apartment on a high floor, with a balcony over the canal.",
  city: "Dubai",
  community: "Business Bay",
  subCommunity: null,
  building: null,
  amenities: [],
  parking: null,
  availableFrom: null,
  permitNumber: "71450",
  permitExpiresOn: "2027-10-27",
  photoUrls: [],
  agent: { name: "Aisha Khan", email: null, phone: null, brn: "45678" },
  orn: "12345",
  portals: ["bayut"],
};

test("the addresses are mounted outside /api, where no session is asked for", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(index, /app\.route\("\/portal-feeds", portalFeedRoute\);/);
  assert.match(index, /app\.route\("\/portal-photos", portalPhotoRoute\);/);
  assert.doesNotMatch(index, /app\.use\("\/portal-(feeds|photos)/);
});

test("a token of the wrong shape never reaches the database", async () => {
  for (const path of ["/portal-feeds/short/bayut.xml", `/portal-feeds/${"A".repeat(42)}!/bayut.xml`, `/portal-feeds/${TOKEN}/other.xml`]) {
    const res = await app.request(path);
    assert.equal(res.status, 404, path);
  }
  assert.equal(calls.length, 0);
});

test("an unknown token is a plain 404", async () => {
  answers.feedByToken = null;
  const res = await app.request(`/portal-feeds/${TOKEN}/bayut.xml`);
  assert.equal(res.status, 404);
  assert.equal(await res.text(), "Not found");
  assert.deepEqual(calls.map(([n]) => n), ["feedByToken"]);
});

test("the feed is the business's published listings, in Bayut's XML, never cached", async () => {
  answers.feedByToken = { organizationId: "org-sfs", timezone: "Asia/Dubai" };
  answers.publishedListings = [LISTING];
  const res = await app.request(`/portal-feeds/${TOKEN}/bayut.xml`, { headers: { "user-agent": "BayutBot/1.0" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/xml; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
  const xml = await res.text();
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<Property_Ref_No>u-1<\/Property_Ref_No>/);
  const [, [org, targets, today, photoUrl]] = calls.find(([n]) => n === "publishedListings");
  assert.equal(org, "org-sfs");
  assert.deepEqual(targets, ["bayut", "dubizzle"]);
  assert.equal(today, new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date()));
  assert.equal(photoUrl("p-1"), "https://api.nexusagenticos.com/portal-photos/p-1.jpg");
  assert.deepEqual(calls.find(([n]) => n === "noteFeedRead")[1], ["org-sfs", "BayutBot/1.0"]);
});

test("a failed read note still serves the feed", async () => {
  answers.feedByToken = { organizationId: "org-sfs", timezone: "Asia/Dubai" };
  answers.publishedListings = [];
  noteFails = true;
  const res = await app.request(`/portal-feeds/${TOKEN}/bayut.xml`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<Listings generated="/);
});

test("a photo is served by its id, only as <uuid>.jpg, for a day", async () => {
  for (const path of ["/portal-photos/../x.jpg", "/portal-photos/abc.png", `/portal-photos/${UUID}.png`, `/portal-photos/${UUID}`]) {
    assert.equal((await app.request(path)).status, 404, path);
  }
  assert.equal(calls.length, 0);
  answers.publicPhoto = null;
  assert.equal((await app.request(`/portal-photos/${UUID}.jpg`)).status, 404);
  answers.publicPhoto = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const res = await app.request(`/portal-photos/${UUID}.jpg`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.equal(res.headers.get("cache-control"), "public, max-age=86400");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), answers.publicPhoto);
  assert.deepEqual(calls.at(-1), ["publicPhoto", [UUID]]);
});
