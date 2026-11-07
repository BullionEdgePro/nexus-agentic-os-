"use client";

import { useId, useState } from "react";
import {
  AMENITIES,
  AMENITY_WORDS,
  closeProblem,
  daysInStepLabel,
  PORTALS,
  PROPERTY_TYPES,
  stepNeeds,
  type Board,
  type BoardCard,
  type CardMove,
  type Portal,
  type PortalTarget,
  type Workflow,
} from "@nexus/shared";
import type { DealInput, UnitInput } from "@/lib/api";
import { CardWindow } from "../../../kit/card-window";
import { MoveMenu } from "./move-menu";
import { aed, cardTitle } from "./board-card";
import { MONEY_HELP, toAed } from "./add-card";
import { PhotosSection } from "./photos-section";
import { PortalsSection } from "./portals-section";

/**
 * A card's window on the workflow board (3 Nov 2026): what its step needs, its
 * fields to fill in, the units offered to a deal (or the deals a unit was
 * offered to), Move to…, its history in words, and Close.
 *
 * Saving sends only what changed. Closing names the ways this card may close;
 * the others are shown, disabled, with the reason.
 * Spec: docs/superpowers/specs/2026-11-03-sfs-workflow-board-design.md §2, §3, §6
 */

const PORTAL_NAME: Record<Portal, string> = {
  bayut: "Bayut",
  dubizzle: "Dubizzle",
  property_finder: "Property Finder",
  meta: "Meta",
  tiktok: "TikTok",
};

const CLOSES: Record<BoardCard["kind"], [string, string][]> = {
  unit: [
    ["let", "Let"],
    ["sold", "Sold"],
    ["withdrawn", "Withdrawn"],
  ],
  deal: [
    ["won", "Won"],
    ["lost", "Lost"],
  ],
};

type FieldType = "text" | "money" | "count" | "date" | "flag" | "type" | "area" | "longtext" | "furnishing";

const FURNISHING_WORDS: [string, string][] = [
  ["furnished", "Furnished"],
  ["semi_furnished", "Semi-furnished"],
  ["unfurnished", "Unfurnished"],
];
const AREA_HELP = "a number of square feet, like 812 or 812.5.";
type Field = { key: string; label: string; type: FieldType; group: string };

const UNIT_FIELDS: Field[] = [
  { key: "reference", label: "Reference", type: "text", group: "The unit" },
  { key: "community", label: "Community", type: "text", group: "The unit" },
  { key: "propertyType", label: "Type", type: "type", group: "The unit" },
  { key: "bedrooms", label: "Bedrooms (0 for a studio)", type: "count", group: "The unit" },
  { key: "priceAed", label: "Yearly rent or asking price, AED", type: "money", group: "The unit" },
  { key: "cheques", label: "Cheques", type: "count", group: "The unit" },
  { key: "ejariReady", label: "Ejari-ready", type: "flag", group: "Papers" },
  { key: "titleDeed", label: "Title deed received", type: "flag", group: "Papers" },
  { key: "ownerDocs", label: "Owner documents received", type: "flag", group: "Papers" },
  { key: "formASignedOn", label: "Form A signed on", type: "date", group: "Papers" },
  { key: "permitNumber", label: "Trakheesi permit number", type: "text", group: "Papers" },
  { key: "permitExpiresOn", label: "Permit expires on", type: "date", group: "Papers" },
  // The listing the portals publish (portal listings, 7 Nov 2026).
  { key: "title", label: "Title", type: "text", group: "Listing" },
  { key: "description", label: "Description", type: "longtext", group: "Listing" },
  { key: "sizeSqft", label: "Size, sq ft", type: "area", group: "Listing" },
  { key: "bathrooms", label: "Bathrooms", type: "count", group: "Listing" },
  { key: "furnishing", label: "Furnishing", type: "furnishing", group: "Listing" },
  { key: "city", label: "City", type: "text", group: "Listing" },
  { key: "subCommunity", label: "Sub-community", type: "text", group: "Listing" },
  { key: "building", label: "Building", type: "text", group: "Listing" },
  { key: "parking", label: "Parking spaces", type: "count", group: "Listing" },
  { key: "availableFrom", label: "Available from", type: "date", group: "Listing" },
];

const DEAL_FIELDS: Field[] = [
  { key: "budgetAed", label: "Budget, AED", type: "money", group: "Money" },
  { key: "offerAed", label: "Offer, AED", type: "money", group: "Money" },
  { key: "dealValueAed", label: "Deal value, AED", type: "money", group: "Money" },
  { key: "commissionAed", label: "Commission, AED", type: "money", group: "Money" },
  { key: "ejariNumber", label: "Ejari number", type: "text", group: "Papers" },
  { key: "kycDone", label: "KYC/AML done", type: "flag", group: "Papers" },
  { key: "formFSignedOn", label: "Form F signed on", type: "date", group: "Papers" },
  { key: "dldTransferOn", label: "DLD transfer on", type: "date", group: "Papers" },
];

