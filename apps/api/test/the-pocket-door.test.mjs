// Pocket listings' doors (7 Nov 2026): the board's Pocket switch and private
// links (signed in, writers only), and the private page's own doors (no sign-in)
// — the listing, its photos and "I'm interested" — each answered with no-store,
// no-referrer and noindex, one "unavailable" answer for every reason.
//
// Spec: docs/superpowers/specs/2026-11-07-pocket-listings-design.md §4, §5, §6, §9, §10
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { readFileSync } from "node:fs";

delete process.env.PUBLIC_API_URL;
delete process.env.API_DOMAIN;
delete process.env.PUBLIC_APP_URL;
delete process.env.WEB_DOMAIN;

const SFS = { id: "org-sfs", slug: "sfs-international", name: "SFS International", timezone: "Asia/Dubai" };
const TOKEN = "T".repeat(43);
const PHOTO = "11111111-2222-4333-8444-555555555555";

const calls = [];
let answers = {};
const stub = (name) => async (...args) => {
  calls.push([name, args]);
  if (answers[`${name}Throws`]) throw new Error(`${name} failed`);
  return answers[name];
};
const called = (name) => calls.filter(([n]) => n === name).map(([, a]) => a);

mock.module("@nexus/db", {
  exports: {
    findOrganizationBySlug: async (slug) => (slug === SFS.slug ? SFS : null),
    getBoard: stub("getBoard"), createUnit: stub("createUnit"), updateUnit: stub("updateUnit"), moveUnit: stub("moveUnit"),
    closeUnit: stub("closeUnit"), createDeal: stub("createDeal"), updateDeal: stub("updateDeal"), moveDeal: stub("moveDeal"),
    closeDeal: stub("closeDeal"), linkUnit: stub("linkUnit"), unlinkUnit: stub("unlinkUnit"), cardHistory: stub("cardHistory"),
    addUnitPhoto: stub("addUnitPhoto"), unitPhotoBytes: stub("unitPhotoBytes"), orderUnitPhotos: stub("orderUnitPhotos"),
    removeUnitPhoto: stub("removeUnitPhoto"), setUnitPortal: stub("setUnitPortal"),
    portalSettings: async () => ({ orn: null, feedToken: null, feedLastReadAt: null, feedLastReadBy: null }),
    setPortalOrn: stub("setPortalOrn"), newPortalFeed: stub("newPortalFeed"), setEmployeeBrn: stub("setEmployeeBrn"),
    portalAgents: async () => [],
    pfConnectionView: async () => ({ saved: false, environment: null, keyEnding: null, checkedAt: null, checkError: null }),
    savePfConnection: stub("savePfConnection"), recordPfCheck: stub("recordPfCheck"), clearPfConnection: stub("clearPfConnection"),
    pfCredentials: stub("pfCredentials"),
    setUnitPocket: stub("setUnitPocket"), createPocketShare: stub("createPocketShare"), revokePocketShare: stub("revokePocketShare"),
    pocketShareView: stub("pocketShareView"), notePocketView: stub("notePocketView"), pocketPhoto: stub("pocketPhoto"),
    recordPocketInterest: stub("recordPocketInterest"),
  },
});
mock.module(new URL("../src/lib/property-finder.ts", import.meta.url).href, {
  exports: { PF_ENDPOINTS: {}, pfClient: { checkKey: async () => ({ ok: true }) } },
});
mock.module(new URL("../src/queue/pf-sync-queue.ts", import.meta.url).href, {
  exports: { queuePfUnit: async (...a) => calls.push(["queuePfUnit", a]), queuePfCycle: async () => undefined },
});
mock.module(new URL("../src/services/push-dispatcher.ts", import.meta.url).href, {
  exports: { notifyPocketInterest: stub("notifyPocketInterest") },
});

const { workflowBoardRoute } = await import("../src/routes/workflow-board.ts");
const { pocketPublicRoute } = await import("../src/routes/pocket-public.ts");

const STAFF = { sub: "s", role: "employee", employeeId: "emp-aisha", organizationId: SFS.id, organizationSlug: SFS.slug };
const PREVIEW = { sub: "o", role: "employee", organizationId: SFS.id, organizationSlug: SFS.slug };

function as(scope) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("scope", scope);
    await next();
  });
  app.route("/", workflowBoardRoute);
  return app;
}
const pub = new Hono();
pub.route("/pocket-shares", pocketPublicRoute);

