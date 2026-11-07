// The unit card's Listing, Photos and Portals sections (7 Nov 2026): staff
// complete the listing where they already work on the unit, see each photo in
// order with the cover first, and switch each portal on or off — the card
// saying in words why a switch cannot go on yet, and what each portal is doing.
// Spec: docs/superpowers/specs/2026-11-07-portal-listings-design.md §2, §4, §5, §8
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { REAL_ESTATE_WORKFLOW } from "@nexus/shared";
import { CardDetail, draftOf, unsavedChanges } from "@/app/deck/workflow/board/card-detail";
import { PortalsSection, portalState } from "@/app/deck/workflow/board/portals-section";
import { PhotosSection } from "@/app/deck/workflow/board/photos-section";

const OFF = { bayut: { wanted: false }, dubizzle: { wanted: false }, property_finder: { wanted: false } };
const AISHA = { id: "e1", name: "Aisha Khan" };
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
};
const BOARD = {
  units: [READY], deals: [], hidden: {}, hotWaiting: [], closed30: { let: 0, sold: 0, won: 0, commissionAed: 0 },
  today: "2026-11-07", portalFeed: { lastReadAt: "2026-11-07T06:42:00.000Z" }, ornSet: true, agentBrns: { e1: true },
};
const TZ = "Asia/Dubai";
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const noop = () => {};
const detail = (card, over = {}) =>
  render(CardDetail, {
    workflow: REAL_ESTATE_WORKFLOW, card, board: { ...BOARD, units: [card] }, history: [], now: Date.parse("2026-11-07T08:00:00Z"),
    timezone: TZ, origin: null, message: "", onSave: async () => true, onMove: noop, onCloseCard: noop, onLink: noop,
    onUnlink: noop, onDismiss: noop, photoSrc: (id) => `/photos/${id}`, canEdit: true, onAddPhotos: noop, onMovePhoto: noop,
    onRemovePhoto: noop, onSwitchPortal: noop, ...over,
  });

test("a unit's window has the Listing, Photos and Portals sections", () => {
  const html = detail(READY);
  for (const h of ["Listing", "Photos", "Portals"]) assert.match(html, new RegExp(`<h3>${h}</h3>`), h);
  assert.match(html, /Bright 1-bed with canal view/);
  assert.match(html, /Size, sq ft/);
  assert.match(html, /<textarea[^>]*aria-label="Description"/);
  assert.match(html, /Balcony/);
  // The manual ticks say they are a note, so nobody takes them for publishing.
  assert.match(html, /<h3>Live on, ticked by hand<\/h3>/);
  assert.match(html, /The Portals switches above are what Nexus publishes\./);
});

test("photos are in order, the first is the cover, and each can move or go", () => {
  const html = render(PhotosSection, { unit: READY, canEdit: true, photoSrc: (id) => `/photos/${id}`, onAdd: noop, onMove: noop, onRemove: noop });
  assert.deepEqual([...html.matchAll(/src="\/photos\/(p\d)"/g)].map((m) => m[1]), ["p1", "p2", "p3"]);
  assert.equal(html.match(/Cover/g)?.length, 1);
  assert.match(html, /Add photos/);
  assert.equal(html.match(/Move earlier/g)?.length, 3);
  assert.equal(html.match(/Remove/g)?.length, 3);
  assert.match(html, /3 of 30/);
});

test("look-only shows the photos and no way to change them", () => {
  const html = render(PhotosSection, { unit: READY, canEdit: false, photoSrc: (id) => `/photos/${id}`, onAdd: noop, onMove: noop, onRemove: noop });
  assert.doesNotMatch(html, /Add photos/);
  assert.doesNotMatch(html, /Move earlier|Remove/);
  const portals = render(PortalsSection, { unit: READY, board: BOARD, canEdit: false, timezone: TZ, onSwitch: noop });
  assert.equal(portals.match(/disabled=""/g)?.length, 3);
});

test("what each portal is doing, in words", () => {
  const on = { ...OFF, bayut: { wanted: true }, property_finder: { wanted: true } };
  const unit = { ...READY, portals: on };
  assert.equal(portalState(unit, "bayut", BOARD, TZ), "In the feed — Bayut last read it 10:42, 7 Nov");
  assert.equal(portalState(unit, "dubizzle", BOARD, TZ), "Off");
  assert.equal(portalState(unit, "property_finder", BOARD, TZ), "Waiting for the Property Finder connection");
  assert.equal(portalState(unit, "bayut", { ...BOARD, portalFeed: { lastReadAt: null } }, TZ), "In the feed — Bayut has not read it yet");
  const dubizzle = { ...READY, portals: { ...OFF, dubizzle: { wanted: true } } };
  assert.equal(portalState(dubizzle, "dubizzle", BOARD, TZ), "In the feed — Bayut last read it 10:42, 7 Nov");
  const expired = { ...unit, permitExpiresOn: "2026-11-06" };
  assert.equal(portalState(expired, "bayut", BOARD, TZ), "Off the portals: a permit that has not expired");
  const html = render(PortalsSection, { unit, board: BOARD, canEdit: true, timezone: TZ, onSwitch: noop });
  assert.match(html, /In the feed — Bayut last read it 10:42, 7 Nov/);
  assert.match(html, /Waiting for the Property Finder connection/);
});

