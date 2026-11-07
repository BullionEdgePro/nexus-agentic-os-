// The workflow board's door (3 Nov 2026): one route under
// /api/organizations/:slug, behind the tenant guard. It answers in the words
// staff read, takes who acted from the session and never from the request,
// and keeps "View as staff" look-only.
// Spec: docs/superpowers/specs/2026-11-03-sfs-workflow-board-design.md §3, §7
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Hono } from "hono";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const INDEX = readFileSync(join(root, "apps", "api", "src", "index.ts"), "utf8");

const SFS = { id: "org-sfs", slug: "sfs-international", name: "SFS International", timezone: "Asia/Dubai" };
const ZIP = { id: "org-zip", slug: "zipicka", name: "Zipicka", timezone: "Asia/Dubai" };

const calls = [];
let answers = {};
const stub = (name) => async (...args) => {
  calls.push([name, args]);
  return answers[name];
};

mock.module("@nexus/db", {
  exports: {
    findOrganizationBySlug: async (slug) => ({ [SFS.slug]: SFS, [ZIP.slug]: ZIP })[slug] ?? null,
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
    // Portal listings (7 Nov 2026), tested in the-portal-door.test.mjs.
    addUnitPhoto: stub("addUnitPhoto"),
    unitPhotoBytes: stub("unitPhotoBytes"),
    orderUnitPhotos: stub("orderUnitPhotos"),
    removeUnitPhoto: stub("removeUnitPhoto"),
    setUnitPortal: stub("setUnitPortal"),
    portalSettings: stub("portalSettings"),
    setPortalOrn: stub("setPortalOrn"),
    newPortalFeed: stub("newPortalFeed"),
    setEmployeeBrn: stub("setEmployeeBrn"),
    portalAgents: stub("portalAgents"),
    pfConnectionView: stub("pfConnectionView"),
    savePfConnection: stub("savePfConnection"),
    recordPfCheck: stub("recordPfCheck"),
    clearPfConnection: stub("clearPfConnection"),
    pfCredentials: stub("pfCredentials"),
  },
});

const { workflowBoardRoute, parseUnitFields, parseDealFields } = await import("../src/routes/workflow-board.ts");

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

const send = (scope, method, path, body) =>
  as(scope).request(path, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  calls.length = 0;
  answers = {};
});

test("the door sits behind the tenant guard, under /api/organizations/:slug", () => {
  assert.match(INDEX, /app\.route\("\/api\/organizations", workflowBoardRoute\)/);
  assert.ok(
    INDEX.indexOf('app.use("/api/organizations/:slug/*", requireTenantScope)') < INDEX.indexOf("workflowBoardRoute)"),
    "the route is mounted before the tenant guard"
  );
});

test("a business without a drawn workflow has no board", async () => {
  const res = await send(STAFF, "GET", "/zipicka/workflow-board");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "This business has no workflow." });
  assert.equal(calls.length, 0);
});

test("staff read the board as themselves; an operator sees all", async () => {
  answers.getBoard = { units: [], deals: [] };
  assert.equal((await send(STAFF, "GET", "/sfs-international/workflow-board")).status, 200);
  assert.deepEqual(calls[0][1][0], { organizationId: SFS.id, timezone: "Asia/Dubai", viewer: { employeeId: "emp-aisha", seesAll: false } });
  await send(OPERATOR, "GET", "/sfs-international/workflow-board");
  assert.deepEqual(calls[1][1][0].viewer, { employeeId: null, seesAll: true });
  await send(PREVIEW, "GET", "/sfs-international/workflow-board");
  assert.deepEqual(calls[2][1][0].viewer, { employeeId: null, seesAll: false });
});

test("a move that lost the race says where the card went", async () => {
  answers.moveDeal = { moved: "D5" };
  const res = await send(STAFF, "POST", "/sfs-international/workflow-board/deals/d1/move", { from: "D4", to: "D6" });
  assert.equal(res.status, 409);
  // Exactly the sentence: readableError shows a body that is {"error":"…"} and nothing else (final review).
  assert.deepEqual(await res.json(), { error: "Someone moved this card to Viewing a moment ago." });
  assert.deepEqual(calls[0][1].slice(0, 7), [SFS.id, "Asia/Dubai", { employeeId: "emp-aisha" }, { employeeId: "emp-aisha", seesAll: false }, "d1", "D4", "D6"]);
});