beforeEach(() => {
  calls.length = 0;
  answers = {};
});

const BASE = `/${SFS.slug}/workflow-board`;
const json = (scope, method, path, body) =>
  as(scope).request(`${BASE}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const privateHeaders = (res) => {
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
};
const CREATED = {
  share: { id: "s-1", dealId: "d-1", active: true },
  token: TOKEN,
  created: true,
  recipient: { firstName: "Sara", number: "971501112233" },
  unit: { title: "Palm villa with beach access", community: "Palm Jumeirah", priceAed: 12500000 },
  agentFirstName: "Aisha",
};
const MESSAGE = `Hi Sara, a private listing I think fits what you're looking for: Palm villa with beach access, Palm Jumeirah, AED 12,500,000. It's off-market, so please keep it to yourself: https://app.nexusagenticos.com/pocket/${TOKEN} — Aisha, SFS International`;

test("the Pocket switch and links are a writer's", async () => {
  for (const [method, path, body] of [
    ["POST", "/units/u-1/pocket", { pocket: true }],
    ["POST", "/units/u-1/pocket/shares", { dealId: "d-1" }],
    ["DELETE", "/units/u-1/pocket/shares/s-1", undefined],
  ]) {
    const res = await json(PREVIEW, method, path, body);
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  assert.equal(calls.length, 0);
});

test("the switch answers the card, and Property Finder follows", async () => {
  assert.deepEqual(await (await json(STAFF, "POST", "/units/u-1/pocket", { pocket: "yes" })).json(), { error: "pocket must be true or false." });
  answers.setUnitPocket = { kind: "unit", id: "u-1" };
  const res = await json(STAFF, "POST", "/units/u-1/pocket", { pocket: true });
  assert.equal(res.status, 200);
  const [org, unit, on, actor] = called("setUnitPocket")[0];
  assert.deepEqual([org, unit, on, actor], [SFS.id, "u-1", true, { employeeId: "emp-aisha" }]);
  assert.deepEqual(called("queuePfUnit"), [[SFS.id, "u-1"]]);
  answers.setUnitPocket = "closed";
  assert.equal((await json(STAFF, "POST", "/units/u-1/pocket", { pocket: true })).status, 409);
});

test("a link comes with the message and the WhatsApp link", async () => {
  answers.createPocketShare = CREATED;
  const res = await json(STAFF, "POST", "/units/u-1/pocket/shares", { dealId: "d-1" });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.url, `https://app.nexusagenticos.com/pocket/${TOKEN}`);
  assert.equal(body.message, MESSAGE);
  assert.equal(body.whatsappUrl, `https://wa.me/971501112233?text=${encodeURIComponent(MESSAGE)}`);
  assert.deepEqual(body.share, CREATED.share);
  answers.createPocketShare = { ...CREATED, created: false, recipient: { firstName: "Sara", number: null } };
  const again = await json(STAFF, "POST", "/units/u-1/pocket/shares", { dealId: "d-1" });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).whatsappUrl, null, "a username customer gets the message to copy");
});

test("a link that cannot be made says why", async () => {
  assert.deepEqual(await (await json(STAFF, "POST", "/units/u-1/pocket/shares", {})).json(), { error: "dealId is required." });
  answers.createPocketShare = { refused: "Turn Pocket on first." };
  const refused = await json(STAFF, "POST", "/units/u-1/pocket/shares", { dealId: "d-1" });
  assert.deepEqual([refused.status, await refused.json()], [422, { error: "Turn Pocket on first." }]);
  answers.createPocketShare = "closed";
  assert.equal((await json(STAFF, "POST", "/units/u-1/pocket/shares", { dealId: "d-1" })).status, 409);
  answers.createPocketShare = null;
  assert.equal((await json(STAFF, "POST", "/units/u-1/pocket/shares", { dealId: "d-1" })).status, 404);
});

test("a link is revoked", async () => {
  answers.revokePocketShare = true;
  assert.deepEqual(await (await json(STAFF, "DELETE", "/units/u-1/pocket/shares/s-1")).json(), { ok: true });
  assert.deepEqual(called("revokePocketShare")[0], [SFS.id, "u-1", "s-1"]);
  answers.revokePocketShare = false;
  const gone = await json(STAFF, "DELETE", "/units/u-1/pocket/shares/s-1");
  assert.deepEqual([gone.status, await gone.json()], [404, { error: "Link not found" }]);
});

