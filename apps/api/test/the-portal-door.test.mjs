// The portal door (7 Nov 2026): the board's routes for a unit's photos, its
// publish switches, the business's portal settings and each agent's BRN. They
// answer in the words staff read, keep "View as staff" look-only, keep the
// settings to admins, and refuse a photo the portals would refuse before it is
// stored.
// Spec: docs/superpowers/specs/2026-11-07-portal-listings-design.md §2, §3, §5, §8, §9
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";

delete process.env.PUBLIC_API_URL;
delete process.env.API_DOMAIN;

const SFS = { id: "org-sfs", slug: "sfs-international", name: "SFS International", timezone: "Asia/Dubai" };

const calls = [];
let answers = {};
const stub = (name) => async (...args) => {
  calls.push([name, args]);
  return answers[name];
};

mock.module("@nexus/db", {
  exports: {
    findOrganizationBySlug: async (slug) => (slug === SFS.slug ? SFS : null),
    getBoard: stub("getBoard"),
    createUnit: stub("createUnit"),
    updateUnit: stub("updateUnit"),
    moveUnit: stub("moveUnit"),
    closeUnit: stub("closeUnit"),
    createDeal: stub("createDeal"),
    updateDeal: stub("updateDeal"),
    moveDeal: stub("moveDeal"),
    closeDeal: stub("closeDeal"),
    linkUnit: stub("linkUnit"),
    unlinkUnit: stub("unlinkUnit"),
    cardHistory: stub("cardHistory"),
    addUnitPhoto: stub("addUnitPhoto"),
    unitPhotoBytes: stub("unitPhotoBytes"),
    orderUnitPhotos: stub("orderUnitPhotos"),
    removeUnitPhoto: stub("removeUnitPhoto"),
    setUnitPortal: stub("setUnitPortal"),
    portalSettings: stub("portalSettings"),
    setPortalOrn: stub("setPortalOrn"),
    newPortalFeed: stub("newPortalFeed"),
    setEmployeeBrn: stub("setEmployeeBrn"),
    portalAgents: async () => answers.portalAgents ?? [],
    pfConnectionView: async () => ({ saved: false, environment: null, keyEnding: null, checkedAt: null, checkError: null }),
    savePfConnection: stub("savePfConnection"),
    recordPfCheck: stub("recordPfCheck"),
    clearPfConnection: stub("clearPfConnection"),
    pfCredentials: stub("pfCredentials"),
    setUnitPocket: stub("setUnitPocket"),
    createPocketShare: stub("createPocketShare"),
    revokePocketShare: stub("revokePocketShare"),
  },
});

const { workflowBoardRoute } = await import("../src/routes/workflow-board.ts");
const { jpegSize } = await import("../src/lib/jpeg-size.ts");

const STAFF = { sub: "s", role: "employee", employeeId: "emp-aisha", organizationId: SFS.id, organizationSlug: SFS.slug };
const OPERATOR = { sub: "o", role: "operator", adminId: "admin-1" };
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

beforeEach(() => {
  calls.length = 0;
  answers = {};
});

