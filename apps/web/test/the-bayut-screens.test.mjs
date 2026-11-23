// The Bayut connection's screens (23 Nov 2026): Portal settings' Bayut and
// dubizzle section (the token, checked and never shown; each agent's Bayut
// user; the credits note) in place of the feed address; the card's Bayut and
// dubizzle lines, every row of the table, first match winning; the confirm a
// switch asks before spending credits; and the Bayut location picker in the
// Listing section. The five web callers reach the API's new routes.
// Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §4, §5, §6, §11, §12
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { REAL_ESTATE_WORKFLOW } from "@nexus/shared";
import {
  BAYUT_ACCOUNT_CHANGED,
  BAYUT_CREDITS_NOTE,
  BAYUT_DISCONNECT_WARNING,
  BayutSection,
  PortalSettingsView,
  bayutCheckedMessage,
  bayutSavedMessage,
} from "@/app/deck/workflow/board/portal-settings";
import { PortalsSection, isPublished, portalState, switchOnConfirm } from "@/app/deck/workflow/board/portals-section";
import { BayutLocationPicker, searchStart } from "@/app/deck/workflow/board/bayut-location";
import { CardDetail } from "@/app/deck/workflow/board/card-detail";
import { checkBayutToken, linkBayutAgent, removeBayutToken, saveBayutToken, searchBayutLocations } from "@/lib/api";

const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const noop = () => {};
const TZ = "Asia/Dubai";
const NOW = Date.parse("2026-11-23T08:00:00.000Z");
const source = (file) => readFileSync(new URL(`../app/deck/workflow/board/${file}`, import.meta.url), "utf8");

// --- The card ---------------------------------------------------------------

const ROW = { wanted: false, state: null, message: null, syncedAt: null, permitComment: null, publishedAt: null };
const OFF = { bayut: ROW, dubizzle: ROW, property_finder: ROW };
const AISHA = { id: "e1", name: "Aisha Khan" };
const PLACE = { id: 5002, name: "UAE › Dubai › Business Bay › Bay Square › Building 4" };
const READY = {
  kind: "unit", id: "u1", step: "S9", inStepSince: "2026-11-01T08:00:00.000Z", updatedAt: "2026-11-06T09:30:00.000Z",
  reference: "Bay Square 4 · 1102", community: "Business Bay", propertyType: "apartment", bedrooms: 1, purpose: "rent",
  priceAed: 95000, cheques: 4, ejariReady: true, titleDeed: false, ownerDocs: false, formASignedOn: "2026-10-28",
  permitNumber: "71450", permitExpiresOn: "2027-10-27", liveOn: [], owner: null, agent: AISHA, notes: null, dealIds: [],
  title: "Bright 1-bed with canal view", description: "A bright one-bedroom apartment on a high floor, with a balcony over the canal.",
  sizeSqft: 812, bathrooms: 2, furnishing: "unfurnished", city: "Dubai", subCommunity: "Bay Square", building: "Building 4",
  parking: 1, amenities: ["balcony"], availableFrom: "2026-12-01",
  photos: [
    { id: "p1", width: 2048, height: 1536 },
    { id: "p2", width: 2048, height: 1536 },
    { id: "p3", width: 2048, height: 1536 },
  ],
  portals: OFF,
  bayutLocation: PLACE,
  pocket: { on: false, since: null, shares: [] },
};
const BOARD = {
  units: [READY], deals: [], hidden: {}, hotWaiting: [], closed30: { let: 0, sold: 0, won: 0, commissionAed: 0 },
  today: "2026-11-23", portalFeed: null, ornSet: true, agentBrns: { e1: true }, agentsGone: [], pfConnection: "none",
  bayutConnection: "connected", bayutLinked: { e1: true },
};

/** One portal's line, for a unit whose `portal` row is `row`. */
const line = (portal, row, board = {}, unit = {}) =>
  portalState(
    { ...READY, ...unit, portals: { ...OFF, [portal]: { ...ROW, wanted: true, ...row } } },
    portal,
    { ...BOARD, ...board },
    TZ,
    NOW
  );

