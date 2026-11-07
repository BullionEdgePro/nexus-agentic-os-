import type { Lane, Workflow, WorkflowStep } from "./types.js";
import type { PfConnection, PfState } from "../portals/pf-sync.js";

/**
 * The workflow board's rules (3 Nov 2026): SFS staff move units through the
 * supply steps and deals through the demand steps. Written once, here, so the
 * board's drag asks the same question the API's refusal answers — the board
 * never offers a move the server would refuse.
 * Spec: docs/superpowers/specs/2026-11-03-sfs-workflow-board-design.md §3, §6
 */

/** The supply steps a unit sits on; S1–S4 stay automatic. */
export const UNIT_STEPS = ["S5", "S6", "S7", "S8", "S9", "S10"] as const;
/** The demand steps a deal sits on; D1–D2 stay automatic and D10 is an output. */
export const DEAL_STEPS = ["D3", "D4", "D5", "D6", "D7", "D8", "D9"] as const;

export type UnitStep = (typeof UNIT_STEPS)[number];
export type DealStep = (typeof DEAL_STEPS)[number];
export type Purpose = "rent" | "sale";
export const PORTALS = ["bayut", "dubizzle", "property_finder", "meta", "tiktok"] as const;
export type Portal = (typeof PORTALS)[number];
export const PROPERTY_TYPES = ["apartment", "villa", "townhouse", "penthouse", "office", "shop", "warehouse", "land", "other"] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];
export type UnitClose = "let" | "sold" | "withdrawn";
export type DealClose = "won" | "lost";

type Person = { id: string; name: string };

/** Dates are YYYY-MM-DD; inStepSince is an ISO time. */
export type BoardUnit = {
  kind: "unit";
  id: string;
  step: UnitStep;
  inStepSince: string;
  reference: string;
  community: string | null;
  propertyType: PropertyType | null;
  bedrooms: number | null;
  purpose: Purpose | null;
  priceAed: number | null;
  cheques: number | null;
  ejariReady: boolean;
  titleDeed: boolean;
  ownerDocs: boolean;
  formASignedOn: string | null;
  permitNumber: string | null;
  permitExpiresOn: string | null;
  liveOn: Portal[];
  /** name is null when the viewer may not see that customer (spec §3). */
  owner: { contactId: string; name: string | null } | null;
  agent: Person | null;
  notes: string | null;
  dealIds: string[];
  /** When the card last changed: the portals' "last updated". */
  updatedAt: string;
  // The listing (spec 2026-11-07-portal-listings-design.md §2).
  title: string | null;
  description: string | null;
  sizeSqft: number | null;
  bathrooms: number | null;
  furnishing: "furnished" | "semi_furnished" | "unfurnished" | null;
  city: string;
  subCommunity: string | null;
  building: string | null;
  parking: number | null;
  amenities: string[];
  availableFrom: string | null;
  /** In order; the first is the cover. No bytes on the board. */
  photos: { id: string; width: number; height: number }[];
  /**
   * The publish switches; what is actually published is wanted AND ready. With
   * each, the portal's last answer — only Property Finder answers so far (its
   * sync, 7 Nov 2026); for the others they stay null.
   */
  portals: Record<
    "bayut" | "dubizzle" | "property_finder",
    { wanted: boolean; state: PfState | null; message: string | null; syncedAt: string | null }
  >;
};

export type BoardDeal = {
  kind: "deal";
  id: string;
  step: DealStep;
  inStepSince: string;
  contact: { id: string; name: string | null };
  purpose: Purpose;
  budgetAed: number | null;
  offerAed: number | null;
  ejariNumber: string | null;
  kycDone: boolean;
  formFSignedOn: string | null;
  dldTransferOn: string | null;
  dealValueAed: number | null;
  commissionAed: number | null;
  agent: Person | null;
  notes: string | null;
  unitIds: string[];
  nextViewingAt: string | null;
};

export type BoardCard = BoardUnit | BoardDeal;

export type Board = {
  units: BoardUnit[];
  deals: BoardDeal[];
  /** Deals on each step the viewer may not see: counted, never named. */
  hidden: Partial<Record<DealStep, number>>;
  hotWaiting: { contactId: string; name: string | null; priority: "high" | "urgent"; scoredAt: string }[];
  closed30: { let: number; sold: number; won: number; commissionAed: number };
  /** The business's own date, from the server — never the browser's clock. */
  today: string;
  /** The Bayut/dubizzle feed: null until an admin makes its address. */
  portalFeed: { lastReadAt: string | null } | null;
  /** Whether the business's ORN is on file. */
  ornSet: boolean;
  /** Employee id → whether that agent has a BRN on file. */
  agentBrns: Record<string, boolean>;
  /** Agents on open units who have left the staff: their units stay off the portals. */
  agentsGone: string[];
  /** Where the business stands with Property Finder (its sync, 7 Nov 2026). */
  pfConnection: PfConnection;
};

export type CardMove = {
  kind: "created" | "moved" | "closed";
  from: string | null;
  to: string | null;
  closedReason: string | null;
  by: string | null;
  at: string;
};

const LANE_STEPS: Record<Lane, readonly string[]> = { supply: UNIT_STEPS, demand: DEAL_STEPS };

/** The steps of a lane that take cards, in the boss's order. */
export function boardColumns(workflow: Workflow, lane: Lane): WorkflowStep[] {
  return workflow.steps.filter((s) => s.lane === lane && LANE_STEPS[lane].includes(s.id));
}

