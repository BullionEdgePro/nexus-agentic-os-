import { daysInStepLabel, permitState, stepNeeds, type BoardCard, type BoardUnit } from "@nexus/shared";
import type { CardHandlers } from "../../../kit/board";

/**
 * One card on the workflow board (3 Nov 2026): a unit or a deal, with what a
 * person scanning the board needs — rent or sale and the money, whose it is and
 * how long it has sat, the permit when it matters, and a dot when the step's
 * checklist is not complete. It wears the kit's card and takes the kit's drag
 * handlers, so it drags exactly like every other board in Nexus.
 * Spec: docs/superpowers/specs/2026-11-03-sfs-workflow-board-design.md §2
 */

const DAY_MS = 86_400_000;

/** AED 1,200,000 */
export const aed = (n: number) => `AED ${Math.round(n).toLocaleString("en-GB")}`;

/** "Aisha Khan" → "AK". */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export const cardTitle = (card: BoardCard) => (card.kind === "unit" ? card.reference : card.contact.name ?? "A customer");

/** The card's short lines, in the order they are read. */
export function cardLines(card: BoardCard, now: number, timezone: string): string[] {
  const who = `${card.agent ? initials(card.agent.name) : "Nobody yet"} · ${daysInStepLabel(card.inStepSince, now)}`;
  if (card.kind === "unit") {
    const price = card.priceAed !== null ? ` · ${aed(card.priceAed)}` : "";
    const purpose = card.purpose === "rent" ? `To let${price}` : card.purpose === "sale" ? `For sale${price}` : "Not classified yet";
    return [purpose, who];
  }
  const budget = card.budgetAed !== null ? ` · budget ${aed(card.budgetAed)}` : "";
  const lines = [`${card.purpose === "rent" ? "Renting" : "Buying"}${budget}`];
  if (card.nextViewingAt) {
    const when = new Date(card.nextViewingAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: timezone });
    lines.push(`Viewing ${when}`);
  }
  lines.push(who);
  return lines;
}

/** The permit badge a unit wears today, if any: red when an advertised unit's permit lapsed. */
export function permitBadge(unit: BoardUnit, today: string): { text: string; tone: "expired" | "expiring" } | null {
  const state = permitState(unit, today);
  if (state === "expired") return unit.step === "S9" || unit.step === "S10" ? { text: "Permit expired", tone: "expired" } : null;
  if (state === "expiring") {
    const days = Math.round((Date.parse(`${unit.permitExpiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
    return { text: days === 0 ? "Permit expires today" : `Permit expires in ${days} ${days === 1 ? "day" : "days"}`, tone: "expiring" };
  }
  return null;
}

/** Something this step needs is missing; `published` is a unit wanted on a portal AND ready (portal listings spec §5). */
export const isMissing = (card: BoardCard, published = false) => stepNeeds(card, published).some((n) => !n.done);

export function WorkflowCard({
  card,
  today,
  now,
  timezone,
  onOpen,
  handlers,
  dragging = false,
  published = false,
}: {
  card: BoardCard;
  today: string;
  now: number;
  timezone: string;
  onOpen: (el: HTMLElement) => void;
  handlers?: CardHandlers;
  dragging?: boolean;
  /** A unit wanted on a portal and ready: Portals + social is then done. */
  published?: boolean;
}) {
  const title = cardTitle(card);
  const lines = cardLines(card, now, timezone);
  const badge = card.kind === "unit" ? permitBadge(card, today) : null;
  const missing = isMissing(card, published);
  const label = [
    `${title}.`,
    `${lines.join(", ")}.`,
    badge ? `${badge.text}.` : "",
    missing ? "Something this step needs is missing." : "",
    "Open the card.",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={`kit-card tone-paper kit-board-card wf-board-card${handlers ? " can-drag" : ""}${dragging ? " kit-placeholder" : ""}`}
      aria-label={label}
      data-card={card.id}
      onClick={(event) => onOpen(event.currentTarget)}
      {...handlers}
    >
      <span className="kit-card-title" dir="auto">
        {title}
        {missing ? <span className="wf-board-missing" aria-hidden="true" /> : null}
      </span>
      {lines.map((line, i) => (
        <span key={i} className="kit-card-sub" dir="auto">
          {line}
        </span>
      ))}
      {badge ? (
        <span className={`wf-board-badge wf-board-${badge.tone}`} title={badge.tone === "expired" ? "Take the ads down" : undefined}>
          {badge.text}
        </span>
      ) : null}
    </button>
  );
}
