import { AMENITY_WORDS, type Amenity, type PortalListing } from "./listing.js";

/**
 * The Bayut / dubizzle feed (7 Nov 2026): one XML document Bayut reads from a
 * public address and publishes to Bayut and/or dubizzle (one company).
 *
 * THE TAG NAMES BELOW ARE PROVISIONAL until Bayut's own XML document arrives
 * (Bayut sends it to the agency on request, support@bayut.com). Phase 2 aligns
 * the BAYUT_TAGS map and the value words with that document — only this file.
 * Bayut activates the feed only after the agency sends the address, so nothing
 * reaches the portals before that alignment.
 * Spec: docs/superpowers/specs/2026-11-07-portal-listings-design.md §6
 */

const BAYUT_TAGS = {
  root: "Listings",
  listing: "Listing",
  reference: "Property_Ref_No",
  permit: "Permit_Number",
  purpose: "Property_purpose",
  type: "Property_Type",
  status: "Property_Status",
  city: "City",
  community: "Locality",
  subCommunity: "Sub_Locality",
  building: "Tower_Name",
  title: "Property_Title",
  description: "Property_Description",
  size: "Property_Size",
  sizeUnit: "Property_Size_Unit",
  bedrooms: "Bedrooms",
  bathrooms: "Bathroom",
  price: "Price",
  rentFrequency: "Rent_Frequency",
  furnished: "Furnished",
  features: "Features",
  feature: "Feature",
  images: "Images",
  image: "Image",
  agent: "Listing_Agent",
  agentEmail: "Listing_Agent_Email",
  agentPhone: "Listing_Agent_Phone",
  agentBrn: "Listing_Agent_BRN",
  orn: "Agency_ORN",
  portals: "Portals",
  portal: "Portal",
  updated: "Last_Updated",
} as const;

const PURPOSE = { rent: "Rent", sale: "Buy" } as const;
const TYPE: Record<string, string> = {
  apartment: "Apartment",
  villa: "Villa",
  townhouse: "Townhouse",
  penthouse: "Penthouse",
  office: "Office",
  shop: "Shop",
  warehouse: "Warehouse",
  land: "Land",
  other: "Other",
};
const FURNISHED = { furnished: "Yes", semi_furnished: "Partly", unfurnished: "No" } as const;
const PORTAL_WORD = { bayut: "Bayut", dubizzle: "dubizzle" } as const;

/**
 * Characters XML 1.0 forbids anywhere, even escaped: C0 controls other than tab,
 * line feed and carriage return, U+FFFE/U+FFFF, and a surrogate half on its own.
 * They arrive with ordinary copy-paste (a PowerPoint soft return is U+000B) and
 * one of them makes the whole document unreadable — every listing, not just its
 * own (final review, 7 Nov 2026). Each becomes a space.
 */
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const xmlSafe = (s: string): string => s.replace(NOT_XML, " ");

/** Text inside an element or attribute: forbidden characters out, the five XML characters escaped. */
export function xmlText(s: string): string {
  return xmlSafe(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** A CDATA section that survives "]]>" inside the text (split across two sections). */
export function cdata(s: string): string {
  return `<![CDATA[${xmlSafe(s).split("]]>").join("]]]]><![CDATA[>")}]]>`;
}

const el = (tag: string, value: string) => `<${tag}>${xmlText(value)}</${tag}>`;
const num = (n: number) => String(Number(n));
/** 2026-11-06T09:30:00.000Z → "2026-11-06 09:30:00" (UTC). */
const stamp = (iso: string) => new Date(iso).toISOString().slice(0, 19).replace("T", " ");

function listingXml(l: PortalListing): string | null {
  const t = BAYUT_TAGS;
  const portals = l.portals.filter((p): p is "bayut" | "dubizzle" => p === "bayut" || p === "dubizzle");
  if (portals.length === 0) return null;
  const parts: string[] = [
    el(t.reference, l.reference),
    el(t.permit, l.permitNumber),
    el(t.purpose, PURPOSE[l.purpose]),
    el(t.type, TYPE[l.propertyType] ?? "Other"),
    el(t.status, "live"),
    el(t.city, l.city),
    el(t.community, l.community),
  ];
  if (l.subCommunity) parts.push(el(t.subCommunity, l.subCommunity));
  if (l.building) parts.push(el(t.building, l.building));
  parts.push(el(t.title, l.title), `<${t.description}>${cdata(l.description)}</${t.description}>`);
  parts.push(el(t.size, num(l.sizeSqft)), el(t.sizeUnit, "SQFT"));
  if (l.bedrooms !== null) parts.push(el(t.bedrooms, num(l.bedrooms)));
  if (l.bathrooms !== null) parts.push(el(t.bathrooms, num(l.bathrooms)));
  parts.push(el(t.price, num(l.priceAed)));
  if (l.purpose === "rent") parts.push(el(t.rentFrequency, "Yearly"));
  if (l.furnishing) parts.push(el(t.furnished, FURNISHED[l.furnishing]));
  parts.push(`<${t.features}>${l.amenities.map((a) => el(t.feature, AMENITY_WORDS[a as Amenity] ?? a)).join("")}</${t.features}>`);
  parts.push(`<${t.images}>${l.photoUrls.map((u) => el(t.image, u)).join("")}</${t.images}>`);
  parts.push(el(t.agent, l.agent.name));
  if (l.agent.email) parts.push(el(t.agentEmail, l.agent.email));
  if (l.agent.phone) parts.push(el(t.agentPhone, l.agent.phone));
  parts.push(el(t.agentBrn, l.agent.brn), el(t.orn, l.orn));
  parts.push(`<${t.portals}>${portals.map((p) => el(t.portal, PORTAL_WORD[p])).join("")}</${t.portals}>`);
  parts.push(el(t.updated, stamp(l.updatedAt)));
  return `<${t.listing}>\n${parts.map((p) => `  ${p}`).join("\n")}\n</${t.listing}>`;
}

/** The whole feed: every listing meant for Bayut and/or dubizzle (others are skipped). */
export function bayutFeedXml(listings: PortalListing[], generatedAt: string): string {
  const body = listings.map(listingXml).filter((x): x is string => x !== null);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${BAYUT_TAGS.root} generated="${xmlText(generatedAt)}">${body.length ? `\n${body.join("\n")}\n` : ""}</${BAYUT_TAGS.root}>\n`;
}
