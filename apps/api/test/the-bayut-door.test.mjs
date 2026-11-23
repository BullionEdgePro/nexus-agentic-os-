// The Bayut door (23 Nov 2026): an admin saves SFS's Bayut API token, Nexus
// checks it with Bayut (the agency, then its users) and keeps it sealed — no
// answer ever carries it back. A check that fails is still saved, with what
// Bayut said; a token for another Bayut account says so. Admins link each agent
// to a Bayut user read at the last check. Staff search Bayut's locations for a
// unit (deep ones only, cached a day, inside the business's call budget) and
// save one on the card. Every unit write queues Property Finder and Bayut, and a
// queue that is down never fails the write.
//
// Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §4, §5, §6, §12, §14
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";

delete process.env.PUBLIC_API_URL;
delete process.env.API_DOMAIN;

const SFS = { id: "org-sfs", slug: "sfs-international", name: "SFS International", timezone: "Asia/Dubai" };
const NO_TOKEN = { saved: false, agencyName: null, tokenEnding: null, checkedAt: null, checkError: null };
const AGENCY_NAME = "Sfs International Real Estate - Sandbox";
const SAVED = { saved: true, agencyName: AGENCY_NAME, tokenEnding: "9z8y", checkedAt: "2026-11-23T10:42:00.000Z", checkError: null };
const TOKEN = "bayut-token-0000-9z8y";
const AGENCIES = [
  { id: 12, parentId: 3, name: "SFS Branch" },
  { id: 3, parentId: null, name: AGENCY_NAME },
];
const USERS = [
  { id: 7, name: "Ralph Simeon", email: "ralph@sfs.ae" },
  { id: 8, name: "Aisha Khan", email: null },
];
const ADMINS_ONLY = { error: "Only an admin can change portal settings." };
const LOOK_ONLY = { error: "Viewing as staff is look-only here." };
const BUSY = { error: "Bayut is busy — try again in a minute." };

const calls = [];
let answers = {};
const stub = (name) => async (...args) => {
  calls.push([name, args]);
  return answers[name];
};
const called = (name) => calls.filter(([n]) => n === name).map(([, args]) => args);
const order = (name) => calls.findIndex(([n]) => n === name);

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
    pfConnectionView: async () => ({ saved: false, environment: null, keyEnding: null, checkedAt: null, checkError: null }),
    savePfConnection: stub("savePfConnection"),
    recordPfCheck: stub("recordPfCheck"),
    clearPfConnection: stub("clearPfConnection"),
    pfCredentials: stub("pfCredentials"),
    setUnitPocket: stub("setUnitPocket"),
    createPocketShare: stub("createPocketShare"),
    revokePocketShare: stub("revokePocketShare"),
    bayutConnectionView: async () => answers.bayutConnectionView ?? NO_TOKEN,
    saveBayutConnection: async (...args) => {
      calls.push(["saveBayutConnection", args]);
      return answers.saveBayutConnection ?? { accountChanged: false };
    },
    recordBayutCheck: async (...args) => {
      calls.push(["recordBayutCheck", args]);
      return answers.recordBayutCheck ?? { accountChanged: false };
    },
    clearBayutConnection: stub("clearBayutConnection"),
    bayutToken: stub("bayutToken"),
    bayutAgentLinks: async () => answers.bayutAgentLinks ?? [],
    linkBayutAgent: stub("linkBayutAgent"),
    autoLinkBayutAgents: stub("autoLinkBayutAgents"),
  },
});

mock.module(new URL("../src/lib/property-finder.ts", import.meta.url).href, {
  exports: {
    PF_ENDPOINTS: {},
    pfClient: {
      checkKey: async (creds) => {
        calls.push(["checkKey", [creds]]);
        return { ok: true };
      },
    },
  },
});

mock.module(new URL("../src/lib/bayut.ts", import.meta.url).href, {
  exports: {
    bayutClient: {
      agencies: async (...args) => {
        calls.push(["agencies", args]);
        return answers.agencies ?? { ok: true, data: AGENCIES };
      },
      users: async (...args) => {
        calls.push(["users", args]);
        return answers.users ?? { ok: true, data: USERS };
      },
      locations: async (...args) => {
        calls.push(["locations", args]);
        return answers.locations ?? { ok: true, data: [] };
      },
    },
  },
});