test("a refusal answers 422 in the rule's own words; a closed card 409", async () => {
  answers.moveUnit = { refused: "Before it can be advertised: Trakheesi permit number." };
  const refused = await send(STAFF, "POST", "/sfs-international/workflow-board/units/u1/move", { from: "S8", to: "S9" });
  assert.equal(refused.status, 422);
  assert.deepEqual(await refused.json(), { error: "Before it can be advertised: Trakheesi permit number." });
  answers.closeUnit = { closed: true };
  const closed = await send(STAFF, "POST", "/sfs-international/workflow-board/units/u1/close", { reason: "let" });
  assert.equal(closed.status, 409);
  assert.deepEqual(await closed.json(), { error: "This card is closed." });
  answers.updateDeal = "closed";
  assert.equal((await send(STAFF, "PATCH", "/sfs-international/workflow-board/deals/d1", { offerAed: 5 })).status, 409);
});

test("adding a lead twice, or a stranger, is told so", async () => {
  answers.createDeal = "duplicate";
  const dup = await send(STAFF, "POST", "/sfs-international/workflow-board/deals", { contactId: "c1", purpose: "rent" });
  assert.equal(dup.status, 409);
  assert.deepEqual(await dup.json(), { error: "This lead is already on the board." });
  answers.createDeal = "no-contact";
  assert.equal((await send(STAFF, "POST", "/sfs-international/workflow-board/deals", { contactId: "c9", purpose: "rent" })).status, 404);
  answers.createDeal = { kind: "deal", id: "d2" };
  const made = await send(STAFF, "POST", "/sfs-international/workflow-board/deals", { contactId: "c2", purpose: "sale", step: "D3" });
  assert.equal(made.status, 201);
  assert.deepEqual(calls.at(-1)[1][3], { contactId: "c2", purpose: "sale", step: "D3" });
  const bad = await send(STAFF, "POST", "/sfs-international/workflow-board/deals", { contactId: "c2", purpose: "lease" });
  assert.equal(bad.status, 400);
});

test("a card or history out of reach answers 404, the same as one that is not there", async () => {
  answers.cardHistory = null;
  assert.equal((await send(STAFF, "GET", "/sfs-international/workflow-board/deals/d9/history")).status, 404);
  answers.moveDeal = null;
  assert.equal((await send(STAFF, "POST", "/sfs-international/workflow-board/deals/d9/move", { from: "D4", to: "D5" })).status, 404);
  answers.cardHistory = [{ kind: "created" }];
  const ok = await send(STAFF, "GET", "/sfs-international/workflow-board/units/u1/history");
  assert.deepEqual(await ok.json(), { moves: [{ kind: "created" }] });
  assert.deepEqual(calls.at(-1)[1].slice(2), ["unit", "u1"]);
  assert.equal((await send(STAFF, "GET", "/sfs-international/workflow-board/things/u1/history")).status, 404);
});

test("who acted comes from the session, never from the request", async () => {
  answers.createUnit = { kind: "unit", id: "u2" };
  await send(STAFF, "POST", "/sfs-international/workflow-board/units", { reference: "New", employeeId: "emp-someone-else", adminId: "x" });
  assert.deepEqual(calls[0][1][1], { employeeId: "emp-aisha" });
  await send(OPERATOR, "POST", "/sfs-international/workflow-board/units", { reference: "New" });
  assert.deepEqual(calls[1][1][1], { adminId: "admin-1" });
});

