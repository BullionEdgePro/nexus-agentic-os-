// The Property Finder key's door (7 Nov 2026): an admin saves SFS's API key and
// secret, Nexus checks them with Property Finder and keeps them sealed — the
// answer never carries them back. A check that fails is still saved, with what
// Property Finder said. Every unit write queues a Property Finder run, and a
// queue that is down never fails the write.
//
// Spec: docs/superpowers/specs/2026-11-07-property-finder-connection-design.md §3, §7, §8
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";

delete process.env.PUBLIC_API_URL;
delete process.env.API_DOMAIN;

const SFS = { id: "org-sfs", slug: "sfs-international", name: "SFS International", timezone: "Asia/Dubai" };
const NO_KEY = { saved: false, environment: null, keyEnding: null, checkedAt: null, checkError: null };

const calls = [];
let answers = {};
const stub = (name) => async (...args) => {
  calls.push([name, args]);
  return answers[name];
};
const called = (name) => calls.filter(([n]) => n === name).map(([, args]) => args);

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
    portalSettings: async () => ({ orn: null, feedToken: null, feedLastReadAt: null, feedLastReadBy: null }),
    setPortalOrn: stub("setPortalOrn"),
    newPortalFeed: stub("newPortalFeed"),
    setEmployeeBrn: stub("setEmployeeBrn"),
    portalAgents: async () => [],
    pfConnectionView: async () => answers.pfConnectionView ?? NO_KEY,
    savePfConnection: stub("savePfConnection"),
    recordPfCheck: stub("recordPfCheck"),
    clearPfConnection: stub("clearPfConnection"),
    pfCredentials: stub("pfCredentials"),
    setUnitPocket: stub("setUnitPocket"),
    createPocketShare: stub("createPocketShare"),
    revokePocketShare: stub("revokePocketShare"),
  },
});

mock.module(new URL("../src/lib/property-finder.ts", import.meta.url).href, {
  exports: {
    PF_ENDPOINTS: {},
    pfClient: {
      checkKey: async (creds) => {
        calls.push(["checkKey", [creds]]);
        return answers.checkKey ?? { ok: true };
      },
    },
  },
});

mock.module(new URL("../src/queue/pf-sync-queue.ts", import.meta.url).href, {
  exports: {
    queuePfUnit: async (...args) => {
      calls.push(["queuePfUnit", args]);
      if (answers.queueDown) throw new Error("Redis is down");
    },
    queuePfCycle: async (...args) => {
      calls.push(["queuePfCycle", args]);
      if (answers.queueDown) throw new Error("Redis is down");
    },
  },
});

// A check is allowed once per business every 10 seconds: each test starts 11 s later.
mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });

const { workflowBoardRoute } = await import("../src/routes/workflow-board.ts");

const STAFF = { sub: "s", role: "employee", employeeId: "emp-aisha", organizationId: SFS.id, organizationSlug: SFS.slug };
const ADMIN = { sub: "o", role: "operator", adminId: "admin-1" };

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
  mock.timers.tick(11_000);
});