/** The steps of a lane Nexus runs by itself: shown as counts, never dropped on. */
export function automaticSteps(workflow: Workflow, lane: Lane): WorkflowStep[] {
  const automatic = lane === "supply" ? ["S1", "S2", "S3", "S4"] : ["D1", "D2"];
  return workflow.steps.filter((s) => automatic.includes(s.id));
}

/** Where the drawing's arrows lead from a step: the Move to… menu lists these first. */
export function nextSteps(workflow: Workflow, stepId: string): string[] {
  return workflow.steps.find((s) => s.id === stepId)?.next.map((n) => n.to) ?? [];
}

/** Classifying is the drop: Rent units makes a rental, Sale units a sale. */
export function purposeAfterMove(unit: BoardUnit, to: string): Purpose | null {
  if (to === "S6") return "rent";
  if (to === "S7") return "sale";
  return unit.purpose;
}

/** 2026-11-02 → "2 Nov 2026". */
function longDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

const blank = (s: string | null) => s === null || s.trim() === "";

/** Why a card may not move to a step, in the words shown to staff; null when it may. */
export function moveProblem(card: BoardCard, to: string, today: string): string | null {
  const lane = card.kind === "unit" ? UNIT_STEPS : DEAL_STEPS;
  if (!(lane as readonly string[]).includes(to)) return "That step is not on this card's lane.";
  if (to === card.step) return "It is already on this step.";

  if (card.kind === "deal") {
    if (to === "D7" && card.purpose !== "rent") return "Rent deal is for tenancies. This lead is buying.";
    if (to === "D8" && card.purpose !== "sale") return "Sale deal is for purchases. This lead is renting.";
    return null;
  }

  const purpose = purposeAfterMove(card, to);
  if (purpose === null && to !== "S5") return "Classify it first: put it on Rent units or Sale units.";
  if (to === "S9" || to === "S10") {
    const missing: string[] = [];
    if (!card.formASignedOn) missing.push("Form A signed date");
    if (blank(card.permitNumber)) missing.push("Trakheesi permit number");
    if (!card.permitExpiresOn) missing.push("permit expiry date");
    else if (card.permitExpiresOn < today) missing.push(`a permit that has not expired (it expired on ${longDate(card.permitExpiresOn)})`);
    if (missing.length > 0) return `Before it can be advertised: ${missing.join(", ")}.`;
  }
  return null;
}

/** Why a card may not close this way; null when it may. */
export function closeProblem(card: BoardCard, reason: string): string | null {
  if (card.kind === "unit") {
    if (reason === "withdrawn") return null;
    if (reason === "let") return card.purpose === "rent" ? null : "Only a unit to let can close as Let.";
    if (reason === "sold") return card.purpose === "sale" ? null : "Only a unit for sale can close as Sold.";
    return "That is not a way to close this card.";
  }
  if (reason === "lost") return null;
  if (reason === "won") {
    return ["D7", "D8", "D9"].includes(card.step) ? null : "A deal closes as Won from Rent deal, Sale deal or CRM & commission.";
  }
  return "That is not a way to close this card.";
}

const need = (label: string, done: boolean) => ({ label, done });
const has = (v: number | null) => v !== null;

/**
 * The checklist for the card's current step (spec §6). `published` is whether a
 * unit is wanted on a portal AND ready (portal listings spec §5) — the caller
 * knows the business's ORN and BRNs, this rule does not.
 */
export function stepNeeds(card: BoardCard, published = false): { label: string; done: boolean }[] {
  if (card.kind === "unit") {
    const permit = [
      need("Form A signed", !!card.formASignedOn),
      need("Trakheesi permit number", !blank(card.permitNumber)),
      need("Permit expiry", !!card.permitExpiresOn),
    ];
    switch (card.step) {
      case "S5":
        return [
          need("Reference", !blank(card.reference)),
          need("Property type", card.propertyType !== null),
          need("Bedrooms", has(card.bedrooms)),
          need("Price", has(card.priceAed)),
        ];
      case "S6":
        return [need("Cheques", has(card.cheques)), need("Ejari-ready", card.ejariReady)];
      case "S7":
        return [need("Title deed", card.titleDeed), need("Owner documents", card.ownerDocs)];
      case "S8":
      case "S9":
        return permit;
      case "S10":
        return [need("Live on at least one portal", card.liveOn.length > 0 || published)];
    }
  }
  switch (card.step) {
    case "D4":
      return [need("At least one unit matched", card.unitIds.length > 0)];
    case "D5":
      return [need("A viewing booked", card.nextViewingAt !== null)];
    case "D6":
      return [need("Offer amount", has(card.offerAed))];
    case "D7":
      return [need("Ejari number", !blank(card.ejariNumber))];
    case "D8":
      return [need("KYC/AML done", card.kycDone), need("Form F signed", !!card.formFSignedOn), need("DLD transfer", !!card.dldTransferOn)];
    case "D9":
      return [need("Deal value", has(card.dealValueAed)), need("Commission", has(card.commissionAed))];
    default:
      return [];
  }
}

const DAY_MS = 86_400_000;

/** A permit's state today: expiring means 14 days or fewer are left. */
export function permitState(unit: BoardUnit, today: string): "ok" | "expiring" | "expired" | "none" {
  if (!unit.permitExpiresOn) return "none";
  if (unit.permitExpiresOn < today) return "expired";
  const left = (Date.parse(`${unit.permitExpiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS;
  return left <= 14 ? "expiring" : "ok";
}

/** Whole days since the card entered its step: "today", "1 day", "N days". */
export function daysInStepLabel(inStepSince: string, now: number): string {
  const days = Math.floor(Math.max(0, now - Date.parse(inStepSince)) / DAY_MS);
  return days === 0 ? "today" : days === 1 ? "1 day" : `${days} days`;
}