test("a unit that is not ready says what it needs, and offers no switch on", () => {
  const thin = { ...READY, photos: READY.photos.slice(0, 1), description: null };
  const html = render(PortalsSection, { unit: thin, board: { ...BOARD, agentBrns: { e1: false } }, canEdit: true, timezone: TZ, onSwitch: noop });
  assert.match(html, /Before it can go on the portals: a description of at least 50 characters, 2 more photos, the agent&#x27;s BRN\./);
  assert.equal(html.match(/disabled=""/g)?.length, 3);
});

test("a switch already on can always be turned off", () => {
  const thin = { ...READY, photos: [], portals: { ...OFF, bayut: { wanted: true } } };
  const html = render(PortalsSection, { unit: thin, board: BOARD, canEdit: true, timezone: TZ, onSwitch: noop });
  // Bayut (on) stays switchable; dubizzle and Property Finder (off, not ready) do not.
  assert.equal(html.match(/disabled=""/g)?.length, 2);
  assert.match(html, /Off the portals: 3 photos/);
});

test("saving the listing sends only what was touched, in the API's shapes", () => {
  const draft = { ...draftOf(READY), sizeSqft: "812.5", description: "  One.\nTwo.  ", furnishing: "furnished", title: "Bright 1-bed with canal view" };
  const touched = new Set(["sizeSqft", "description", "furnishing", "amenities"]);
  assert.deepEqual(unsavedChanges(READY, draft, READY.liveOn, touched, ["balcony", "central_ac"]), {
    changes: { sizeSqft: 812.5, description: "One.\nTwo.", furnishing: "furnished", amenities: ["balcony", "central_ac"] },
  });
  assert.deepEqual(unsavedChanges(READY, { ...draft, sizeSqft: "812 sqft" }, READY.liveOn, new Set(["sizeSqft"])), {
    problem: "Size, sq ft: a number of square feet, like 812 or 812.5.",
  });
  // Amenities in another order are the same amenities.
  assert.deepEqual(unsavedChanges(READY, draftOf(READY), READY.liveOn, new Set(["amenities"]), ["balcony"]), { changes: {} });
});

test("Portals + social is done only when a portal is wanted AND the unit is ready (spec §5; final review)", async () => {
  const { isPublished } = await import("@/app/deck/workflow/board/portals-section");
  const s10 = { ...READY, step: "S10", portals: { ...OFF, bayut: { wanted: true } } };
  assert.equal(isPublished(s10, BOARD), true);
  assert.equal(isPublished({ ...s10, permitExpiresOn: "2026-11-06" }, BOARD), false);
  assert.equal(isPublished({ ...s10, portals: OFF }, BOARD), false);
  const done = detail(s10);
  assert.match(done, /Live on at least one portal<span class="wf-board-need-state"> — done/);
  const expired = detail({ ...s10, permitExpiresOn: "2026-11-06" });
  assert.match(expired, /Live on at least one portal<span class="wf-board-need-state"> — missing/);
});

// Property Finder's line (7 Nov 2026): the first row that applies wins.
// Spec: docs/superpowers/specs/2026-11-07-property-finder-connection-design.md §6
test("Property Finder's line says exactly where the unit stands", () => {
  const NONE = { state: null, message: null, syncedAt: null };
  const pf = (row, board = {}, unit = {}) =>
    portalState(
      { ...READY, ...unit, portals: { ...OFF, property_finder: { wanted: true, ...NONE, ...row } } },
      "property_finder",
      { ...BOARD, pfConnection: "connected", ...board },
      TZ
    );
  const AT = "2026-11-07T06:42:00.000Z";
  assert.equal(pf({ wanted: false, state: "live", syncedAt: AT }), "Coming off Property Finder");
  assert.equal(pf({ wanted: false }), "Off");
  assert.equal(pf({}, {}, { permitExpiresOn: "2026-11-01" }), "Off the portals: a permit that has not expired");
  assert.equal(pf({}, { pfConnection: "none" }), "Waiting for the Property Finder connection");
  assert.equal(pf({}, { pfConnection: "key-refused" }), "Property Finder refused the key — an admin can check it in Portal settings");
  assert.equal(pf({}, { pfConnection: "waiting-format" }), "Key saved — waiting for Property Finder's listing format");
  assert.equal(pf({ state: "live", syncedAt: AT }), "Live on Property Finder — updated 10:42, 7 Nov");
  assert.equal(pf({ state: "refused", message: "Price is too low", syncedAt: AT }), "Property Finder refused it: Price is too low");
  assert.equal(pf({ state: "failed", message: "HTTP 503", syncedAt: AT }), "Could not reach Property Finder — trying again");
  assert.equal(pf({}), "Sending to Property Finder…");
  assert.equal(pf({ state: "unpublished", syncedAt: AT }), "Sending to Property Finder…");
});