const BASE = `/${SFS.slug}/workflow-board`;
const json = (scope, method, path, body) =>
  as(scope).request(`${BASE}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

/** A JPEG header: SOI, an APP0, then the frame header (baseline C0 or progressive C2), padded. */
function jpeg(width, height, { sof = 0xc0, size = 64 } = {}) {
  const head = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, sof, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  const bytes = new Uint8Array(Math.max(size, head.length + 2));
  bytes.set(head);
  bytes.set([0xff, 0xd9], bytes.length - 2);
  return bytes;
}
const upload = (scope, bytes, type = "image/jpeg") => {
  const form = new FormData();
  form.set("photo", new File([bytes], "photo.jpg", { type }));
  return as(scope).request(`${BASE}/units/u-1/photos`, { method: "POST", body: form });
};

test("a photo is read before the business's transaction opens", async () => {
  const { readFileSync } = await import("node:fs");
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const gate = index.indexOf(`app.use("/api/organizations/:slug/*", boardPhotoGate);`);
  const scope = index.indexOf(`app.use("/api/organizations/:slug/*", requireTenantScope);`);
  const tenant = index.indexOf(`app.use("/api/organizations/:slug/*", tenantContext);`);
  assert.ok(gate > 0 && scope > 0 && tenant > 0);
  assert.ok(scope < gate && gate < tenant, "after the scope check, before the tenant transaction");
});

test("jpegSize reads a baseline and a progressive frame header, and nothing else", () => {
  assert.deepEqual(jpegSize(jpeg(2048, 1536)), { width: 2048, height: 1536 });
  assert.deepEqual(jpegSize(jpeg(1200, 900, { sof: 0xc2 })), { width: 1200, height: 900 });
  assert.equal(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), null);
  assert.equal(jpegSize(new Uint8Array([0xff, 0xd8, 0xff])), null);
});

test("a photo is stored with the size read from the photo itself", async () => {
  answers.addUnitPhoto = { id: "p-1" };
  const res = await upload(STAFF, jpeg(2048, 1536));
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { id: "p-1", width: 2048, height: 1536 });
  const [name, [org, unit, photo, actor]] = calls.at(-1);
  assert.equal(name, "addUnitPhoto");
  assert.deepEqual([org, unit, photo.width, photo.height, actor], [SFS.id, "u-1", 2048, 1536, { employeeId: "emp-aisha" }]);
});

test("photos the portals would refuse are refused before they are stored", async () => {
  const words = async (res) => [res.status, (await res.json()).error];
  assert.deepEqual(await words(await upload(STAFF, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), "image/png")), [400, "Photos must be JPEG."]);
  assert.deepEqual(await words(await upload(STAFF, jpeg(2048, 1536), "image/png")), [400, "Photos must be JPEG."]);
  assert.deepEqual(await words(await upload(STAFF, jpeg(799, 600))), [422, "Too small for the portals: at least 800 × 600 pixels."]);
  assert.deepEqual(await words(await upload(STAFF, jpeg(800, 599))), [422, "Too small for the portals: at least 800 × 600 pixels."]);
  assert.deepEqual(await words(await upload(STAFF, jpeg(2048, 1536, { size: 4194305 }))), [413, "That photo is over 4 MB."]);
  // A body far over the limit is refused part way through reading it. Sent as
  // raw multipart bytes: an in-memory FormData's producer throws when the
  // reader is cancelled, which a real upload from the network does not.
  const boundary = "x-boundary";
  const big = new Uint8Array(5 * 1024 * 1024 + 300);
  big.set(new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="p.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`));
  const raw = await as(STAFF).request(`${BASE}/units/u-1/photos`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: big,
  });
  assert.deepEqual(await words(raw), [413, "That photo is over 4 MB."]);
  assert.equal(calls.filter(([n]) => n === "addUnitPhoto").length, 0);
  answers.addUnitPhoto = { refused: "A unit has at most 30 photos." };
  assert.deepEqual(await words(await upload(STAFF, jpeg(2048, 1536))), [422, "A unit has at most 30 photos."]);
  answers.addUnitPhoto = null;
  assert.deepEqual(await words(await upload(STAFF, jpeg(2048, 1536))), [404, "Card not found"]);
});

test("a photo is shown to the board, privately", async () => {
  answers.unitPhotoBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const res = await as(PREVIEW).request(`${BASE}/units/u-1/photos/p-1`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.equal(res.headers.get("cache-control"), "private, max-age=300");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), answers.unitPhotoBytes);
  answers.unitPhotoBytes = null;
  assert.equal((await as(STAFF).request(`${BASE}/units/u-1/photos/p-1`)).status, 404);
});

test("photo order and removal answer in staff's words", async () => {
  answers.orderUnitPhotos = { refused: "The order must list each of this unit's photos once." };
  let res = await json(STAFF, "POST", "/units/u-1/photos/order", { ids: ["a", "b"] });
  assert.deepEqual([res.status, (await res.json()).error], [422, "The order must list each of this unit's photos once."]);
  res = await json(STAFF, "POST", "/units/u-1/photos/order", { ids: "a,b" });
  assert.equal(res.status, 400);
  answers.orderUnitPhotos = true;
  res = await json(STAFF, "POST", "/units/u-1/photos/order", { ids: ["b", "a"] });
  assert.deepEqual(await res.json(), { ok: true });
  answers.removeUnitPhoto = false;
  assert.equal((await json(STAFF, "DELETE", "/units/u-1/photos/p-9")).status, 404);
  answers.removeUnitPhoto = true;
  assert.deepEqual(await (await json(STAFF, "DELETE", "/units/u-1/photos/p-1")).json(), { ok: true });
});

test("a switch passes the business's own date and the rule's refusal", async () => {
  answers.setUnitPortal = { refused: "Before it can go on the portals: 2 more photos." };
  let res = await json(STAFF, "POST", "/units/u-1/portals/bayut", { wanted: true });
  assert.deepEqual([res.status, (await res.json()).error], [422, "Before it can go on the portals: 2 more photos."]);
  const [, args] = calls.at(-1);
  assert.deepEqual(args.slice(0, 6), [SFS.id, "u-1", "bayut", true, { employeeId: "emp-aisha" }, { employeeId: "emp-aisha", seesAll: false }]);
  assert.equal(args[6], new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date()));
  answers.setUnitPortal = "closed";
  assert.equal((await json(STAFF, "POST", "/units/u-1/portals/bayut", { wanted: false })).status, 409);
  res = await json(STAFF, "POST", "/units/u-1/portals/meta", { wanted: true });
  assert.deepEqual([res.status, (await res.json()).error], [404, "Unknown portal."]);
  assert.equal((await json(STAFF, "POST", "/units/u-1/portals/bayut", { wanted: "yes" })).status, 400);
});