const queued = (name, down) => async (...args) => {
  calls.push([name, args]);
  if (answers[down]) throw new Error("Redis is down");
};
mock.module(new URL("../src/queue/pf-sync-queue.ts", import.meta.url).href, {
  exports: { queuePfUnit: queued("queuePfUnit", "pfQueueDown"), queuePfCycle: queued("queuePfCycle", "pfQueueDown") },
});
mock.module(new URL("../src/queue/bayut-sync-queue.ts", import.meta.url).href, {
  exports: { queueBayutUnit: queued("queueBayutUnit", "bayutQueueDown"), queueBayutCycle: queued("queueBayutCycle", "bayutQueueDown") },
});

// A Redis stand-in under the real call budget (lib/bayut-budget.ts): the users
// read at the last check, the location cache and the budget's own counters.
const store = new Map();
const sets = [];
const redis = {
  get: async (key) => store.get(key) ?? null,
  set: async (key, value, ...rest) => {
    sets.push([key, value, ...rest]);
    store.set(key, value);
    return "OK";
  },
  incrby: async (key, n) => {
    const next = Number(store.get(key) ?? 0) + n;
    store.set(key, String(next));
    return next;
  },
  decrby: async (key, n) => {
    const next = Number(store.get(key) ?? 0) - n;
    store.set(key, String(next));
    return next;
  },
  expire: async () => 1,
  del: async (key) => (store.delete(key) ? 1 : 0),
};
mock.module(new URL("../src/queue/queue.ts", import.meta.url).href, {
  exports: { getRedisConnection: () => redis },
});

// A check is allowed once per business every 10 seconds: each test starts 11 s later.
mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });

const { workflowBoardRoute } = await import("../src/routes/workflow-board.ts");

const STAFF = { sub: "s", role: "employee", employeeId: "emp-aisha", organizationId: SFS.id, organizationSlug: SFS.slug };
const PREVIEW = { sub: "o", role: "employee", organizationId: SFS.id, organizationSlug: SFS.slug };
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
  store.clear();
  sets.length = 0;
  mock.timers.tick(11_000);
});