export type Draft = Record<string, string | boolean>;

const fieldsFor = (card: BoardCard) => (card.kind === "unit" ? UNIT_FIELDS : DEAL_FIELDS);

/** The window's editable values, as the inputs hold them. */
export function draftOf(card: BoardCard): Draft {
  const values = card as unknown as Record<string, unknown>;
  const draft: Draft = { notes: card.notes ?? "" };
  for (const f of fieldsFor(card)) {
    const v = values[f.key];
    draft[f.key] = f.type === "flag" ? Boolean(v) : v === null || v === undefined ? "" : String(v);
  }
  return draft;
}

/**
 * What a save sends: only the fields this person touched, and of those only
 * the ones that differ from the card as it stands now — or the reason it
 * cannot be saved. A field nobody touched here is never sent, so a colleague's
 * change made while this window was open is not put back (final review).
 */
export function unsavedChanges(
  card: BoardCard,
  draft: Draft,
  liveOn: Portal[],
  touched: Set<string>,
  amenities?: string[]
): { changes: Record<string, unknown> } | { problem: string } {
  const values = card as unknown as Record<string, unknown>;
  const changes: Record<string, unknown> = {};
  for (const f of fieldsFor(card)) {
    if (!touched.has(f.key)) continue;
    const raw = draft[f.key];
    let next: unknown;
    if (f.type === "flag") next = raw;
    else if (f.type === "money") {
      next = toAed(String(raw));
      if (Number.isNaN(next)) return { problem: `${f.label}: ${MONEY_HELP}` };
    } else if (f.type === "count") {
      const text = String(raw).trim();
      next = text === "" ? null : Number(text);
      if (next !== null && !Number.isInteger(next)) return { problem: `${f.label}: a whole number, please.` };
    } else if (f.type === "area") {
      const text = String(raw).trim();
      if (text !== "" && !/^\d+(\.\d{1,2})?$/.test(text)) return { problem: `${f.label}: ${AREA_HELP}` };
      next = text === "" ? null : Number(text);
    } else if (f.key === "reference") next = String(raw).trim();
    else next = String(raw).trim() === "" ? null : String(raw).trim();
    if (next !== values[f.key]) changes[f.key] = next;
  }
  const notes = String(draft.notes).trim() === "" ? null : String(draft.notes).trim();
  if (touched.has("notes") && notes !== card.notes) changes.notes = notes;
  if (card.kind === "unit" && touched.has("liveOn") && JSON.stringify([...liveOn].sort()) !== JSON.stringify([...card.liveOn].sort())) {
    changes.liveOn = liveOn;
  }
  if (card.kind === "unit" && amenities && touched.has("amenities") && JSON.stringify([...amenities].sort()) !== JSON.stringify([...card.amenities].sort())) {
    changes.amenities = amenities;
  }
  return { changes };
}

function historyLine(move: CardMove, stepName: (id: string | null) => string, timezone: string): string {
  const by = move.by ?? "someone no longer here";
  const when = new Date(move.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: timezone });
  const what =
    move.kind === "created"
      ? `Created on ${stepName(move.to)}`
      : move.kind === "moved"
        ? `Moved to ${stepName(move.to)}`
        : `Closed as ${CLOSES.unit.concat(CLOSES.deal).find(([r]) => r === move.closedReason)?.[1] ?? move.closedReason}`;
  return `${what} by ${by} · ${when}`;
}