const SYNCED = "2026-11-23T06:42:00.000Z"; // 10:42, 23 Nov in Dubai
const ASKED = "2026-11-23T05:00:00.000Z"; // 09:00, 23 Nov — three hours before NOW

test("Bayut's line, every row of the table, the first that applies winning", () => {
  const b = (row, board, unit) => line("bayut", row, board, unit);
  assert.equal(
    b({ wanted: false, state: "unpublished", message: "Bayut took it off on 21 Nov" }),
    "Off — Bayut took it off on 21 Nov. Tick to publish again (uses credits)."
  );
  assert.equal(b({ wanted: false }), "Off");
  assert.equal(b({ wanted: false, state: "unpublished" }), "Off");
  assert.equal(b({ wanted: false, state: "refused", message: "Bad photo" }), "Off");
  for (const state of ["live", "pending", "draft"]) assert.equal(b({ wanted: false, state }), "Coming off Bayut", state);
  assert.equal(b({}, {}, { permitExpiresOn: "2026-11-01" }), "Off the portals: a permit that has not expired");
  assert.equal(b({}, { bayutConnection: "none" }), "Waiting for the Bayut connection");
  assert.equal(b({}, { bayutConnection: "token-refused" }), "Bayut refused the token — an admin can check it in Portal settings");
  assert.equal(b({ state: "refused", message: "Permit number does not match", syncedAt: SYNCED }), "Bayut refused it: Permit number does not match");
  assert.equal(
    b({ state: "pending", permitComment: "Permit under review", publishedAt: ASKED }),
    "Waiting for Bayut's permit check — Permit under review"
  );
  assert.equal(b({ state: "pending", publishedAt: ASKED }), "Sent to Bayut 23 Nov — waiting for Bayut to publish it");
  assert.equal(
    b({ state: "live", message: "Price must be a whole number", syncedAt: SYNCED }),
    "Live on Bayut, but Bayut refused the last change: Price must be a whole number"
  );
  assert.equal(b({ state: "live", syncedAt: SYNCED }), "Live on Bayut — checked 10:42, 23 Nov. Edit it here, not in Profolio.");
  assert.equal(b({ state: "failed", message: "HTTP 503", publishedAt: ASKED }), "Could not reach Bayut — trying again");
  assert.equal(b({ state: "unpublished", publishedAt: ASKED }), "Published less than a day ago — Nexus tries again 09:00, 24 Nov");
  assert.equal(b({}), "Sending to Bayut…");
  assert.equal(b({ state: "draft" }), "Sending to Bayut…");
  // A day after the last publish, the guard has passed.
  assert.equal(b({ state: "unpublished", publishedAt: "2026-11-22T07:00:00.000Z" }), "Sending to Bayut…");
});

test("dubizzle's line says dubizzle wherever the listing is; Bayut's connection, checks and answers stay Bayut's", () => {
  const d = (row, board, unit) => line("dubizzle", row, board, unit);
  assert.equal(
    d({ wanted: false, state: "unpublished", message: "Bayut took it off on 21 Nov" }),
    "Off — Bayut took it off on 21 Nov. Tick to publish again (uses credits)."
  );
  assert.equal(d({ wanted: false }), "Off");
  assert.equal(d({ wanted: false, state: "live" }), "Coming off dubizzle");
  assert.equal(d({}, {}, { permitExpiresOn: "2026-11-01" }), "Off the portals: a permit that has not expired");
  assert.equal(d({}, { bayutConnection: "none" }), "Waiting for the Bayut connection");
  assert.equal(d({}, { bayutConnection: "token-refused" }), "Bayut refused the token — an admin can check it in Portal settings");
  assert.equal(d({ state: "refused", message: "Duplicate listing" }), "Bayut refused it: Duplicate listing");
  assert.equal(d({ state: "pending", permitComment: "Permit under review" }), "Waiting for Bayut's permit check — Permit under review");
  assert.equal(d({ state: "pending", publishedAt: ASKED }), "Sent to dubizzle 23 Nov — waiting for Bayut to publish it");
  assert.equal(d({ state: "live", message: "Too many photos", syncedAt: SYNCED }), "Live on dubizzle, but Bayut refused the last change: Too many photos");
  assert.equal(d({ state: "live", syncedAt: SYNCED }), "Live on dubizzle — checked 10:42, 23 Nov. Edit it here, not in Profolio.");
  assert.equal(d({ state: "failed" }), "Could not reach Bayut — trying again");
  assert.equal(d({ state: "unpublished", publishedAt: ASKED }), "Published less than a day ago — Nexus tries again 09:00, 24 Nov");
  assert.equal(d({}), "Sending to dubizzle…");
});