const BASE = `/${SFS.slug}/workflow-board`;
const json = (scope, method, path, body) =>
  as(scope).request(`${BASE}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const words = async (res) => [res.status, (await res.json()).error];
const USERS_KEY = `bayut-users:${SFS.id}`;
const WEEK = 7 * 24 * 60 * 60;
const keepUsers = (users) => store.set(USERS_KEY, JSON.stringify(users));
const budgetKey = () => `bayut-calls:${SFS.id}:${Math.floor(Date.now() / 60_000)}`;
const search = (scope, q, extra = "") => json(scope, "GET", `/bayut/locations?q=${encodeURIComponent(q)}${extra}`);

test("only an admin reaches the Bayut settings", async () => {
  for (const scope of [STAFF, PREVIEW]) {
    for (const [method, path, body] of [
      ["GET", "/portal-settings"],
      ["PUT", "/portal-settings/bayut", { token: TOKEN }],
      ["POST", "/portal-settings/bayut/check", {}],
      ["DELETE", "/portal-settings/bayut"],
      ["PUT", "/portal-settings/bayut/agents/emp-aisha", { bayutUserId: 7 }],
    ]) {
      const res = await json(scope, method, path, body);
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.deepEqual(await res.json(), ADMINS_ONLY);
    }
  }
  assert.deepEqual(calls, []);
});

test("the settings say where Bayut stands, with the users read and the links — never the token", async () => {
  answers.bayutConnectionView = SAVED;
  answers.bayutAgentLinks = [{ employeeId: "emp-aisha", bayutUserId: 7, bayutUserName: "Ralph Simeon" }];
  answers.bayutToken = { token: TOKEN, agencyId: 3 };
  keepUsers(USERS);
  const res = await json(ADMIN, "GET", "/portal-settings");
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.doesNotMatch(text, new RegExp(TOKEN));
  assert.deepEqual(JSON.parse(text).bayut, { ...SAVED, users: USERS, links: [{ employeeId: "emp-aisha", bayutUserId: 7 }] });

  // Nothing saved: no users, whatever is left in Redis.
  answers.bayutConnectionView = NO_TOKEN;
  answers.bayutAgentLinks = [];
  const none = await json(ADMIN, "GET", "/portal-settings");
  assert.deepEqual((await none.json()).bayut, { ...NO_TOKEN, users: [], links: [] });

  // Users Redis cannot give back are no users.
  answers.bayutConnectionView = SAVED;
  store.set(USERS_KEY, "not json");
  assert.deepEqual((await (await json(ADMIN, "GET", "/portal-settings")).json()).bayut.users, []);
});

test("with Redis not answering, Portal settings still answers within the 1.5-second wait, without the Bayut users (final review R1)", { timeout: 5_000 }, async () => {
  answers.bayutConnectionView = SAVED;
  answers.bayutAgentLinks = [{ employeeId: "emp-aisha", bayutUserId: 7, bayutUserName: "Ralph Simeon" }];
  keepUsers(USERS);
  const get = redis.get;
  redis.get = () => new Promise(() => {}); // Redis down: ioredis queues the command and never answers
  try {
    const started = performance.now();
    const res = await json(ADMIN, "GET", "/portal-settings");
    const took = performance.now() - started;
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.orn, null, "the ORN, the BRNs and Property Finder still come");
    assert.equal(body.propertyFinder.saved, false);
    assert.deepEqual(body.bayut, { ...SAVED, users: [], links: [{ employeeId: "emp-aisha", bayutUserId: 7 }] }, "as if the users were unknown");
    assert.ok(took >= 1_400 && took < 3_000, `answered after ${Math.round(took)} ms`);
  } finally {
    redis.get = get;
  }
});

test("a token is checked with Bayut, saved with its agency, its users linked — and never answered back", async () => {
  answers.bayutConnectionView = SAVED;
  const res = await json(ADMIN, "PUT", "/portal-settings/bayut", { token: `  ${TOKEN} ` });
  assert.equal(res.status, 200);
  assert.deepEqual(called("agencies"), [[TOKEN]]);
  // The first agency without a parent is the account.
  assert.deepEqual(called("users"), [[TOKEN, 3]]);
  assert.deepEqual(called("saveBayutConnection"), [[SFS.id, { token: TOKEN, agencyId: 3, agencyName: AGENCY_NAME, checkError: null }]]);
  assert.deepEqual(sets.find(([key]) => key === USERS_KEY), [USERS_KEY, JSON.stringify(USERS), "EX", WEEK]);
  assert.deepEqual(called("autoLinkBayutAgents"), [[SFS.id, USERS]]);
  assert.ok(order("saveBayutConnection") < order("autoLinkBayutAgents"), "links are made after the save, which may clear the old account's");
  assert.equal(called("queueBayutCycle").length, 1, "a token that checks out starts a cycle");
  const text = await res.text();
  assert.doesNotMatch(text, new RegExp(TOKEN));
  const body = JSON.parse(text);
  assert.equal(body.accountChanged, false);
  assert.deepEqual(body.bayut, { ...SAVED, users: USERS, links: [] });
});

test("with no agency without a parent, the first agency listed is the account", async () => {
  answers.agencies = { ok: true, data: [{ id: 44, parentId: 9, name: "Only branch" }, { id: 45, parentId: 9, name: "Second" }] };
  assert.equal((await json(ADMIN, "PUT", "/portal-settings/bayut", { token: TOKEN })).status, 200);
  assert.deepEqual(called("saveBayutConnection")[0][1], { token: TOKEN, agencyId: 44, agencyName: "Only branch", checkError: null });
  assert.deepEqual(called("users"), [[TOKEN, 44]]);
});

test("a token for another Bayut account answers accountChanged", async () => {
  answers.saveBayutConnection = { accountChanged: true };
  const put = await json(ADMIN, "PUT", "/portal-settings/bayut", { token: TOKEN });
  assert.equal((await put.json()).accountChanged, true);
  mock.timers.tick(11_000);
  answers.bayutToken = { token: TOKEN, agencyId: 3 };
  answers.recordBayutCheck = { accountChanged: true };
  const check = await json(ADMIN, "POST", "/portal-settings/bayut/check", {});
  assert.equal((await check.json()).accountChanged, true);
});

test("a token Bayut refuses or cannot answer for is saved with Bayut's words, and starts nothing", async () => {
  for (const [answer, checkError] of [
    [{ ok: false, kind: "token-refused", message: "Unauthenticated." }, "Bayut refused the token: Unauthenticated."],
    [{ ok: false, kind: "refused", message: "Forbidden." }, "Bayut refused the token: Forbidden."],
    [{ ok: false, kind: "unreachable", message: "HTTP 503" }, "Could not reach Bayut: HTTP 503"],
    [{ ok: true, data: [] }, "Bayut answered without an agency"],
  ]) {
    calls.length = 0;
    mock.timers.tick(11_000);
    answers.agencies = answer;
    const res = await json(ADMIN, "PUT", "/portal-settings/bayut", { token: TOKEN });
    assert.equal(res.status, 200, checkError);
    assert.deepEqual(called("saveBayutConnection"), [[SFS.id, { token: TOKEN, agencyId: null, agencyName: null, checkError }]]);
    assert.equal(called("users").length, 0, checkError);
    assert.equal(called("autoLinkBayutAgents").length, 0, checkError);
    assert.equal(called("queueBayutCycle").length, 0, "no cycle for a token that did not check out");
    assert.equal((await res.json()).accountChanged, false);
  }
  assert.equal(sets.filter(([key]) => key === USERS_KEY).length, 0);
});

test("Bayut's words never carry the token back, even if Bayut echoes it", async () => {
  answers.agencies = { ok: false, kind: "refused", message: `The token ${TOKEN} is not valid.` };
  const res = await json(ADMIN, "PUT", "/portal-settings/bayut", { token: TOKEN });
  assert.equal(res.status, 200);
  const [[, saved]] = called("saveBayutConnection");
  assert.doesNotMatch(saved.checkError, new RegExp(TOKEN));
  assert.equal(saved.checkError, "Bayut refused the token: The token ••• is not valid.");
});

test("a users read that fails does not fail the check", async () => {
  answers.users = { ok: false, kind: "unreachable", message: "HTTP 502" };
  const res = await json(ADMIN, "PUT", "/portal-settings/bayut", { token: TOKEN });
  assert.equal(res.status, 200);
  assert.equal(called("saveBayutConnection")[0][1].checkError, null);
  assert.equal(called("autoLinkBayutAgents").length, 0);
  assert.equal(called("queueBayutCycle").length, 1);
  assert.equal(sets.filter(([key]) => key === USERS_KEY).length, 0, "the users kept are left alone");

  // Another account whose users cannot be read: the old account's users are forgotten.
  mock.timers.tick(11_000);
  keepUsers(USERS);
  answers.saveBayutConnection = { accountChanged: true };
  answers.bayutConnectionView = SAVED;
  const changed = await json(ADMIN, "PUT", "/portal-settings/bayut", { token: TOKEN });
  assert.equal(changed.status, 200);
  assert.deepEqual((await changed.json()).bayut.users, []);
});

test("a token that cannot be one is refused before anything is sent", async () => {
  for (const body of [{}, { token: "   " }, { token: "" }, { token: "t".repeat(501) }, { token: "abc\u0007def" }, { token: "abc\ndef" }, { token: 12345 }, { token: null }]) {
    const res = await json(ADMIN, "PUT", "/portal-settings/bayut", body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    assert.deepEqual(await res.json(), { error: "Enter the Bayut API token." });
  }
  assert.equal(called("agencies").length, 0);
  assert.equal(called("saveBayutConnection").length, 0);
  // 500 printable characters is a token.
  assert.equal((await json(ADMIN, "PUT", "/portal-settings/bayut", { token: "t".repeat(500) })).status, 200);
});

test("check again uses the saved token; with none saved there is nothing to check", async () => {
  answers.bayutToken = null;
  const none = await json(ADMIN, "POST", "/portal-settings/bayut/check", {});
  assert.deepEqual(await words(none), [404, "No Bayut token is saved."]);
  assert.equal(called("agencies").length, 0);

  mock.timers.tick(11_000);
  // A token whose first check failed has no agency yet: it can still be checked.
  answers.bayutToken = { token: TOKEN, agencyId: null };
  answers.bayutConnectionView = SAVED;
  const res = await json(ADMIN, "POST", "/portal-settings/bayut/check", {});
  assert.equal(res.status, 200);
  assert.deepEqual(called("agencies"), [[TOKEN]]);
  assert.deepEqual(called("recordBayutCheck"), [[SFS.id, { checkError: null, agencyId: 3, agencyName: AGENCY_NAME }]]);
  assert.deepEqual(called("users"), [[TOKEN, 3]]);
  assert.deepEqual(called("autoLinkBayutAgents"), [[SFS.id, USERS]]);
  assert.ok(order("recordBayutCheck") < order("autoLinkBayutAgents"));
  assert.equal(called("queueBayutCycle").length, 1);
  assert.equal(called("saveBayutConnection").length, 0);
  const text = await res.text();
  assert.doesNotMatch(text, new RegExp(TOKEN));
  assert.equal(JSON.parse(text).accountChanged, false);

  calls.length = 0;
  mock.timers.tick(11_000);
  answers.agencies = { ok: false, kind: "token-refused", message: "expired" };
  const refused = await json(ADMIN, "POST", "/portal-settings/bayut/check", {});
  assert.equal(refused.status, 200);
  assert.deepEqual(called("recordBayutCheck"), [[SFS.id, { checkError: "Bayut refused the token: expired", agencyId: null, agencyName: null }]]);
  assert.equal(called("queueBayutCycle").length, 0);
});

test("a second Bayut check within 10 seconds waits; Property Finder's does not wait for it", async () => {
  assert.equal((await json(ADMIN, "PUT", "/portal-settings/bayut", { token: TOKEN })).status, 200);
  answers.bayutToken = { token: TOKEN, agencyId: 3 };
  for (const [method, path] of [
    ["POST", "/portal-settings/bayut/check"],
    ["PUT", "/portal-settings/bayut"],
  ]) {
    const again = await json(ADMIN, method, path, { token: TOKEN });
    assert.deepEqual(await words(again), [409, "Checking already — try again in a few seconds."], `${method} ${path}`);
  }
  assert.equal(called("agencies").length, 1);
  const pf = await json(ADMIN, "PUT", "/portal-settings/property-finder", { apiKey: "pf-key-1a2b", apiSecret: "s3cr3t", environment: "sandbox" });
  assert.equal(pf.status, 200);
});

test("disconnect clears the token and forgets the Bayut users", async () => {
  keepUsers(USERS);
  const res = await json(ADMIN, "DELETE", "/portal-settings/bayut");
  assert.equal(res.status, 200);
  assert.deepEqual(called("clearBayutConnection"), [[SFS.id]]);
  assert.deepEqual((await res.json()).bayut, { ...NO_TOKEN, users: [], links: [] });
  answers.bayutConnectionView = SAVED;
  assert.deepEqual((await (await json(ADMIN, "GET", "/portal-settings")).json()).bayut.users, []);
});

test("an admin links an agent to a Bayut user read at the last check, or unlinks them", async () => {
  keepUsers(USERS);
  answers.linkBayutAgent = true;
  answers.bayutConnectionView = SAVED;
  answers.bayutAgentLinks = [{ employeeId: "emp-aisha", bayutUserId: 7, bayutUserName: "Ralph Simeon" }];
  const res = await json(ADMIN, "PUT", "/portal-settings/bayut/agents/emp-aisha", { bayutUserId: 7 });
  assert.equal(res.status, 200);
  assert.deepEqual(called("linkBayutAgent"), [[SFS.id, "emp-aisha", { bayutUserId: 7, bayutUserName: "Ralph Simeon" }]]);
  assert.deepEqual((await res.json()).bayut.links, [{ employeeId: "emp-aisha", bayutUserId: 7 }]);

  calls.length = 0;
  assert.equal((await json(ADMIN, "PUT", "/portal-settings/bayut/agents/emp-aisha", { bayutUserId: null })).status, 200);
  assert.deepEqual(called("linkBayutAgent"), [[SFS.id, "emp-aisha", null]]);

  calls.length = 0;
  for (const body of [{ bayutUserId: 99 }, { bayutUserId: "7" }, { bayutUserId: 7.5 }, {}]) {
    const bad = await json(ADMIN, "PUT", "/portal-settings/bayut/agents/emp-aisha", body);
    assert.deepEqual(await words(bad), [400, "Unknown Bayut user."], JSON.stringify(body));
  }
  assert.equal(called("linkBayutAgent").length, 0);
});

test("linking an employee of another business is 404", async () => {
  keepUsers(USERS);
  answers.linkBayutAgent = false;
  for (const bayutUserId of [7, null]) {
    const res = await json(ADMIN, "PUT", "/portal-settings/bayut/agents/emp-other", { bayutUserId });
    assert.deepEqual(await words(res), [404, "Employee not found"]);
  }
});

// ---------------------------------------------------------------------------
// The location search, for board writers
// ---------------------------------------------------------------------------

const DEEP = [
  { id: 1, breadcrumb: ["UAE", "Dubai"] },
  { id: 2, breadcrumb: ["UAE", "Dubai", "Dubai Marina"] },
  { id: 5013, breadcrumb: ["UAE", "Dubai", "Dubai Marina", "Marina Gate"] },
  { id: 6001, breadcrumb: ["UAE", "Dubai", "Dubai Marina", "Marina Gate", "Marina Gate 1"] },
];

test("the location search is for board writers; View as staff is look-only", async () => {
  answers.bayutConnectionView = SAVED;
  answers.bayutToken = { token: TOKEN, agencyId: 3 };
  const res = await search(PREVIEW, "Marina Gate");
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), LOOK_ONLY);
  assert.equal(called("locations").length, 0);
  assert.equal((await search(STAFF, "Marina Gate")).status, 200);
  assert.equal((await search(ADMIN, "Marina Gate x")).status, 200);
  const elsewhere = await as(STAFF).request(`/zipicka/workflow-board/bayut/locations?q=Marina`);
  assert.equal(elsewhere.status, 404);
});

test("a location search needs 3 characters and a connected Bayut", async () => {
  answers.bayutConnectionView = SAVED;
  answers.bayutToken = { token: TOKEN, agencyId: 3 };
  for (const q of ["", "ab", "  ab  "]) {
    assert.deepEqual(await words(await search(STAFF, q)), [400, "Type at least 3 characters."], JSON.stringify(q));
  }
  assert.deepEqual(await words(await json(STAFF, "GET", "/bayut/locations")), [400, "Type at least 3 characters."]);
  for (const view of [NO_TOKEN, { ...SAVED, checkError: "Bayut refused the token: expired" }, { ...SAVED, checkedAt: null }]) {
    answers.bayutConnectionView = view;
    assert.deepEqual(await words(await search(STAFF, "Marina")), [409, "Connect Bayut first."], JSON.stringify(view));
  }
  answers.bayutConnectionView = SAVED;
  answers.bayutToken = null;
  assert.deepEqual(await words(await search(STAFF, "Marina")), [409, "Connect Bayut first."]);
  assert.equal(called("locations").length, 0);
});

test("only deep locations are offered, named by their breadcrumb", async () => {
  answers.bayutConnectionView = SAVED;
  answers.bayutToken = { token: TOKEN, agencyId: 3 };
  answers.locations = { ok: true, data: DEEP };
  const res = await search(STAFF, " Marina Gate ");
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.doesNotMatch(text, new RegExp(TOKEN));
  assert.deepEqual(JSON.parse(text), [
    { id: 5013, name: "UAE › Dubai › Dubai Marina › Marina Gate" },
    { id: 6001, name: "UAE › Dubai › Dubai Marina › Marina Gate › Marina Gate 1" },
  ]);
  // The unit's city, blank being Dubai.
  assert.deepEqual(called("locations"), [[TOKEN, "Marina Gate", "Dubai"]]);
  await search(STAFF, "Al Reem", `&city=${encodeURIComponent(" Abu Dhabi ")}`);
  assert.deepEqual(called("locations").at(-1), [TOKEN, "Al Reem", "Abu Dhabi"]);
});

test("a search made again within the day is answered from the cache, with no Bayut call and no budget", async () => {
  answers.bayutConnectionView = SAVED;
  answers.bayutToken = { token: TOKEN, agencyId: 3 };
  answers.locations = { ok: true, data: DEEP };
  const first = await (await search(STAFF, "Marina Gate")).json();
  const [cached] = sets.filter(([key]) => key.startsWith("bayut-locations:"));
  assert.ok(cached[0].includes(SFS.id), "kept per business");
  assert.deepEqual(cached.slice(2), ["EX", 24 * 60 * 60]);
  assert.equal(store.get(budgetKey()), "1", "the search counts against the business's budget");

  const again = await search(STAFF, "  marina GATE ");
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), first);
  assert.equal(called("locations").length, 1, "no second Bayut call");
  assert.equal(store.get(budgetKey()), "1", "no budget taken for a cached answer");
});

test("a spent budget, a paused business or Bayut's own 429 answers busy", async () => {
  answers.bayutConnectionView = SAVED;
  answers.bayutToken = { token: TOKEN, agencyId: 3 };
  store.set(budgetKey(), "40");
  assert.deepEqual(await words(await search(STAFF, "Marina")), [429, BUSY.error]);
  assert.equal(store.get(budgetKey()), "40", "a refused call is not counted");

  store.delete(budgetKey());
  store.set(`bayut-paused:${SFS.id}`, "1");
  assert.deepEqual(await words(await search(STAFF, "Marina")), [429, BUSY.error]);
  assert.equal(called("locations").length, 0);

  store.delete(`bayut-paused:${SFS.id}`);
  answers.locations = { ok: false, kind: "rate-limited", message: "Too Many Attempts.", retryAfter: 17 };
  assert.deepEqual(await words(await search(STAFF, "Marina")), [429, BUSY.error]);
  assert.deepEqual(sets.find(([key]) => key === `bayut-paused:${SFS.id}`), [`bayut-paused:${SFS.id}`, "1", "EX", 17]);
  assert.equal(sets.filter(([key]) => key.startsWith("bayut-locations:")).length, 0, "nothing cached");
});

test("a search Bayut refuses or cannot answer says so, and nothing is cached", async () => {
  answers.bayutConnectionView = SAVED;
  answers.bayutToken = { token: TOKEN, agencyId: 3 };
  answers.locations = { ok: false, kind: "unreachable", message: "HTTP 503" };
  assert.deepEqual(await words(await search(STAFF, "Marina")), [502, "Could not reach Bayut: HTTP 503"]);
  answers.locations = { ok: false, kind: "refused", message: `The title field is invalid: ${TOKEN}` };
  assert.deepEqual(await words(await search(STAFF, "Marina")), [502, "Bayut refused the search: The title field is invalid: •••"]);
  answers.locations = { ok: false, kind: "token-refused", message: `Unauthenticated ${TOKEN}` };
  const refused = await search(STAFF, "Marina");
  assert.deepEqual(await words(refused), [502, "Bayut refused the token — an admin can check it in Portal settings"]);
  assert.equal(sets.filter(([key]) => key.startsWith("bayut-locations:")).length, 0);
});

// ---------------------------------------------------------------------------
// The card: its Bayut location, and every write followed by both portals
// ---------------------------------------------------------------------------

test("a unit's Bayut location is saved as a pair, or cleared", async () => {
  answers.updateUnit = { kind: "unit", id: "u-1" };
  let res = await json(STAFF, "PATCH", "/units/u-1", { bayutLocationId: 5013, bayutLocationName: " UAE › Dubai › Dubai Marina › Marina Gate " });
  assert.equal(res.status, 200);
  assert.deepEqual(called("updateUnit").at(-1)[4], { bayutLocationId: 5013, bayutLocationName: "UAE › Dubai › Dubai Marina › Marina Gate" });
  res = await json(STAFF, "PATCH", "/units/u-1", { title: "Sea view", bayutLocationId: null, bayutLocationName: null });
  assert.equal(res.status, 200);
  assert.deepEqual(called("updateUnit").at(-1)[4], { title: "Sea view", bayutLocationId: null, bayutLocationName: null });
  res = await json(STAFF, "PATCH", "/units/u-1", { title: "Sea view" });
  assert.deepEqual(called("updateUnit").at(-1)[4], { title: "Sea view" }, "no pair given, none saved");

  calls.length = 0;
  for (const body of [
    { bayutLocationId: 5013 },
    { bayutLocationName: "UAE › Dubai › Dubai Marina › Marina Gate" },
    { bayutLocationId: 5013, bayutLocationName: null },
    { bayutLocationId: null, bayutLocationName: "Marina Gate" },
    { bayutLocationId: 0, bayutLocationName: "Marina Gate" },
    { bayutLocationId: -4, bayutLocationName: "Marina Gate" },
    { bayutLocationId: 50.5, bayutLocationName: "Marina Gate" },
    { bayutLocationId: "5013", bayutLocationName: "Marina Gate" },
    { bayutLocationId: 2 ** 31, bayutLocationName: "Marina Gate" },
    { bayutLocationId: 5013, bayutLocationName: "   " },
    { bayutLocationId: 5013, bayutLocationName: "x".repeat(301) },
    { bayutLocationId: 5013, bayutLocationName: 42 },
  ]) {
    assert.deepEqual(await words(await json(STAFF, "PATCH", "/units/u-1", body)), [400, "Invalid bayutLocation."], JSON.stringify(body).slice(0, 80));
  }
  assert.equal(called("updateUnit").length, 0);
  assert.equal((await json(STAFF, "PATCH", "/units/u-1", { bayutLocationId: 5013, bayutLocationName: "x".repeat(300) })).status, 200);
  // A new card takes no Bayut location: it is set on an existing card only.
  answers.createUnit = { kind: "unit", id: "u-2" };
  await json(STAFF, "POST", "/units", { reference: "A-1", bayutLocationId: 5013, bayutLocationName: "Marina Gate" });
  assert.deepEqual(called("createUnit").at(-1)[3], { reference: "A-1" });
});

test("every unit write queues Property Finder and Bayut; a failed write queues neither", async () => {
  const card = { kind: "unit", id: "u-1" };
  answers.updateUnit = card;
  answers.setUnitPortal = card;
  answers.orderUnitPhotos = true;
  answers.removeUnitPhoto = true;
  answers.setUnitPocket = card;
  answers.moveUnit = { ok: card };
  answers.closeUnit = { ok: true };
  for (const [method, path, body] of [
    ["PATCH", "/units/u-1", { bayutLocationId: 5013, bayutLocationName: "Marina Gate" }],
    ["POST", "/units/u-1/portals/bayut", { wanted: true }],
    ["POST", "/units/u-1/portals/dubizzle", { wanted: false }],
    ["POST", "/units/u-1/photos/order", { ids: ["p-1"] }],
    ["DELETE", "/units/u-1/photos/p-1"],
    ["POST", "/units/u-1/pocket", { pocket: true }],
    ["POST", "/units/u-1/move", { from: "S5", to: "S6" }],
    ["POST", "/units/u-1/close", { reason: "let" }],
  ]) {
    assert.equal((await json(STAFF, method, path, body)).status, 200, `${method} ${path}`);
  }
  assert.equal(called("queuePfUnit").length, 8);
  assert.deepEqual(called("queueBayutUnit"), Array(8).fill([SFS.id, "u-1"]));

  calls.length = 0;
  answers.updateUnit = null;
  assert.equal((await json(STAFF, "PATCH", "/units/u-1", { title: "Sea view" })).status, 404);
  answers.setUnitPortal = "closed";
  assert.equal((await json(STAFF, "POST", "/units/u-1/portals/bayut", { wanted: true })).status, 409);
  assert.equal(called("queuePfUnit").length, 0);
  assert.equal(called("queueBayutUnit").length, 0);
});

test("the switch answers with Bayut's refusal words", async () => {
  const refused = "Before it can go on the portals: the Bayut location, the agent linked to a Bayut user.";
  answers.setUnitPortal = { refused };
  for (const portal of ["bayut", "dubizzle"]) {
    assert.deepEqual(await words(await json(STAFF, "POST", `/units/u-1/portals/${portal}`, { wanted: true })), [422, refused], portal);
  }
  assert.equal(called("queueBayutUnit").length, 0);
});

test("a queue that is down never fails the write or the check, and one portal's queue never holds back the other's", async () => {
  const errors = mock.method(console, "error", () => {});
  try {
    answers.updateUnit = { kind: "unit", id: "u-1" };
    answers.pfQueueDown = true;
    assert.equal((await json(STAFF, "PATCH", "/units/u-1", { title: "Sea view" })).status, 200);
    assert.equal(called("queueBayutUnit").length, 1, "Bayut is queued though Property Finder's queue is down");

    calls.length = 0;
    answers.pfQueueDown = false;
    answers.bayutQueueDown = true;
    assert.equal((await json(STAFF, "PATCH", "/units/u-1", { title: "Sea view" })).status, 200);
    assert.equal(called("queuePfUnit").length, 1);
    assert.equal((await json(ADMIN, "PUT", "/portal-settings/bayut", { token: TOKEN })).status, 200);
    assert.equal(called("queueBayutCycle").length, 1);
    await new Promise((resolve) => setImmediate(resolve));
    const logged = errors.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
    assert.match(logged, /\[bayut\] could not queue/);
    assert.doesNotMatch(logged, new RegExp(TOKEN));
  } finally {
    errors.mock.restore();
  }
});
