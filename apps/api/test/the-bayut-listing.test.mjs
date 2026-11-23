// What a unit becomes on Bayut's Profolio API, and what Bayut needs first
// (23 Nov 2026): the body leaves optional fields OUT (Bayut rejects null or
// empty ones), a studio is -1 bedrooms, amenities go by Bayut's own ids, and
// once a token is saved the unit is not ready until we know its Bayut location
// and the agent's Bayut user (without a connection there is no location picker
// yet, and the card waits for the connection instead).
//
// Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §7, §8
import { test } from "node:test";
import assert from "node:assert/strict";
import { toBayutListing, bayutProblems, matchAmenities, BAYUT_CATEGORY, BAYUT_PORTALS, PROPERTY_TYPES } from "@nexus/shared";

const listing = (over = {}) => ({
  reference: "u1",
  updatedAt: "2026-11-23T00:00:00Z",
  purpose: "rent",
  priceAed: 95000,
  propertyType: "apartment",
  bedrooms: 1,
  bathrooms: 2,
  sizeSqft: 812,
  furnishing: "unfurnished",
  title: "Bright 1-bed with canal view",
  description: "A bright one bedroom apartment overlooking the canal.",
  city: "Dubai",
  community: "Business Bay",
  subCommunity: null,
  building: null,
  amenities: ["balcony"],
  parking: null,
  availableFrom: null,
  permitNumber: "71450",
  permitExpiresOn: "2027-01-01",
  photoUrls: ["https://x/p1.jpg", "https://x/p2.jpg", "https://x/p3.jpg"],
  agent: { name: "A", email: null, phone: null, brn: "1" },
  orn: "99",
  portals: ["bayut"],
  ...over,
});
const ctx = (over = {}) => ({ userId: 7, locationId: 5013, amenityIds: { balcony: "12" }, ...over });

test("a ready rent apartment becomes exactly Bayut's body", () => {
  assert.deepEqual(toBayutListing(listing(), ctx()), {
    reference: "u1",
    user_id: 7,
    title: { en: "Bright 1-bed with canal view" },
    description: { en: "A bright one bedroom apartment overlooking the canal." },
    purpose: "rent",
    category: "apartments",
    location_id: 5013,
    price: 95000,
    rental_details: { rent_frequency: "yearly" },
    area: 812,
    bedrooms: 1,
    bathrooms: 2,
    furnishing_status: "unfurnished",
    construction_status: "completed",
    permit_number: "71450",
    amenities: [{ id: "12", value: "true" }],
    images: [
      { path: "https://x/p1.jpg", is_main: true },
      { path: "https://x/p2.jpg", is_main: false },
      { path: "https://x/p3.jpg", is_main: false },
    ],
  });
});

test("optional fields are left out, never null", () => {
  const sale = toBayutListing(listing({ purpose: "sale" }), ctx());
  assert.equal("rental_details" in sale, false);
  assert.equal(toBayutListing(listing({ bedrooms: 0 }), ctx()).bedrooms, -1);
  const none = toBayutListing(listing({ bedrooms: null, bathrooms: null, furnishing: "semi_furnished" }), ctx());
  for (const k of ["bedrooms", "bathrooms", "furnishing_status"]) assert.equal(k in none, false);
  assert.deepEqual(toBayutListing(listing({ amenities: ["balcony", "study"] }), ctx()).amenities, [{ id: "12", value: "true" }]);
  assert.equal("amenities" in toBayutListing(listing({ amenities: [] }), ctx()), false);
  assert.equal("amenities" in toBayutListing(listing({ amenities: ["study"] }), ctx()), false);
  assert.equal(Object.values(none).some((v) => v === null || v === ""), false);
});

test("every property type but other has a Bayut category", () => {
  assert.equal(BAYUT_CATEGORY.other, null);
  for (const t of PROPERTY_TYPES) if (t !== "other") assert.equal(typeof BAYUT_CATEGORY[t], "string");
  assert.deepEqual([...BAYUT_PORTALS], ["bayut", "dubizzle"]);
});

test("what Bayut still needs, in order", () => {
  const unit = { title: "x".repeat(10), propertyType: "apartment" };
  const full = { tokenSaved: true, locationId: 5, userId: 7 };
  assert.deepEqual(bayutProblems(unit, full), []);
  assert.deepEqual(bayutProblems({ ...unit, title: "x".repeat(101) }, full), ["a title of at most 100 characters"]);
  assert.deepEqual(bayutProblems({ ...unit, propertyType: "other" }, full), ["a property type Bayut takes"]);
  assert.deepEqual(bayutProblems({ ...unit, propertyType: null }, full), [], "the portals' rule already asks for the property type");
  assert.deepEqual(bayutProblems(unit, { ...full, locationId: null }), ["the Bayut location"]);
  assert.deepEqual(bayutProblems(unit, { ...full, userId: null }), ["the agent linked to a Bayut user"]);
  assert.deepEqual(bayutProblems(unit, { ...full, userId: null, tokenSaved: false }), []);
  assert.deepEqual(bayutProblems(unit, { tokenSaved: false, locationId: null, userId: null }), [],
    "without a Bayut connection neither the location nor the agent's link is asked for");
  assert.deepEqual(bayutProblems({ ...unit, propertyType: "other" }, { tokenSaved: false, locationId: null, userId: null }), [
    "a property type Bayut takes",
  ]);
  assert.deepEqual(
    bayutProblems({ ...unit, title: "x".repeat(101), propertyType: "other" }, { tokenSaved: true, locationId: null, userId: null }),
    ["a title of at most 100 characters", "a property type Bayut takes", "the Bayut location", "the agent linked to a Bayut user"]
  );
});

test("Bayut's amenities are matched by title, ignoring case and punctuation", () => {
  assert.deepEqual(
    matchAmenities([{ id: 4, title: { en: "Barbeque Area" } }, { id: 9, title: { en: "Private Pool" } }, { id: 1, title: { en: "Nope" } }]),
    { barbecue_area: "4", private_pool: "9" }
  );
  assert.deepEqual(matchAmenities([{ id: "2", title: { en: "Maid's Room" } }, { id: 3, title: { en: "BALCONY OR TERRACE" } }]), {
    maids_room: "2",
    balcony: "3",
  });
});