test("View as staff is look-only for photos and switches", async () => {
  const form = new FormData();
  form.set("photo", new File([jpeg(2048, 1536)], "p.jpg", { type: "image/jpeg" }));
  const tries = [
    as(PREVIEW).request(`${BASE}/units/u-1/photos`, { method: "POST", body: form }),
    json(PREVIEW, "POST", "/units/u-1/photos/order", { ids: [] }),
    json(PREVIEW, "DELETE", "/units/u-1/photos/p-1"),
    json(PREVIEW, "POST", "/units/u-1/portals/bayut", { wanted: true }),
  ];
  for (const res of await Promise.all(tries)) {
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "Viewing as staff is look-only here." });
  }
  assert.equal(calls.length, 0);
});

test("portal settings and BRNs are for admins only", async () => {
  const words = "Only an admin can change portal settings.";
  for (const scope of [STAFF, PREVIEW]) {
    for (const [method, path, body] of [
      ["GET", "/portal-settings"],
      ["PATCH", "/portal-settings", { orn: "12345" }],
      ["POST", "/portal-settings/feed"],
      ["PATCH", "/agents/emp-aisha/brn", { brn: "45678" }],
    ]) {
      const res = await json(scope, method, path, body);
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.deepEqual(await res.json(), { error: words });
    }
  }
  assert.equal(calls.length, 0);
});

test("an admin reads and sets the ORN and the feed address", async () => {
  answers.portalSettings = { orn: "12345", feedToken: "T".repeat(43), feedLastReadAt: "2026-11-07T06:42:00.000Z", feedLastReadBy: "BayutBot" };
  answers.portalAgents = [{ id: "emp-aisha", name: "Aisha Khan", brn: "45678" }];
  let res = await json(OPERATOR, "GET", "/portal-settings");
  assert.deepEqual(await res.json(), {
    orn: "12345",
    feedUrl: `https://api.nexusagenticos.com/portal-feeds/${"T".repeat(43)}/bayut.xml`,
    lastReadAt: "2026-11-07T06:42:00.000Z",
    lastReadBy: "BayutBot",
    agents: [{ id: "emp-aisha", name: "Aisha Khan", brn: "45678" }],
    propertyFinder: { saved: false, environment: null, keyEnding: null, checkedAt: null, checkError: null, listingCallsReady: false },
  });
  res = await json(OPERATOR, "PATCH", "/portal-settings", { orn: "12AB" });
  assert.deepEqual([res.status, (await res.json()).error], [400, "Invalid orn."]);
  res = await json(OPERATOR, "PATCH", "/portal-settings", { orn: " 54321 " });
  assert.equal(res.status, 200);
  assert.deepEqual(calls.find(([n]) => n === "setPortalOrn")[1], [SFS.id, "54321"]);
  await json(OPERATOR, "PATCH", "/portal-settings", { orn: "" });
  assert.deepEqual(calls.filter(([n]) => n === "setPortalOrn").at(-1)[1], [SFS.id, null]);
  answers.portalSettings = { orn: null, feedToken: null, feedLastReadAt: null, feedLastReadBy: null };
  res = await json(OPERATOR, "POST", "/portal-settings/feed");
  assert.equal(calls.filter(([n]) => n === "newPortalFeed").length, 1);
  assert.equal((await res.json()).feedUrl, null);
});

test("an admin sets an agent's BRN: digits only, or cleared", async () => {
  answers.setEmployeeBrn = true;
  let res = await json(OPERATOR, "PATCH", "/agents/emp-aisha/brn", { brn: "BRN-1" });
  assert.deepEqual([res.status, (await res.json()).error], [400, "Invalid brn."]);
  res = await json(OPERATOR, "PATCH", "/agents/emp-aisha/brn", { brn: "45678" });
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(calls.at(-1), ["setEmployeeBrn", [SFS.id, "emp-aisha", "45678"]]);
  await json(OPERATOR, "PATCH", "/agents/emp-aisha/brn", { brn: null });
  assert.deepEqual(calls.at(-1)[1], [SFS.id, "emp-aisha", null]);
  answers.setEmployeeBrn = false;
  res = await json(OPERATOR, "PATCH", "/agents/emp-x/brn", { brn: "1" });
  assert.equal(res.status, 404);
});