export function CardDetail({
  workflow,
  card,
  board,
  history,
  now,
  timezone,
  origin,
  message,
  onSave,
  onMove,
  onCloseCard,
  onLink,
  onUnlink,
  onDismiss,
  canEdit = true,
  photoSrc = () => "",
  onAddPhotos = () => {},
  onMovePhoto = () => {},
  onRemovePhoto = () => {},
  onSwitchPortal = () => {},
}: {
  workflow: Workflow;
  card: BoardCard;
  board: Board;
  history: CardMove[] | null;
  now: number;
  timezone: string;
  origin: HTMLElement | null;
  message: string;
  /** Resolves true once the save went through. */
  onSave: (changes: UnitInput | DealInput) => Promise<boolean>;
  onMove: (to: string) => void;
  onCloseCard: (reason: string, note: string | null) => void;
  onLink: (unitId: string) => void;
  onUnlink: (unitId: string) => void;
  onDismiss: () => void;
  /** False for "View as staff": photos and switches are shown, not changeable. */
  canEdit?: boolean;
  /** Where an <img> loads one of the unit's photos. */
  photoSrc?: (photoId: string) => string;
  onAddPhotos?: (files: File[]) => void;
  onMovePhoto?: (photoId: string, by: -1 | 1) => void;
  onRemovePhoto?: (photoId: string) => void;
  onSwitchPortal?: (portal: PortalTarget, wanted: boolean) => void;
}) {
  const fields = fieldsFor(card);
  const [draft, setDraft] = useState<Draft>(() => draftOf(card));
  const [liveOn, setLiveOn] = useState<Portal[]>(card.kind === "unit" ? card.liveOn : []);
  const [amenities, setAmenities] = useState<string[]>(card.kind === "unit" ? card.amenities : []);
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const touch = (key: string) => setTouched((t) => (t.has(key) ? t : new Set(t).add(key)));
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const base = useId();
  const stepName = (id: string | null) => (id ? workflow.steps.find((s) => s.id === id)?.name ?? id : "");
  const title = cardTitle(card);
  const needs = stepNeeds(card);
  const groups = [...new Set(fields.map((f) => f.group))];

  async function save() {
    const result = unsavedChanges(card, draft, liveOn, touched, amenities);
    if ("problem" in result) {
      setProblem(result.problem);
      return;
    }
    if (Object.keys(result.changes).length === 0) {
      setProblem("Nothing has changed.");
      return;
    }
    setProblem("");
    setBusy(true);
    try {
      if (await onSave(result.changes as UnitInput | DealInput)) setTouched(new Set());
    } finally {
      setBusy(false);
    }
  }

  const input = (f: Field) => {
    const id = `${base}-${f.key}`;
    const value = draft[f.key];
    const set = (v: string | boolean) => {
      touch(f.key);
      setDraft((d) => ({ ...d, [f.key]: v }));
    };
    if (f.type === "flag") {
      return (
        <label key={f.key} className="wf-board-flag">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => set(e.target.checked)} /> {f.label}
        </label>
      );
    }
    if (f.type === "longtext") {
      return (
        <div key={f.key} className="wf-board-field wf-board-field-wide">
          <label htmlFor={id}>{f.label}</label>
          <textarea id={id} aria-label={f.label} rows={5} dir="auto" value={String(value)} onChange={(e) => set(e.target.value)} />
        </div>
      );
    }
    if (f.type === "furnishing") {
      return (
        <div key={f.key} className="wf-board-field">
          <label htmlFor={id}>{f.label}</label>
          <select id={id} value={String(value)} onChange={(e) => set(e.target.value)}>
            <option value="">Not set</option>
            {FURNISHING_WORDS.map(([v, words]) => (
              <option key={v} value={v}>
                {words}
              </option>
            ))}
          </select>
        </div>
      );
    }
    return (
      <div key={f.key} className="wf-board-field">
        <label htmlFor={id}>{f.label}</label>
        {f.type === "type" ? (
          <select id={id} value={String(value)} onChange={(e) => set(e.target.value)}>
            <option value="">Not set</option>
            {PROPERTY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t[0]!.toUpperCase() + t.slice(1)}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={id}
            type={f.type === "date" ? "date" : "text"}
            inputMode={f.type === "money" || f.type === "area" ? "decimal" : f.type === "count" ? "numeric" : undefined}
            value={String(value)}
            onChange={(e) => set(e.target.value)}
          />
        )}
      </div>
    );
  };

  const offered = card.kind === "deal" ? board.units.filter((u) => card.unitIds.includes(u.id)) : [];
  const offerable = card.kind === "deal" ? board.units.filter((u) => !card.unitIds.includes(u.id)) : [];
  const offeredTo = card.kind === "unit" ? board.deals.filter((d) => card.dealIds.includes(d.id)) : [];

  return (
    <CardWindow open title={title} onClose={onDismiss} origin={origin}>
      <div className="wf-window wf-board-detail">
        <p className="wf-window-tag">{card.kind === "unit" ? "Unit" : "Deal"}</p>
        <h2 dir="auto">{title}</h2>
        <p className="wf-window-sub">
          {stepName(card.step)} · {daysInStepLabel(card.inStepSince, now)} · {card.agent ? card.agent.name : "Nobody yet"}
        </p>
        {card.kind === "unit" ? (
          <p className="wf-window-sub" dir="auto">
            {card.owner === null ? "Owner: not recorded" : card.owner.name ? `Owner: ${card.owner.name}` : `Owner: with ${card.agent?.name ?? "a colleague"}`}
          </p>
        ) : (
          <p className="wf-window-sub" dir="auto">
            {card.purpose === "rent" ? "Renting" : "Buying"}
            {card.nextViewingAt
              ? ` · next viewing ${new Date(card.nextViewingAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: timezone })}`
              : ""}
          </p>
        )}

        {message || problem ? (
          <p className="wf-board-status" role="status">
            {problem || message}
          </p>
        ) : null}

        {needs.length > 0 ? (
          <section className="wf-window-part">
            <h3>What this step needs</h3>
            <ul className="wf-board-needs">
              {needs.map((n) => (
                <li key={n.label} className={`wf-board-need wf-board-need-${n.done ? "done" : "missing"}`}>
                  {n.label}
                  <span className="wf-board-need-state">{n.done ? " — done" : " — missing"}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="wf-window-part">
          <MoveMenu workflow={workflow} card={card} today={board.today} onMove={onMove} />
        </section>

        {card.kind === "deal" ? (
          <section className="wf-window-part">
            <h3>Units offered</h3>
            {offered.length > 0 ? (
              <ul className="wf-board-links">
                {offered.map((u) => (
                  <li key={u.id}>
                    <span dir="auto">{u.reference}</span>
                    <button type="button" className="kit-pill quiet" onClick={() => onUnlink(u.id)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="wf-board-empty">None yet.</p>
            )}
            {offerable.length > 0 ? (
              <select aria-label="Offer a unit" value="" onChange={(e) => e.target.value && onLink(e.target.value)}>
                <option value="">Offer a unit…</option>
                {offerable.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.reference}
                  </option>
                ))}
              </select>
            ) : null}
          </section>
        ) : offeredTo.length > 0 ? (
          <section className="wf-window-part">
            <h3>Offered to</h3>
            <ul className="wf-board-links">
              {offeredTo.map((d) => (
                <li key={d.id} dir="auto">
                  {d.contact.name ?? "A customer"}
                  {d.budgetAed !== null ? ` · budget ${aed(d.budgetAed)}` : ""}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {groups.map((group) => (
          <section key={group} className="wf-window-part wf-board-fields">
            <h3>{group}</h3>
            {fields.filter((f) => f.group === group).map(input)}
            {group === "Listing" ? (
              <fieldset className="wf-board-amenities">
                <legend>Amenities</legend>
                {AMENITIES.map((a) => (
                  <label key={a} className="wf-board-flag">
                    <input
                      type="checkbox"
                      checked={amenities.includes(a)}
                      onChange={(e) => {
                        touch("amenities");
                        setAmenities((now) => (e.target.checked ? [...now, a] : now.filter((x) => x !== a)));
                      }}
                    />{" "}
                    {AMENITY_WORDS[a]}
                  </label>
                ))}
              </fieldset>
            ) : null}
          </section>
        ))}
        {card.kind === "unit" ? (
          <>
            <PhotosSection
              unit={card}
              canEdit={canEdit}
              photoSrc={photoSrc}
              onAdd={onAddPhotos}
              onMove={onMovePhoto}
              onRemove={onRemovePhoto}
            />
            <PortalsSection unit={card} board={board} canEdit={canEdit} timezone={timezone} onSwitch={onSwitchPortal} />
          </>
        ) : null}
        {card.kind === "unit" ? (
          <section className="wf-window-part wf-board-fields">
            <h3>Live on</h3>
            {PORTALS.map((p) => (
              <label key={p} className="wf-board-flag">
                <input
                  type="checkbox"
                  checked={liveOn.includes(p)}
                  onChange={(e) => {
                    touch("liveOn");
                    setLiveOn((now) => (e.target.checked ? [...now, p] : now.filter((x) => x !== p)));
                  }}
                />{" "}
                {PORTAL_NAME[p]}
              </label>
            ))}
          </section>
        ) : null}
        <section className="wf-window-part wf-board-fields">
          <h3>Notes</h3>
          <textarea
            aria-label="Notes"
            rows={3}
            value={String(draft.notes)}
            onChange={(e) => {
              touch("notes");
              setDraft((d) => ({ ...d, notes: e.target.value }));
            }}
          />
          <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
            Save
          </button>
        </section>

        <section className="wf-window-part">
          <h3>History</h3>
          {history === null ? (
            <p className="wf-board-empty">Loading the history…</p>
          ) : (
            <ol className="wf-board-history">
              {history.map((m, i) => (
                <li key={i}>{historyLine(m, stepName, timezone)}</li>
              ))}
            </ol>
          )}
        </section>

        <section className="wf-window-part">
          <h3>Close</h3>
          <input aria-label="A note for closing (optional)" placeholder="A note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="wf-board-move-row">
            {CLOSES[card.kind].map(([reason, label]) => {
              const shut = closeProblem(card, reason);
              return (
                <button key={reason} type="button" className="kit-pill" disabled={shut !== null} title={shut ?? undefined} onClick={() => onCloseCard(reason, note.trim() || null)}>
                  {label}
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </CardWindow>
  );
}