test("View as staff is look-only: every write answers 403", async () => {
  for (const [method, path, body] of [
    ["POST", "/sfs-international/workflow-board/units", { reference: "X" }],
    ["PATCH", "/sfs-international/workflow-board/units/u1", { notes: "x" }],
    ["POST", "/sfs-international/workflow-board/units/u1/move", { from: "S5", to: "S6" }],
    ["POST", "/sfs-international/workflow-board/deals/d1/close", { reason: "lost" }],
    ["POST", "/sfs-international/workflow-board/deals/d1/units", { unitId: "u1" }],
    ["DELETE", "/sfs-international/workflow-board/deals/d1/units/u1"],
  ]) {
    const res = await send(PREVIEW, method, path, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.deepEqual(await res.json(), { error: "Viewing as staff is look-only here." });
  }
  assert.equal(calls.length, 0);
});

test("the listing's fields are checked (7 Nov 2026: portal listings)", () => {
  assert.deepEqual(parseUnitFields({ amenities: ["balcony", "central_ac"] }), { fields: { amenities: ["balcony", "central_ac"] } });
  assert.deepEqual(parseUnitFields({ amenities: ["helipad"] }), { error: "Invalid amenities." });
  assert.deepEqual(parseUnitFields({ amenities: ["balcony", "balcony"] }), { error: "Invalid amenities." });
  // A blank city is Dubai, the business's own.
  assert.deepEqual(parseUnitFields({ city: "  " }), { fields: { city: "Dubai" } });
  assert.deepEqual(parseUnitFields({ city: null }), { fields: { city: "Dubai" } });
  assert.deepEqual(parseUnitFields({ city: "Dubai Marina" }), { fields: { city: "Dubai Marina" } });
  assert.deepEqual(parseUnitFields({ sizeSqft: "812.5" }), { fields: { sizeSqft: 812.5 } });
  assert.deepEqual(parseUnitFields({ sizeSqft: 0 }), { error: "Invalid sizeSqft." });
  assert.deepEqual(parseUnitFields({ bathrooms: 21 }), { error: "Invalid bathrooms." });
  assert.deepEqual(parseUnitFields({ parking: 2 }), { fields: { parking: 2 } });
  assert.deepEqual(parseUnitFields({ furnishing: "half" }), { error: "Invalid furnishing." });
  assert.deepEqual(parseUnitFields({ furnishing: "semi_furnished" }), { fields: { furnishing: "semi_furnished" } });
  assert.deepEqual(parseUnitFields({ title: "x".repeat(121) }), { error: "Invalid title." });
  // Line breaks inside a description are kept; only the ends are trimmed.
  assert.deepEqual(parseUnitFields({ description: "  One.\nTwo.  " }), { fields: { description: "One.\nTwo." } });
  assert.deepEqual(parseUnitFields({ description: "x".repeat(5001) }), { error: "Invalid description." });
  assert.deepEqual(parseUnitFields({ availableFrom: "2026-12-01", subCommunity: "Bay Square", building: "Building 4" }), {
    fields: { availableFrom: "2026-12-01", subCommunity: "Bay Square", building: "Building 4" },
  });
  // Pasted control characters are kept out, so the card shows what the feed publishes (final review).
  assert.deepEqual(parseUnitFields({ title: "Sea\u000bview villa", building: "Tower\u0001A", subCommunity: "Bay\u000cSquare" }), {
    fields: { title: "Sea view villa", building: "Tower A", subCommunity: "Bay Square" },
  });
  assert.deepEqual(parseUnitFields({ description: "One.\nTwo.\u0000\tThree." }), { fields: { description: "One.\nTwo. \tThree." } });
});

test("money is a number of dirhams; commas, signs and words are refused", () => {
  assert.ok("error" in parseUnitFields({ priceAed: "1,200,000" }));
  assert.deepEqual(parseUnitFields({ priceAed: "1200000" }), { fields: { priceAed: 1200000 } });
  assert.deepEqual(parseUnitFields({ priceAed: 85000.5 }), { fields: { priceAed: 85000.5 } });
  assert.ok("error" in parseUnitFields({ priceAed: -1 }));
  assert.ok("error" in parseUnitFields({ priceAed: "85k" }));
  assert.deepEqual(parseUnitFields({ priceAed: null }), { fields: { priceAed: null } });
  assert.ok("error" in parseDealFields({ commissionAed: "AED 5000" }));
  assert.deepEqual(parseDealFields({ commissionAed: "5000.00" }), { fields: { commissionAed: 5000 } });
});

test("fields are checked; unknown ones, and the step and purpose, are dropped", () => {
  assert.ok("error" in parseUnitFields({ liveOn: ["bayut", "x"] }));
  assert.deepEqual(parseUnitFields({ liveOn: ["bayut", "meta"] }), { fields: { liveOn: ["bayut", "meta"] } });
  assert.ok("error" in parseUnitFields({ permitExpiresOn: "31/01/2030" }));
  assert.ok("error" in parseUnitFields({ permitExpiresOn: "2030-02-30" }));
  assert.deepEqual(parseUnitFields({ permitExpiresOn: "2030-01-31" }), { fields: { permitExpiresOn: "2030-01-31" } });
  assert.ok("error" in parseUnitFields({ cheques: 13 }));
  assert.ok("error" in parseUnitFields({ bedrooms: 1.5 }));
  assert.ok("error" in parseUnitFields({ propertyType: "castle" }));
  assert.ok("error" in parseUnitFields({ ejariReady: "yes" }));
  assert.deepEqual(parseUnitFields({ step: "S9", purpose: "rent", organizationId: "x", reference: " Tower 1 " }), {
    fields: { reference: "Tower 1" },
  });
  assert.deepEqual(parseDealFields({ kycDone: true, ejariNumber: " ", step: "D9" }), { fields: { kycDone: true, ejariNumber: null } });
});
