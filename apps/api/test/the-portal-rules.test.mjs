// Ready for the portals (7 Nov 2026): one rule, used by the card and the
// server, says in staff's words what a unit still needs before it can go on
// Bayut, dubizzle or Property Finder — and builds the portal-neutral listing
// each portal's adapter turns into its own format.
// Spec: docs/superpowers/specs/2026-11-07-portal-listings-design.md §2, §4, §5
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AMENITIES,
  AMENITY_WORDS,
  FURNISHING,
  PORTAL_TARGETS,
  portalProblems,
  portalProblemSentence,
  stepNeeds,
  toPortalListing,
} from "@nexus/shared";

const TODAY = "2026-11-07";
const OFF = { bayut: { wanted: false }, dubizzle: { wanted: false }, property_finder: { wanted: false } };

const READY = {
  kind: "unit",
  id: "u-1",
  step: "S9",
  inStepSince: "2026-11-01T08:00:00.000Z",
  updatedAt: "2026-11-06T09:30:00.000Z",
  reference: "Bay Square 4 · 1102",
  community: "Business Bay",
  propertyType: "apartment",
  bedrooms: 1,
  purpose: "rent",
  priceAed: 95000,
  cheques: 4,
  ejariReady: true,
  titleDeed: false,
  ownerDocs: false,
  formASignedOn: "2026-10-28",
  permitNumber: "71450",
  permitExpiresOn: "2027-10-27",
  liveOn: [],
  owner: null,
  agent: { id: "emp-aisha", name: "Aisha Khan" },
  notes: "Owner wants a family",
  dealIds: [],
  title: "Bright 1-bed with canal view",
  description: "A bright one-bedroom apartment on a high floor, with a balcony over the canal.",
  sizeSqft: 812,
  bathrooms: 2,
  furnishing: "unfurnished",
  city: "Dubai",
  subCommunity: "Bay Square",
  building: "Building 4",
  parking: 1,
  amenities: ["balcony", "central_ac"],
  availableFrom: "2026-12-01",
  photos: [
    { id: "p1", width: 2048, height: 1536 },
    { id: "p2", width: 2048, height: 1536 },
    { id: "p3", width: 2048, height: 1536 },
  ],
  portals: OFF,
};
const CTX = { today: TODAY, orn: "12345", agentBrn: "45678", photoCount: 3 };

const unit = (over = {}) => ({ ...READY, ...over });

test("the lists are the spec's", () => {
  assert.deepEqual([...PORTAL_TARGETS], ["bayut", "dubizzle", "property_finder"]);
  assert.equal(AMENITIES.length, 18);
  assert.equal(AMENITIES[0], "balcony");
  assert.equal(AMENITIES[17], "barbecue_area");
  for (const key of AMENITIES) assert.equal(typeof AMENITY_WORDS[key], "string", key);
  assert.deepEqual([...FURNISHING], ["furnished", "semi_furnished", "unfurnished"]);
});

test("a ready unit needs nothing", () => {
  assert.deepEqual(portalProblems(READY, CTX), []);
  assert.equal(portalProblemSentence([]), null);
});

test("a blank card names every gap, in the spec's order", () => {
  const blank = unit({
    step: "S5", purpose: null, priceAed: null, propertyType: null, bedrooms: null, bathrooms: null, sizeSqft: null,
    title: null, description: null, community: null, agent: null, formASignedOn: null, permitNumber: null, permitExpiresOn: null,
    photos: [],
  });
  assert.deepEqual(portalProblems(blank, { today: TODAY, orn: null, agentBrn: null, photoCount: 0, closed: true }), [
    "an open card",
    "the card on Listing & ads or Portals + social",
    "a permit that has not expired",
    "rent or sale",
    "a price",
    "the property type",
    "bedrooms",
    "bathrooms",
    "the size",
    "a title of 10 to 120 characters",
    "a description of at least 50 characters",
    "the community",
    "3 photos",
    "an agent on the card",
    "the agency's ORN",
  ]);
});

test("an agent without a BRN, and a business without an ORN, are named", () => {
  assert.deepEqual(portalProblems(READY, { ...CTX, agentBrn: null }), ["the agent's BRN"]);
  assert.deepEqual(portalProblems(READY, { ...CTX, orn: null }), ["the agency's ORN"]);
});

