// The private listing page (7 Nov 2026): what a buyer sees when they open a
// pocket listing's link — the listing, who it is for, the agent with their
// licence, the agency and the permit, how long it works, "I'm interested" and
// WhatsApp the agent — and never the building or the unit's reference. Never
// stored, never indexed, no referrer; one sentence when it no longer works.
// Spec: docs/superpowers/specs/2026-11-07-pocket-listings-design.md §5, §6
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { PocketListing, Unavailable } from "@/app/pocket/[token]/pocket-listing";

const TOKEN = "T".repeat(43);
const API = "http://api.test";
const VIEW = {
  businessName: "SFS International",
  recipientFirstName: "Sara",
  title: "Palm villa with beach access",
  description: "A four-bedroom villa on the Palm with its own stretch of beach and a private pool.",
  purpose: "sale",
  priceAed: 12500000,
  propertyType: "villa",
  bedrooms: 4,
  bathrooms: 5,
  sizeSqft: 5200,
  furnishing: "furnished",
  community: "Palm Jumeirah",
  subCommunity: "Frond K",
  amenities: ["private_pool"],
  availableFrom: null,
  photoIds: ["p1", "p2", "p3"],
  agent: { name: "Aisha Khan", firstName: "Aisha", brn: "45678", whatsapp: "971500000001" },
  contact: { name: "Aisha Khan", firstName: "Aisha", whatsapp: "971500000001" },
  orn: "12345",
  permitNumber: "71450",
  expiresAt: "2026-11-21T06:00:00.000Z",
};
const page = (view = VIEW) => renderToStaticMarkup(createElement(PocketListing, { view, token: TOKEN, apiUrl: API }));
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("the listing, who it is for, and a request for discretion", () => {
  const html = page();
  for (const s of [
    "SFS International",
    "Private listing — shared with Sara",
    "Please keep it to yourself.",
    "Palm villa with beach access",
    "AED 12,500,000",
    "4 bedrooms",
    "5 bathrooms",
    "5,200 sq ft",
    "Frond K, Palm Jumeirah",
    "Private pool",
    "A four-bedroom villa on the Palm",
  ]) {
    assert.ok(html.includes(s), s);
  }
  assert.match(page({ ...VIEW, purpose: "rent", priceAed: 160000 }), /AED 160,000 a year/);
  assert.match(page({ ...VIEW, recipientFirstName: null }), /Private listing</);
});

test("the agent with their licence, the agency, the permit and how long it works", () => {
  const html = page();
  assert.match(html, /Aisha Khan/);
  assert.match(html, /BRN 45678/);
  assert.match(html, /SFS International · ORN 12345/);
  assert.match(html, /Trakheesi permit 71450/);
  assert.match(html, /Available until 21 Nov 2026/);
});

test("the photos come from the link's own address", () => {
  const html = page();
  for (const id of VIEW.photoIds) assert.ok(html.includes(`src="${API}/pocket-shares/${TOKEN}/photos/${id}.jpg"`), id);
  assert.match(html, /alt="Photo 1 of 3"/);
});

test("I'm interested, and WhatsApp the agent when they have a number", () => {
  const html = page();
  assert.match(html, />I&#x27;m interested</);
  const text = encodeURIComponent('Hi, about the private listing "Palm villa with beach access"');
  assert.ok(html.includes(`href="https://wa.me/971500000001?text=${text}"`), "the WhatsApp link");
  assert.match(html, />WhatsApp Aisha</);
  assert.doesNotMatch(page({ ...VIEW, contact: { ...VIEW.contact, whatsapp: null } }), /WhatsApp Aisha/);
});

test("the buyer's own agent is the one to talk to; the listing agent's licence stays (final review)", () => {
  // Staff share a colleague's listing with their own client: the buyer talks to
  // their own agent, while the advert still names the listing agent and BRN.
  const html = page({ ...VIEW, contact: { name: "Bilal Ahmed", firstName: "Bilal", whatsapp: "971500000002" } });
  assert.match(html, /Listed by Aisha Khan · BRN 45678/);
  assert.match(html, /Your agent: Bilal Ahmed/);
  assert.match(html, />WhatsApp Bilal</);
  assert.ok(html.includes("https://wa.me/971500000002?text="), "WhatsApp goes to the buyer's agent");
  assert.doesNotMatch(html, /WhatsApp Aisha/);
  assert.doesNotMatch(page(), /Your agent:/, "one name when the listing agent is the buyer's agent");
});

test("a link preview names nothing but a private listing (final review)", () => {
  // The layout's title template and Open Graph tags (Nexus's own marketing)
  // would otherwise be what WhatsApp shows under every link an agent sends.
  const pageSrc = src("../app/pocket/[token]/page.tsx");
  assert.match(pageSrc, /title: \{ absolute: "Private listing" \}/);
  assert.match(pageSrc, /description: "A private property listing\."/);
  assert.match(pageSrc, /openGraph: \{ title: "Private listing", description: "A private property listing\.", siteName: undefined, url: undefined \}/);
});

test("never the building or the unit's reference", () => {
  const html = page();
  assert.doesNotMatch(html, /Signature Villas|Palm villa 12|reference/i);
});

test("one sentence when the link no longer works", () => {
  const html = renderToStaticMarkup(createElement(Unavailable));
  assert.match(html, /This private listing is no longer available\. Ask the agent who sent it\./);
});

test("the page is never indexed, stored or sent on as a referrer", () => {
  const config = src("../next.config.mjs");
  const block = config.slice(config.indexOf('source: "/pocket/:path*"'));
  assert.ok(block.length > 0 && config.includes('source: "/pocket/:path*"'));
  assert.match(block, /Cache-Control", value: "no-store"/);
  assert.match(block, /Referrer-Policy", value: "no-referrer"/);
  assert.match(block, /X-Robots-Tag", value: "noindex, nofollow"/);
  const pageSrc = src("../app/pocket/[token]/page.tsx");
  assert.match(pageSrc, /robots: \{ index: false, follow: false/);
  assert.match(pageSrc, /cache: "no-store"/);
});

test("the buttons post to the link's own doors, and say thank you", () => {
  const s = src("../app/pocket/[token]/interest-button.tsx");
  assert.match(s, /\/pocket-shares\/\$\{token\}\/interest/);
  assert.match(s, /\/pocket-shares\/\$\{token\}\/view/);
  assert.match(s, /method: "POST"/);
  assert.match(s, /Thank you — \$\{agentFirstName\} will be in touch\./);
});