test("after Disconnect, a listing already on Bayut says it stays until removed in Profolio (ruling 2)", () => {
  const removed = "Bayut connection removed — listings already on Bayut stay until removed in Profolio";
  for (const portal of ["bayut", "dubizzle"]) {
    for (const state of ["live", "pending"]) {
      assert.equal(line(portal, { state, syncedAt: SYNCED }, { bayutConnection: "none" }), removed, `${portal} ${state}`);
      // Unticked: nothing can take it off without the connection.
      assert.equal(line(portal, { wanted: false, state }, { bayutConnection: "none" }), removed, `${portal} ${state} unticked`);
    }
    // Never on Bayut: waiting, as before.
    assert.equal(line(portal, { state: "draft" }, { bayutConnection: "none" }), "Waiting for the Bayut connection");
    assert.equal(line(portal, { wanted: false }, { bayutConnection: "none" }), "Off");
  }
});

test("a check that could not reach Bayut does not say the token was refused", () => {
  assert.equal(
    line("bayut", {}, { bayutConnection: "check-failed" }),
    "Bayut could not be reached to check the token — an admin can check it again in Portal settings"
  );
});

test("Bayut's own needs come after the portals' rule, once a token is saved (spec §8)", () => {
  assert.equal(line("bayut", {}, {}, { bayutLocation: null }), "Off the portals: the Bayut location");
  assert.equal(line("dubizzle", {}, { bayutLinked: { e1: false } }), "Off the portals: the agent linked to a Bayut user");
  assert.equal(line("bayut", {}, {}, { propertyType: "other" }), "Off the portals: a property type Bayut takes");
  // Property Finder never asks for them.
  assert.equal(line("property_finder", {}, {}, { bayutLocation: null }), "Waiting for the Property Finder connection");
  // Without a token, the location and the link are not asked for yet.
  assert.equal(line("bayut", {}, { bayutConnection: "none" }, { bayutLocation: null }), "Waiting for the Bayut connection");
});

test("a unit ready for the portals but not for Bayut keeps Bayut's switches off and says why", () => {
  const unit = { ...READY, bayutLocation: null };
  const html = render(PortalsSection, { unit, board: BOARD, canEdit: true, timezone: TZ, now: NOW, onSwitch: noop });
  // Bayut and dubizzle cannot go on; Property Finder can.
  assert.equal(html.match(/disabled=""/g)?.length, 2);
  assert.match(html, /Before it can go on Bayut and dubizzle: the Bayut location\./);
  assert.doesNotMatch(html, /Before it can go on the portals/);
  // Wanted on Bayut alone, it is not live anywhere (spec §5: wanted AND ready).
  const onBayut = { ...unit, step: "S10", portals: { ...OFF, bayut: { ...ROW, wanted: true } } };
  assert.equal(isPublished(onBayut, BOARD), false);
  assert.equal(isPublished({ ...onBayut, bayutLocation: PLACE }, BOARD), true);
});

