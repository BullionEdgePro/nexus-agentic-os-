import type { BoardUnit, Purpose, PropertyType } from "../workflows/board.js";

/**
 * Ready for the portals (7 Nov 2026): one rule, used by the card's Portals
 * section and the server's refusal, so the card never offers a switch the
 * server would refuse. It also builds the portal-neutral listing each portal's
 * adapter turns into its own format (the Bayut/dubizzle feed today, Property
 * Finder's API in phase 2).
 * Spec: docs/superpowers/specs/2026-11-07-portal-listings-design.md §2, §4, §5
 */

/** The portals Nexus publishes to. Meta and TikTok stay manual ticks (board PORTALS). */
export const PORTAL_TARGETS = ["bayut", "dubizzle", "property_finder"] as const;
export type PortalTarget = (typeof PORTAL_TARGETS)[number];

/** Keys stored on the unit; each portal adapter maps them to its own codes. */
export const AMENITIES = [
  "balcony",
  "built_in_wardrobes",
  "central_ac",
  "covered_parking",
  "maids_room",
  "private_pool",
  "shared_pool",
  "private_garden",
  "shared_gym",
  "security",
  "concierge",
  "view_of_water",
  "view_of_landmark",
  "pets_allowed",
  "kitchen_appliances",
  "study",
  "childrens_play_area",
  "barbecue_area",
] as const;
export type Amenity = (typeof AMENITIES)[number];

export const AMENITY_WORDS: Record<Amenity, string> = {
  balcony: "Balcony",
  built_in_wardrobes: "Built-in wardrobes",
  central_ac: "Central A/C",
  covered_parking: "Covered parking",
  maids_room: "Maid's room",
  private_pool: "Private pool",
  shared_pool: "Shared pool",
  private_garden: "Private garden",
  shared_gym: "Shared gym",
  security: "Security",
  concierge: "Concierge",
  view_of_water: "View of water",
  view_of_landmark: "View of landmark",
  pets_allowed: "Pets allowed",
  kitchen_appliances: "Kitchen appliances",
  study: "Study",
  childrens_play_area: "Children's play area",
  barbecue_area: "Barbecue area",
};

export const FURNISHING = ["furnished", "semi_furnished", "unfurnished"] as const;
export type Furnishing = (typeof FURNISHING)[number];

export const MIN_PHOTOS = 3;
const NO_BEDROOMS: readonly (PropertyType | null)[] = ["office", "shop", "warehouse", "land"];
const HOMES: readonly (PropertyType | null)[] = ["apartment", "villa", "townhouse", "penthouse"];

/**
 * What the rule needs beside the card. `closed` is true for a card that was
 * let, sold or withdrawn (the board lists open cards only, so it defaults to
 * open); `agentBrn` is the card's agent's licence, null when there is none.
 */
export type ListingContext = { today: string; orn: string | null; agentBrn: string | null; photoCount: number; closed?: boolean };

const blank = (s: string | null | undefined) => s === null || s === undefined || s.trim() === "";

/** What the unit still needs before it can go on the portals, in staff's words and the spec's order. */
export function portalProblems(unit: BoardUnit, ctx: ListingContext): string[] {
  const need: string[] = [];
  if (ctx.closed) need.push("an open card");
  if (unit.step !== "S9" && unit.step !== "S10") need.push("the card on Listing & ads or Portals + social");
  const permitValid =
    !!unit.formASignedOn && !blank(unit.permitNumber) && !!unit.permitExpiresOn && unit.permitExpiresOn >= ctx.today;
  if (!permitValid) need.push("a permit that has not expired");
  if (unit.purpose === null) need.push("rent or sale");
  if (unit.priceAed === null) need.push("a price");
  if (unit.propertyType === null) need.push("the property type");
  if (unit.bedrooms === null && !NO_BEDROOMS.includes(unit.propertyType)) need.push("bedrooms");
  if (unit.bathrooms === null && (unit.propertyType === null || HOMES.includes(unit.propertyType))) need.push("bathrooms");
  if (unit.sizeSqft === null) need.push("the size");
  const title = unit.title?.trim() ?? "";
  if (title.length < 10 || title.length > 120) need.push("a title of 10 to 120 characters");
  if ((unit.description?.trim() ?? "").length < 50) need.push("a description of at least 50 characters");
  if (blank(unit.community)) need.push("the community");
  const missing = MIN_PHOTOS - ctx.photoCount;
  if (missing > 0) need.push(ctx.photoCount === 0 ? `${MIN_PHOTOS} photos` : missing === 1 ? "1 more photo" : `${missing} more photos`);
  if (unit.agent === null) need.push("an agent on the card");
  else if (blank(ctx.agentBrn)) need.push("the agent's BRN");
  if (blank(ctx.orn)) need.push("the agency's ORN");
  return need;
}

/** "Before it can go on the portals: a, b." — null when nothing is missing. */
export function portalProblemSentence(problems: string[]): string | null {
  return problems.length === 0 ? null : `Before it can go on the portals: ${problems.join(", ")}.`;
}

/** What every portal publishes about a unit: never the owner, notes or deals. */
export type PortalListing = {
  reference: string;
  updatedAt: string;
  purpose: Purpose;
  priceAed: number;
  propertyType: PropertyType;
  bedrooms: number | null;
  bathrooms: number | null;
  sizeSqft: number;
  furnishing: Furnishing | null;
  title: string;
  description: string;
  city: string;
  community: string;
  subCommunity: string | null;
  building: string | null;
  amenities: string[];
  parking: number | null;
  availableFrom: string | null;
  permitNumber: string;
  permitExpiresOn: string;
  photoUrls: string[];
  agent: { name: string; email: string | null; phone: string | null; brn: string };
  orn: string;
  portals: PortalTarget[];
};

/**
 * The listing of a READY unit (portalProblems empty): the caller checks that
 * first, so the required fields are present here.
 */
export function toPortalListing(
  unit: BoardUnit,
  extra: { orn: string; agent: PortalListing["agent"]; photoUrls: string[]; portals: PortalTarget[] }
): PortalListing {
  return {
    reference: unit.id,
    updatedAt: unit.updatedAt,
    purpose: unit.purpose as Purpose,
    priceAed: unit.priceAed as number,
    propertyType: unit.propertyType as PropertyType,
    bedrooms: unit.bedrooms,
    bathrooms: unit.bathrooms,
    sizeSqft: unit.sizeSqft as number,
    furnishing: unit.furnishing,
    title: (unit.title ?? "").trim(),
    description: (unit.description ?? "").trim(),
    city: unit.city,
    community: (unit.community ?? "").trim(),
    subCommunity: unit.subCommunity,
    building: unit.building,
    amenities: [...unit.amenities],
    parking: unit.parking,
    availableFrom: unit.availableFrom,
    permitNumber: (unit.permitNumber ?? "").trim(),
    permitExpiresOn: unit.permitExpiresOn as string,
    photoUrls: extra.photoUrls,
    agent: extra.agent,
    orn: extra.orn,
    portals: extra.portals,
  };
}