test("an office needs no bedrooms or bathrooms; land needs no bathrooms either", () => {
  assert.deepEqual(portalProblems(unit({ propertyType: "office", bedrooms: null, bathrooms: null }), CTX), []);
  assert.deepEqual(portalProblems(unit({ propertyType: "land", bedrooms: null, bathrooms: null }), CTX), []);
  assert.deepEqual(portalProblems(unit({ propertyType: "villa", bathrooms: null }), CTX), ["bathrooms"]);
  // A studio has 0 bedrooms, which is an answer.
  assert.deepEqual(portalProblems(unit({ bedrooms: 0 }), CTX), []);
});

test("photos count down to three", () => {
  assert.deepEqual(portalProblems(READY, { ...CTX, photoCount: 2 }), ["1 more photo"]);
  assert.deepEqual(portalProblems(READY, { ...CTX, photoCount: 1 }), ["2 more photos"]);
  assert.deepEqual(portalProblems(READY, { ...CTX, photoCount: 0 }), ["3 photos"]);
});

test("a permit that has expired takes it off the portals", () => {
  assert.deepEqual(portalProblems(unit({ permitExpiresOn: "2026-11-06" }), CTX), ["a permit that has not expired"]);
  // Expiring today is still valid today.
  assert.deepEqual(portalProblems(unit({ permitExpiresOn: TODAY }), CTX), []);
});

test("titles and descriptions have their lengths", () => {
  assert.deepEqual(portalProblems(unit({ title: "Short one" }), CTX), ["a title of 10 to 120 characters"]);
  assert.deepEqual(portalProblems(unit({ title: "x".repeat(121) }), CTX), ["a title of 10 to 120 characters"]);
  assert.deepEqual(portalProblems(unit({ title: "   Ten chars   ".padEnd(5) }), CTX), ["a title of 10 to 120 characters"]);
  assert.deepEqual(portalProblems(unit({ description: "x".repeat(49) }), CTX), ["a description of at least 50 characters"]);
  assert.deepEqual(portalProblems(unit({ step: "S10" }), CTX), []);
});

test("the sentence staff read", () => {
  assert.equal(portalProblemSentence(["a price", "the size"]), "Before it can go on the portals: a price, the size.");
});

test("Portals + social is done when the unit is published from Nexus: wanted AND ready (spec §5; final review)", () => {
  const s10 = unit({ step: "S10", liveOn: [] });
  assert.deepEqual(stepNeeds(s10), [{ label: "Live on at least one portal", done: false }]);
  const wanted = unit({ step: "S10", liveOn: [], portals: { ...OFF, bayut: { wanted: true } } });
  // Wanted is not published: the caller says whether it is also ready.
  assert.deepEqual(stepNeeds(wanted), [{ label: "Live on at least one portal", done: false }]);
  assert.deepEqual(stepNeeds(wanted, true), [{ label: "Live on at least one portal", done: true }]);
  // A tick by hand still counts, as it always did.
  assert.deepEqual(stepNeeds(unit({ step: "S10", liveOn: ["meta"] })), [{ label: "Live on at least one portal", done: true }]);
});

test("an agent who has left the staff takes the unit off the portals (final review)", () => {
  assert.deepEqual(portalProblems(READY, { ...CTX, agentActive: false }), ["an agent still on the staff"]);
  // Still on the staff is the default.
  assert.deepEqual(portalProblems(READY, { ...CTX, agentActive: true }), []);
});

test("the portal-neutral listing carries what a portal publishes, and nothing private", () => {
  const agent = { name: "Aisha Khan", email: "aisha@sfs.ae", phone: "971501112233", brn: "45678" };
  const listing = toPortalListing(READY, {
    orn: "12345",
    agent,
    photoUrls: ["https://api.nexusagenticos.com/portal-photos/p1.jpg"],
    portals: ["bayut"],
  });
  assert.deepEqual(listing, {
    reference: "u-1",
    updatedAt: "2026-11-06T09:30:00.000Z",
    purpose: "rent",
    priceAed: 95000,
    propertyType: "apartment",
    bedrooms: 1,
    bathrooms: 2,
    sizeSqft: 812,
    furnishing: "unfurnished",
    title: "Bright 1-bed with canal view",
    description: "A bright one-bedroom apartment on a high floor, with a balcony over the canal.",
    city: "Dubai",
    community: "Business Bay",
    subCommunity: "Bay Square",
    building: "Building 4",
    amenities: ["balcony", "central_ac"],
    parking: 1,
    availableFrom: "2026-12-01",
    permitNumber: "71450",
    permitExpiresOn: "2027-10-27",
    photoUrls: ["https://api.nexusagenticos.com/portal-photos/p1.jpg"],
    agent,
    orn: "12345",
    portals: ["bayut"],
  });
  assert.equal(JSON.stringify(listing).includes("Owner wants a family"), false);
});