const BASE = `/${SFS.slug}/workflow-board`;
const json = (scope, method, path, body) =>
  as(scope).request(`${BASE}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const KEY_BODY = { apiKey: "  pf-key-0000-1a2b ", apiSecret: " s3cr3t-value ", environment: "sandbox" };
const SAVED = { saved: true, environment: "sandbox", keyEnding: "1a2b", checkedAt: "2026-11-07T10:42:00.000Z", checkError: null };

test("only an admin reaches the Property Finder key", async () => {
  for (const [method, path, body] of [
    ["PUT", "/portal-settings/property-finder", KEY_BODY],
    ["POST", "/portal-settings/property-finder/check", {}],
    ["DELETE", "/portal-settings/property-finder", undefined],
  ]) {
    const res = await json(STAFF, method, path, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.deepEqual(await res.json(), { error: "Only an admin can change portal settings." });
  }
  assert.equal(called("checkKey").length, 0);
});

test("the settings say where Property Finder stands, never the key", async () => {
  answers.pfConnectionView = SAVED;
  const res = await json(ADMIN, "GET", "/portal-settings");
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).propertyFinder, { ...SAVED, listingCallsReady: false });
});

test("a key is checked and saved, and the answer never carries it back", async () => {
  answers.pfConnectionView = SAVED;
  const res = await json(ADMIN, "PUT", "/portal-settings/property-finder", KEY_BODY);
  assert.equal(res.status, 200);
  const creds = { key: "pf-key-0000-1a2b", secret: "s3cr3t-value", environment: "sandbox" };
  assert.deepEqual(called("checkKey"), [[creds]]);
  assert.deepEqual(called("savePfConnection"), [[SFS.id, { ...creds, checkError: null }]]);
  assert.equal(called("queuePfCycle").length, 1, "a working key starts a cycle");
  const text = await res.text();
  assert.doesNotMatch(text, /pf-key-0000-1a2b|s3cr3t|apiKey|apiSecret/);
  assert.deepEqual(JSON.parse(text).propertyFinder, { ...SAVED, listingCallsReady: false });
});

test("a key Property Finder refuses is saved with the refusal", async () => {
  for (const kind of ["key-refused", "refused"]) {
    calls.length = 0;
    mock.timers.tick(11_000);
    answers.checkKey = { ok: false, kind, message: "invalid client" };
    const res = await json(ADMIN, "PUT", "/portal-settings/property-finder", KEY_BODY);
    assert.equal(res.status, 200, kind);
    assert.equal(called("savePfConnection")[0][1].checkError, "Property Finder refused the key: invalid client", kind);
    assert.equal(called("queuePfCycle").length, 0, "no cycle for a refused key");
  }
});

test("Property Finder out of reach is saved as such, to check again later", async () => {
  answers.checkKey = { ok: false, kind: "unreachable", message: "HTTP 503" };
  const res = await json(ADMIN, "PUT", "/portal-settings/property-finder", KEY_BODY);
  assert.equal(res.status, 200);
  assert.equal(called("savePfConnection")[0][1].checkError, "Could not reach Property Finder: HTTP 503");
});

test("a key or secret that cannot be one is refused before anything is sent", async () => {
  const bad = [
    {},
    { ...KEY_BODY, apiKey: "   " },
    { ...KEY_BODY, apiSecret: "" },
    { ...KEY_BODY, apiKey: "k".repeat(201) },
    { ...KEY_BODY, apiSecret: "abc\u0007def" },
    { ...KEY_BODY, apiKey: "two words" },
    { ...KEY_BODY, apiKey: 12345 },
  ];
  for (const body of bad) {
    const res = await json(ADMIN, "PUT", "/portal-settings/property-finder", body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    assert.deepEqual(await res.json(), { error: "Enter the API key and secret." });
  }
  const env = await json(ADMIN, "PUT", "/portal-settings/property-finder", { ...KEY_BODY, environment: "staging" });
  assert.equal(env.status, 400);
  assert.deepEqual(await env.json(), { error: "Choose Sandbox or Live." });
  assert.equal(called("checkKey").length, 0);
  assert.equal(called("savePfConnection").length, 0);
});

test("check again uses the saved key; with none saved there is nothing to check", async () => {
  answers.pfCredentials = null;
  const none = await json(ADMIN, "POST", "/portal-settings/property-finder/check", {});
  assert.equal(none.status, 404);
  assert.deepEqual(await none.json(), { error: "No Property Finder key is saved." });
  mock.timers.tick(11_000);
  answers.pfCredentials = { key: "pf-key-0000-1a2b", secret: "s3cr3t-value", environment: "live" };
  answers.checkKey = { ok: false, kind: "key-refused", message: "expired" };
  const res = await json(ADMIN, "POST", "/portal-settings/property-finder/check", {});
  assert.equal(res.status, 200);
  assert.deepEqual(called("checkKey").at(-1), [answers.pfCredentials]);
  assert.deepEqual(called("recordPfCheck"), [[SFS.id, "Property Finder refused the key: expired"]]);
  assert.doesNotMatch(await res.text(), /s3cr3t/);
});

test("a second check within 10 seconds waits", async () => {
  assert.equal((await json(ADMIN, "PUT", "/portal-settings/property-finder", KEY_BODY)).status, 200);
  answers.pfCredentials = { key: "pf-key-0000-1a2b", secret: "s3cr3t-value", environment: "sandbox" };
  const again = await json(ADMIN, "POST", "/portal-settings/property-finder/check", {});
  assert.equal(again.status, 409);
  assert.deepEqual(await again.json(), { error: "Checking already — try again in a few seconds." });
  assert.equal(called("checkKey").length, 1);
});

test("disconnect clears the key", async () => {
  const res = await json(ADMIN, "DELETE", "/portal-settings/property-finder");
  assert.equal(res.status, 200);
  assert.deepEqual(called("clearPfConnection"), [[SFS.id]]);
  assert.deepEqual((await res.json()).propertyFinder, { ...NO_KEY, listingCallsReady: false });
});

test("unit writes queue a Property Finder run; a failed write queues nothing", async () => {
  const card = { kind: "unit", id: "u-1" };
  answers.updateUnit = card;
  assert.equal((await json(STAFF, "PATCH", "/units/u-1", { title: "Sea view" })).status, 200);
  answers.setUnitPortal = card;
  assert.equal((await json(STAFF, "POST", "/units/u-1/portals/property_finder", { wanted: true })).status, 200);
  answers.orderUnitPhotos = true;
  assert.equal((await json(STAFF, "POST", "/units/u-1/photos/order", { ids: ["p-1"] })).status, 200);
  answers.removeUnitPhoto = true;
  assert.equal((await json(STAFF, "DELETE", "/units/u-1/photos/p-1")).status, 200);
  assert.deepEqual(called("queuePfUnit"), [[SFS.id, "u-1"], [SFS.id, "u-1"], [SFS.id, "u-1"], [SFS.id, "u-1"]]);
  calls.length = 0;
  answers.updateUnit = null;
  assert.equal((await json(STAFF, "PATCH", "/units/u-1", { title: "Sea view" })).status, 404);
  answers.setUnitPortal = "closed";
  assert.equal((await json(STAFF, "POST", "/units/u-1/portals/property_finder", { wanted: true })).status, 409);
  assert.equal(called("queuePfUnit").length, 0);
});

test("a queue that is down never fails the write", async () => {
  answers.queueDown = true;
  answers.updateUnit = { kind: "unit", id: "u-1" };
  const res = await json(STAFF, "PATCH", "/units/u-1", { title: "Sea view" });
  assert.equal(res.status, 200);
  answers.pfConnectionView = SAVED;
  assert.equal((await json(ADMIN, "PUT", "/portal-settings/property-finder", KEY_BODY)).status, 200);
});