test("the private page's listing, never stored, never indexed — and reading it is not a view", async () => {
  answers.pocketShareView = { organizationId: SFS.id, shareId: "s-1", view: { title: "Palm villa with beach access" } };
  const res = await pub.request(`/pocket-shares/${TOKEN}`);
  assert.equal(res.status, 200);
  privateHeaders(res);
  assert.deepEqual(await res.json(), { title: "Palm villa with beach access" });
  // WhatsApp fetches a link for its preview as the agent sends it: a page read
  // is not the buyer opening it (final: views come from the page's own beacon).
  assert.equal(called("notePocketView").length, 0);
});

test("the page's own beacon counts the view", async () => {
  answers.pocketShareView = { organizationId: SFS.id, shareId: "s-1", view: { title: "x" } };
  const res = await pub.request(`/pocket-shares/${TOKEN}/view`, { method: "POST" });
  assert.deepEqual([res.status, await res.json()], [200, { ok: true }]);
  privateHeaders(res);
  assert.deepEqual(called("notePocketView"), [[SFS.id, "s-1"]]);
  answers.pocketShareView = null;
  assert.equal((await pub.request(`/pocket-shares/${TOKEN}/view`, { method: "POST" })).status, 404);
  calls.length = 0;
  assert.equal((await pub.request(`/pocket-shares/bad/view`, { method: "POST" })).status, 404);
  assert.equal(called("pocketShareView").length, 0);
});

test("one unavailable answer for every reason; a malformed token is not looked up", async () => {
  answers.pocketShareView = null;
  const gone = await pub.request(`/pocket-shares/${TOKEN}`);
  assert.deepEqual([gone.status, await gone.json()], [404, { error: "unavailable" }]);
  privateHeaders(gone);
  calls.length = 0;
  const bad = await pub.request(`/pocket-shares/not-a-token`);
  assert.deepEqual([bad.status, await bad.json()], [404, { error: "unavailable" }]);
  privateHeaders(bad);
  assert.equal(called("pocketShareView").length, 0);
});

test("a photo only by its own address, never cached", async () => {
  const wrong = await pub.request(`/pocket-shares/${TOKEN}/photos/photo.png`);
  assert.equal(wrong.status, 404);
  assert.equal(called("pocketPhoto").length, 0);
  answers.pocketPhoto = new Uint8Array([0xff, 0xd8, 0xff]);
  const res = await pub.request(`/pocket-shares/${TOKEN}/photos/${PHOTO}.jpg`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.deepEqual(called("pocketPhoto")[0], [TOKEN, PHOTO]);
  answers.pocketPhoto = null;
  assert.equal((await pub.request(`/pocket-shares/${TOKEN}/photos/${PHOTO}.jpg`)).status, 404);
});

test("interest tells the agent once, and a failed alert fails nothing", async () => {
  answers.recordPocketInterest = { first: true, notify: "emp-aisha", title: "Palm villa with beach access", recipientFirstName: "Sara", agentFirstName: "Aisha" };
  const res = await pub.request(`/pocket-shares/${TOKEN}/interest`, { method: "POST" });
  assert.deepEqual([res.status, await res.json()], [200, { ok: true, agentFirstName: "Aisha" }]);
  privateHeaders(res);
  assert.deepEqual(called("notifyPocketInterest"), [["emp-aisha", "Sara is interested in Palm villa with beach access (pocket listing)"]]);
  calls.length = 0;
  answers.recordPocketInterest = { ...answers.recordPocketInterest, first: false };
  assert.equal((await pub.request(`/pocket-shares/${TOKEN}/interest`, { method: "POST" })).status, 200);
  assert.equal(called("notifyPocketInterest").length, 0, "the second press tells nobody");
  answers.recordPocketInterest = { ...answers.recordPocketInterest, first: true };
  answers.notifyPocketInterestThrows = true;
  assert.equal((await pub.request(`/pocket-shares/${TOKEN}/interest`, { method: "POST" })).status, 200);
  answers.recordPocketInterest = null;
  assert.equal((await pub.request(`/pocket-shares/${TOKEN}/interest`, { method: "POST" })).status, 404);
});

test("the private doors are mounted outside the tenant scope, with the web's origin allowed", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(index, /app\.use\("\/pocket-shares\/\*", cors\(\{ origin: env\.webOrigins \}\)\);/);
  assert.match(index, /app\.route\("\/pocket-shares", pocketPublicRoute\);/);
});
