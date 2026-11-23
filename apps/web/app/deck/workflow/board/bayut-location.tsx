"use client";

import { useId, useRef, useState } from "react";
import type { Board, BoardUnit } from "@nexus/shared";
import { readableError, type BayutLocation } from "@/lib/api";

/**
 * The unit's Bayut location (23 Nov 2026), in its Listing section. Bayut takes
 * a listing only on a deep location (a community or deeper, never an area or
 * an emirate), so staff search Bayut's own names and pick one. Offered only
 * once Bayut is connected (the search needs the business's checked token). The
 * search starts from the unit's building, else its sub-community, else its
 * community, and asks in the unit's city; it runs only when asked, since each
 * search counts against the business's Bayut calls. A pick is saved at once,
 * through the unit's own save.
 * Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §6, §12
 */

const SHORT = "Type at least 3 characters.";
const NOTHING = "Bayut has no location by that name deep enough for a listing. Try the building, the sub-community or the community.";

const filled = (s: string | null | undefined) => (s ?? "").trim();

/** Where the search starts: the building, else the sub-community, else the community. */
export function searchStart(unit: BoardUnit): string {
  return filled(unit.building) || filled(unit.subCommunity) || filled(unit.community);
}

export function BayutLocationPicker({
  unit,
  board,
  canEdit,
  onPick,
  onSearch,
}: {
  unit: BoardUnit;
  board: Board;
  canEdit: boolean;
  /** Saves the pick; resolves true once saved. */
  onPick: (location: BayutLocation) => Promise<boolean>;
  /** Bayut's deep locations for `q` in `city` (blank is Dubai). */
  onSearch: (q: string, city: string) => Promise<BayutLocation[]>;
}) {
  const id = useId();
  const [changing, setChanging] = useState(false);
  const [query, setQuery] = useState(() => searchStart(unit));
  const [found, setFound] = useState<BayutLocation[] | null>(null);
  const [said, setSaid] = useState("");
  const [busy, setBusy] = useState(false);
  const asked = useRef(0);
  if (board.bayutConnection !== "connected") return null;
  const saved = unit.bayutLocation;
  const searching = canEdit && (saved === null || changing);

  async function search() {
    const q = query.trim();
    if (q.length < 3) {
      setFound(null);
      setSaid(SHORT);
      return;
    }
    const mine = ++asked.current;
    setBusy(true);
    setSaid("Searching Bayut…");
    try {
      const list = await onSearch(q, unit.city ?? "");
      if (mine !== asked.current) return;
      setFound(list);
      setSaid(list.length === 0 ? NOTHING : "");
    } catch (err) {
      if (mine !== asked.current) return;
      setFound(null);
      setSaid(readableError(err));
    } finally {
      if (mine === asked.current) setBusy(false);
    }
  }

  async function pick(location: BayutLocation) {
    setBusy(true);
    try {
      if (await onPick(location)) {
        setChanging(false);
        setFound(null);
        setSaid("");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wf-board-field wf-board-field-wide">
      <label htmlFor={`${id}-bayut`}>Bayut location</label>
      {saved && !searching ? (
        <div className="wf-board-move-row">
          <span dir="auto">{saved.name}</span>
          {canEdit ? (
            <button type="button" className="kit-pill quiet" onClick={() => setChanging(true)}>
              Change
            </button>
          ) : null}
        </div>
      ) : null}
      {!saved && !canEdit ? <p className="wf-board-empty">Not chosen yet.</p> : null}
      {searching ? (
        <form
          className="wf-board-move-row"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <input
            id={`${id}-bayut`}
            type="search"
            aria-label="Search Bayut locations"
            dir="auto"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" className="kit-pill" disabled={busy}>
            Search
          </button>
          {saved ? (
            <button
              type="button"
              className="kit-pill quiet"
              onClick={() => {
                setChanging(false);
                setFound(null);
                setSaid("");
              }}
            >
              Cancel
            </button>
          ) : null}
        </form>
      ) : null}
      {searching && said ? (
        <p className="wf-board-empty" role="status">
          {said}
        </p>
      ) : null}
      {searching && found && found.length > 0 ? (
        <ul className="wf-board-pick-list">
          {found.map((l) => (
            <li key={l.id}>
              <button type="button" className="kit-pill quiet" disabled={busy} dir="auto" onClick={() => void pick(l)}>
                {l.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
