import type { BoardUnit, PropertyType } from "../workflows/board.js";
import { AMENITIES, type Amenity, type PortalListing } from "./listing.js";

/**
 * A unit on Bayut's Profolio API (23 Nov 2026): the JSON body Bayut takes, and
 * what Bayut needs before a unit can be sent (its location id, its category,
 * the agent's Bayut user). Optional fields are LEFT OUT, never null or empty:
 * Bayut rejects the request otherwise.
 * Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §7, §8
 */

/** Bayut and dubizzle share one connection and one listing. */
export const BAYUT_PORTALS = ["bayut", "dubizzle"] as const;
export type BayutPortal = (typeof BAYUT_PORTALS)[number];

/** Bayut's category slug per Nexus property type; null when Bayut has none. */
export const BAYUT_CATEGORY: Record<PropertyType, string | null> = {
  apartment: "apartments",
  villa: "villas",
  townhouse: "townhouses",
  penthouse: "penthouse",
  office: "offices",
  shop: "shops",
  warehouse: "warehouses",
  land: "residential-plots",
  other: null,
};

/** The Bayut amenity titles to match for each Nexus key (compared without case or punctuation). */
export const BAYUT_AMENITY_TITLES: Record<Amenity, string[]> = {
  balcony: ["Balcony or Terrace", "Balcony"],
  built_in_wardrobes: ["Built in Wardrobes", "Built-in Wardrobes"],
  central_ac: ["Central A/C", "Central AC", "Central Air Conditioning"],
  covered_parking: ["Covered Parking"],
  maids_room: ["Maids Room", "Maid's Room"],
  private_pool: ["Private Pool"],
  shared_pool: ["Shared Pool"],
  private_garden: ["Private Garden"],
  shared_gym: ["Shared Gym", "Gym"],
  security: ["Security"],
  concierge: ["Concierge Service", "Concierge"],
  view_of_water: ["View of Water"],
  view_of_landmark: ["View of Landmark"],
  pets_allowed: ["Pets Allowed"],
  kitchen_appliances: ["Kitchen Appliances"],
  study: ["Study Room", "Study"],
  childrens_play_area: ["Children's Play Area", "Kids Play Area"],
  barbecue_area: ["Barbeque Area", "Barbecue Area"],
};

const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Which of Bayut's amenity ids stand for our keys, by title; keys Bayut has no title for are left out. */
export function matchAmenities(bayut: { id: string | number; title: { en: string } }[]): Partial<Record<Amenity, string>> {
  const byTitle = new Map<string, string>();
  for (const a of bayut) {
    const key = plain(a.title.en);
    if (!byTitle.has(key)) byTitle.set(key, String(a.id));
  }
  const out: Partial<Record<Amenity, string>> = {};
  for (const key of AMENITIES) {
    for (const title of BAYUT_AMENITY_TITLES[key]) {
      const id = byTitle.get(plain(title));
      if (id !== undefined) {
        out[key] = id;
        break;
      }
    }
  }
  return out;
}

/** What Nexus knows about Bayut beside the unit: a saved token, the unit's Bayut location, its agent's Bayut user. */
export type BayutContext = { tokenSaved: boolean; locationId: number | null; userId: number | null };

/** What the unit still needs for Bayut (after the portals' own rule), in order. */
export function bayutProblems(unit: BoardUnit, ctx: BayutContext): string[] {
  const need: string[] = [];
  if ((unit.title?.trim() ?? "").length > 100) need.push("a title of at most 100 characters");
  if (unit.propertyType === null || BAYUT_CATEGORY[unit.propertyType] === null) need.push("a property type Bayut takes");
  if (ctx.locationId === null) need.push("the Bayut location");
  if (ctx.tokenSaved && ctx.userId === null) need.push("the agent linked to a Bayut user");
  return need;
}

export type BayutListingBody = {
  reference: string;
  user_id: number;
  title: { en: string };
  description: { en: string };
  purpose: "rent" | "sale";
  category: string;
  location_id: number;
  price: number;
  rental_details?: { rent_frequency: "yearly" };
  area: number;
  bedrooms?: number;
  bathrooms?: number;
  furnishing_status?: "furnished" | "unfurnished";
  construction_status: "completed";
  permit_number: string;
  amenities?: { id: string; value: "true" }[];
  images: { path: string; is_main: boolean }[];
};

/** The Bayut body of a READY listing (portalProblems and bayutProblems empty). */
export function toBayutListing(
  listing: PortalListing,
  ctx: { userId: number; locationId: number; amenityIds: Partial<Record<Amenity, string>> }
): BayutListingBody {
  const amenities = listing.amenities.flatMap((key) => {
    const id = ctx.amenityIds[key as Amenity];
    return id === undefined ? [] : [{ id, value: "true" as const }];
  });
  return {
    reference: listing.reference,
    user_id: ctx.userId,
    title: { en: listing.title },
    description: { en: listing.description },
    purpose: listing.purpose,
    category: BAYUT_CATEGORY[listing.propertyType] as string,
    location_id: ctx.locationId,
    price: listing.priceAed,
    ...(listing.purpose === "rent" ? { rental_details: { rent_frequency: "yearly" as const } } : {}),
    area: listing.sizeSqft,
    ...(listing.bedrooms === null ? {} : { bedrooms: listing.bedrooms === 0 ? -1 : listing.bedrooms }),
    ...(listing.bathrooms === null ? {} : { bathrooms: listing.bathrooms }),
    ...(listing.furnishing === "furnished" || listing.furnishing === "unfurnished" ? { furnishing_status: listing.furnishing } : {}),
    construction_status: "completed",
    permit_number: listing.permitNumber,
    ...(amenities.length > 0 ? { amenities } : {}),
    images: listing.photoUrls.map((path, i) => ({ path, is_main: i === 0 })),
  };
}