test("switching Bayut or dubizzle on asks first, because it spends Bayut credits", () => {
  assert.equal(
    switchOnConfirm("bayut"),
    "Publishing on Bayut uses Bayut credits from SFS's account. If this unit is already on Bayut through Profolio, remove it there first."
  );
  assert.match(switchOnConfirm("dubizzle"), /^Publishing on dubizzle uses Bayut credits from SFS's account\./);
  assert.equal(switchOnConfirm("property_finder"), null);
  const src = source("portals-section.tsx");
  assert.match(src, /window\.confirm\(/);
  assert.match(src, /switchOnConfirm\(portal\)/);
});

test("the card no longer speaks of the feed", () => {
  const on = { ...READY, portals: { ...OFF, bayut: { ...ROW, wanted: true } } };
  const html = render(PortalsSection, { unit: on, board: { ...BOARD, portalFeed: { lastReadAt: SYNCED } }, canEdit: true, timezone: TZ, now: NOW, onSwitch: noop });
  assert.doesNotMatch(html, /In the feed/);
  assert.match(html, /Sending to Bayut…/);
});

// --- The location picker -------------------------------------------------------

const picker = (over = {}, board = {}) =>
  render(BayutLocationPicker, { unit: READY, board: { ...BOARD, ...board }, canEdit: true, onPick: async () => true, onSearch: async () => [], ...over });

test("the Bayut location is offered only once Bayut is connected", () => {
  for (const bayutConnection of ["none", "token-refused", "check-failed"]) assert.equal(picker({}, { bayutConnection }), "", bayutConnection);
  assert.match(picker(), /Bayut location/);
});

test("a saved Bayut location shows its name, with a way to change it", () => {
  const html = picker();
  assert.match(html, /UAE › Dubai › Business Bay › Bay Square › Building 4/);
  assert.match(html, />Change</);
  assert.doesNotMatch(html, /type="search"/, "the search waits for Change");
  const look = picker({ canEdit: false });
  assert.match(look, /Bay Square › Building 4/);
  assert.doesNotMatch(look, />Change</);
});

test("with none saved, the search starts from the building, else the sub-community, else the community", () => {
  const html = picker({ unit: { ...READY, bayutLocation: null } });
  assert.match(html, /<input[^>]*type="search"[^>]*value="Building 4"|<input[^>]*value="Building 4"[^>]*type="search"/);
  assert.match(html, />Search</);
  assert.equal(searchStart(READY), "Building 4");
  assert.equal(searchStart({ ...READY, building: " " }), "Bay Square");
  assert.equal(searchStart({ ...READY, building: null, subCommunity: null }), "Business Bay");
  assert.equal(searchStart({ ...READY, building: null, subCommunity: null, community: null }), "");
  // Look-only: no search, and says nothing is chosen.
  const look = picker({ unit: { ...READY, bayutLocation: null }, canEdit: false });
  assert.doesNotMatch(look, /type="search"/);
  assert.match(look, /Not chosen yet\./);
});

test("the search asks with the unit's city, and a pick saves through the unit's own save", () => {
  const src = source("bayut-location.tsx");
  assert.match(src, /onSearch\(q, unit\.city \?\? ""\)/);
  assert.match(src, /Type at least 3 characters\./);
  const card = source("card-detail.tsx");
  assert.match(card, /onSave\(\{ bayutLocationId: [\w.]+, bayutLocationName: [\w.]+ \}\)/);
});

test("the unit's window has the Bayut location in its Listing section, only when connected", () => {
  const detail = (board) =>
    render(CardDetail, {
      workflow: REAL_ESTATE_WORKFLOW, card: READY, board: { ...BOARD, ...board, units: [READY] }, history: [], now: NOW, timezone: TZ,
      origin: null, message: "", onSave: async () => true, onMove: noop, onCloseCard: noop, onLink: noop, onUnlink: noop, onDismiss: noop,
    });
  assert.match(detail({}), /Bayut location[\s\S]*Bay Square › Building 4/);
  assert.doesNotMatch(detail({ bayutConnection: "none" }), /Bayut location/);
});

// --- Portal settings -------------------------------------------------------------

const BAYUT_NONE = { saved: false, agencyName: null, tokenEnding: null, checkedAt: null, checkError: null, users: [], links: [] };
const BAYUT_SAVED = {
  saved: true,
  agencyName: "Sfs International Real Estate - Sandbox",
  tokenEnding: "1a2b",
  checkedAt: SYNCED,
  checkError: null,
  users: [
    { id: 901, name: "Owner Account", email: "owner@example.com" },
    { id: 902, name: "Aisha K", email: "aisha@example.com" },
  ],
  links: [{ employeeId: "e1", bayutUserId: 902 }],
};
const AGENTS = [
  { id: "e1", name: "Aisha Khan", brn: "45678" },
  { id: "e2", name: "Bilal Ahmed", brn: null },
];
const bayutView = (bayut) =>
  render(BayutSection, { bayut, agents: AGENTS, timezone: TZ, onSaveToken: noop, onCheck: noop, onDisconnect: noop, onLinkAgent: noop });

test("with no token, the steps, a password field for the token and Save and check — never a token shown", () => {
  const html = bayutView(BAYUT_NONE);
  assert.match(html, /<h3>Bayut and dubizzle<\/h3>/);
  assert.match(html, /Profolio/);
  const input = html.match(/<input[^>]*aria-label="API token"[^>]*>/)?.[0];
  assert.ok(input, "an API token field");
  assert.match(input, /type="password"/);
  assert.match(input, /autocomplete="new-password"/i);
  assert.match(input, /value=""/);
  assert.match(html, />API token</);
  assert.match(html, />Save and check</);
  for (const b of ["Check again", "Replace token", "Disconnect"]) assert.doesNotMatch(html, new RegExp(`>${b}<`), b);
  assert.match(html, new RegExp(BAYUT_CREDITS_NOTE.replace(/[().]/g, "\\$&")));
  assert.equal(BAYUT_CREDITS_NOTE, "Publishing uses Bayut credits. Boosts (Hot, Signature) are bought in Profolio.");
});

test("a saved token shows the account, its ending and the check, the buttons, and each agent's Bayut user", () => {
  const html = bayutView(BAYUT_SAVED);
  assert.match(html, /Connected to Sfs International Real Estate - Sandbox — token ending 1a2b, checked 10:42, 23 Nov/);
  for (const b of ["Check again", "Replace token", "Disconnect"]) assert.match(html, new RegExp(`>${b}<`), b);
  assert.doesNotMatch(html, /aria-label="API token"/, "the field waits for Replace token");
  // Agents: each staff member, with the Bayut users read at the last check and "Not linked".
  assert.match(html, /Agents/);
  assert.equal(html.match(/aria-label="Bayut user for /g)?.length, 2);
  assert.match(html, /Aisha Khan/);
  assert.match(html, /Bilal Ahmed/);
  assert.match(html, />Not linked</);
  assert.match(html, /<option value="902" selected="">Aisha K/);
  assert.match(html, />Owner Account/);
});

test("a link to a Bayut user no longer read still shows, not as Not linked", () => {
  const html = bayutView({ ...BAYUT_SAVED, users: [] });
  assert.match(html, /<option value="902" selected="">Bayut user 902</);
});

test("a refused or unreachable check says so, never Connected to a stale account name", () => {
  const refused = bayutView({ ...BAYUT_SAVED, checkError: "Bayut refused the token: Unauthenticated." });
  assert.match(refused, /Bayut refused the token: Unauthenticated\./);
  assert.doesNotMatch(refused, /Connected to/);
  const unreachable = bayutView({ ...BAYUT_SAVED, checkError: "Could not reach Bayut: timed out" });
  assert.match(unreachable, /Could not reach Bayut: timed out/);
  assert.doesNotMatch(unreachable, /Connected to/);
});

test("a token for another account says every switch was turned off; Disconnect asks first", () => {
  assert.equal(
    BAYUT_ACCOUNT_CHANGED,
    "This token is for another Bayut account. Every Bayut and dubizzle switch will be turned off; tick the units again to publish them there."
  );
  const answer = (over) => ({ orn: null, agents: AGENTS, bayut: BAYUT_SAVED, accountChanged: false, ...over });
  assert.equal(bayutSavedMessage(answer({ accountChanged: true })), BAYUT_ACCOUNT_CHANGED);
  assert.equal(bayutCheckedMessage(answer({ accountChanged: true })), BAYUT_ACCOUNT_CHANGED);
  assert.equal(bayutSavedMessage(answer({})), "Token saved — Bayut accepted it.");
  assert.equal(bayutSavedMessage(answer({ bayut: { ...BAYUT_SAVED, checkError: "Bayut refused the token: no" } })), "Token saved, but the check did not pass.");
  assert.equal(bayutCheckedMessage(answer({})), "Bayut accepts the token.");
  assert.equal(bayutCheckedMessage(answer({ bayut: { ...BAYUT_SAVED, checkError: "Could not reach Bayut: x" } })), "The check did not pass.");
  assert.equal(BAYUT_DISCONNECT_WARNING, "Nexus stops updating Bayut and dubizzle. Listings already on Bayut stay until removed in Profolio.");
  const src = source("portal-settings.tsx");
  assert.match(src, /window\.confirm\(BAYUT_DISCONNECT_WARNING\)/);
  // The field is emptied as soon as the token is sent.
  const save = src.slice(src.indexOf("onSaveToken(token"));
  assert.match(save.slice(0, 300), /setToken\(""\)/);
});

test("Portal settings has the Bayut and dubizzle section in place of the feed address", () => {
  const html = render(PortalSettingsView, {
    settings: {
      orn: "12345",
      feedUrl: `https://api.nexusagenticos.com/portal-feeds/${"T".repeat(43)}/bayut.xml`,
      lastReadAt: SYNCED,
      lastReadBy: "BayutBot/1.0",
      agents: AGENTS,
      propertyFinder: { saved: false, environment: null, keyEnding: null, checkedAt: null, checkError: null, listingCallsReady: false },
      bayut: BAYUT_SAVED,
    },
    timezone: TZ,
    message: "",
    onSaveOrn: noop,
    onSaveBrn: noop,
    onSavePfKey: noop,
    onCheckPf: noop,
    onDisconnectPf: noop,
    onSaveBayutToken: noop,
    onCheckBayut: noop,
    onDisconnectBayut: noop,
    onLinkBayutAgent: noop,
  });
  assert.match(html, /<h3>Bayut and dubizzle<\/h3>/);
  assert.match(html, /Connected to Sfs International Real Estate - Sandbox/);
  assert.doesNotMatch(html, /feed/i);
  assert.doesNotMatch(html, /portal-feeds/);
  assert.doesNotMatch(html, />Copy<|>New address<|>Make the address</);
  assert.match(html, /<h3>Property Finder<\/h3>/);
});

// --- The web callers -------------------------------------------------------------

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ?? null });
  return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
};
const last = () => calls[calls.length - 1];

test("the five callers reach the API's Bayut routes, in its shapes", async () => {
  await saveBayutToken("sfs", "tok-123");
  assert.match(last().url, /\/api\/organizations\/sfs\/workflow-board\/portal-settings\/bayut$/);
  assert.equal(last().method, "PUT");
  assert.deepEqual(JSON.parse(last().body), { token: "tok-123" });

  await checkBayutToken("sfs");
  assert.match(last().url, /\/portal-settings\/bayut\/check$/);
  assert.equal(last().method, "POST");

  await removeBayutToken("sfs");
  assert.match(last().url, /\/portal-settings\/bayut$/);
  assert.equal(last().method, "DELETE");

  await linkBayutAgent("sfs", "e1", 902);
  assert.match(last().url, /\/portal-settings\/bayut\/agents\/e1$/);
  assert.equal(last().method, "PUT");
  assert.deepEqual(JSON.parse(last().body), { bayutUserId: 902 });
  await linkBayutAgent("sfs", "e1", null);
  assert.deepEqual(JSON.parse(last().body), { bayutUserId: null });

  await searchBayutLocations("sfs", "Bay Square & 4", "Dubai");
  assert.match(last().url, /\/api\/organizations\/sfs\/workflow-board\/bayut\/locations\?q=Bay%20Square%20%26%204&city=Dubai$/);
  assert.equal(last().method, "GET");
});
