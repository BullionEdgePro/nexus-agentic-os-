"use client";

import { useEffect, useMemo, useState } from "react";
import {
  initialsOf,
  matchesFilter,
  sinceWrote,
  standingOf,
  type ClientFilter,
} from "@/lib/client-filters";

/**
 * Your whole book, to pick from (30 Oct 2026).
 *
 * A campaign used to go to everybody in the book or nobody. This lists every
 * client with how they stand with WhatsApp — who can get a free message right
 * now, who wrote this week, who has gone quiet, who never wrote — and lets the
 * person tick exactly who the next message is for. The choice carries over to
 * the WhatsApp tab, where both kinds of send go only to the ticked clients.
 */

export interface PickableClient {
  id: string;
  displayName: string | null;
  waId: string;
  lastInboundAt?: string | null;
}

const FILTERS: Array<{ key: ClientFilter; label: string }> = [
  { key: "all", label: "Everyone" },
  { key: "free", label: "Free message now" },
  { key: "week", label: "Wrote this week" },
  { key: "quiet", label: "Quiet 30+ days" },
  { key: "never", label: "Never wrote" },
];

const STANDING_WORDS: Record<string, string> = {
  free: "free message now",
  week: "",
  month: "",
  quiet: "gone quiet",
  never: "approved message only",
};

export function ClientsTab({
  clients,
  selected,
  onChange,
  onSend,
  title = "Your clients",
  where = "you",
  justAdded,
}: {
  clients: PickableClient[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  /** Go and send to the chosen clients: a quick message or an approved one. */
  onSend: (kind: "quick" | "approved") => void;
  /** "Your clients" for a person's book; the admin page names the business's customers. */
  title?: string;
  /** Who they wrote to: "you", or the chosen number. */
  where?: string;
  /** Numbers the admin just added (30 Oct 2026): a chip shows only them, chosen when they arrive. */
  justAdded?: Set<string>;
}) {
  const [filter, setFilter] = useState<ClientFilter | "added">("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"recent" | "name">("recent");
  const now = Date.now();

  useEffect(() => {
    if (justAdded?.size) setFilter("added");
    else setFilter((current) => (current === "added" ? "all" : current));
  }, [justAdded]);
  const addedCount = justAdded?.size ? clients.filter((client) => justAdded.has(client.id)).length : 0;

  const counts = useMemo(() => {
    const out: Record<ClientFilter, number> = { all: 0, free: 0, week: 0, quiet: 0, never: 0 };
    for (const client of clients) for (const f of FILTERS) if (matchesFilter(f.key, client.lastInboundAt, now)) out[f.key]++;
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients]);

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const digits = needle.replace(/\D/g, "");
    return clients
      .filter((client) =>
        filter === "added" ? Boolean(justAdded?.has(client.id)) : matchesFilter(filter, client.lastInboundAt, now)
      )
      .filter(
        (client) =>
          !needle ||
          (client.displayName ?? "").toLowerCase().includes(needle) ||
          (digits.length >= 3 && client.waId.includes(digits))
      )
      .sort((a, b) =>
        sort === "name"
          ? (a.displayName ?? "~").localeCompare(b.displayName ?? "~")
          : new Date(b.lastInboundAt ?? 0).getTime() - new Date(a.lastInboundAt ?? 0).getTime()
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients, filter, search, sort, justAdded]);

  const chosen = clients.filter((client) => selected.has(client.id));
  const chosenFree = chosen.filter((client) => standingOf(client.lastInboundAt, now) === "free").length;
  const allShownChosen = shown.length > 0 && shown.every((client) => selected.has(client.id));

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }

  function toggleShown() {
    const next = new Set(selected);
    if (allShownChosen) for (const client of shown) next.delete(client.id);
    else for (const client of shown) next.add(client.id);
    onChange(next);
  }

  return (
    <section className="ct" aria-label="Choose clients">
      <div className="ct-head">
        <div>
          <h2>{title}</h2>
          <p>
            Tick who the next message is for. <strong>{counts.free}</strong> can get a free message right now — they wrote to{" "}
            {where} in the last 24 hours.
          </p>
        </div>
        <input
          className="ct-search"
          type="search"
          placeholder="Search a name or number"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <div className="ct-chips" role="tablist" aria-label="Filter clients">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            role="tab"
            aria-selected={filter === f.key}
            className={`ct-chip ct-chip-${f.key} ${filter === f.key ? "on" : ""}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            <b>{counts[f.key]}</b>
          </button>
        ))}
        {addedCount > 0 ? (
          <button
            type="button"
            role="tab"
            aria-selected={filter === "added"}
            className={`ct-chip ct-chip-added ${filter === "added" ? "on" : ""}`}
            onClick={() => setFilter("added")}
          >
            Just added
            <b>{addedCount}</b>
          </button>
        ) : null}
      </div>

      <div className="ct-tools">
        <label className="ct-all">
          <input type="checkbox" checked={allShownChosen} onChange={toggleShown} disabled={shown.length === 0} />
          {allShownChosen ? "Untick" : "Tick"} all {shown.length} shown
        </label>
        <label className="ct-sort">
          Sort
          <select value={sort} onChange={(event) => setSort(event.target.value === "name" ? "name" : "recent")}>
            <option value="recent">Most recent first</option>
            <option value="name">A–Z</option>
          </select>
        </label>
      </div>

      {shown.length === 0 ? (
        <p className="mc-empty">
          {clients.length === 0
            ? "Nobody to show yet."
            : "Nobody matches — try another filter or search."}
        </p>
      ) : (
        <ul className="ct-list">
          {shown.map((client) => {
            const standing = standingOf(client.lastInboundAt, now);
            const on = selected.has(client.id);
            return (
              <li key={client.id} className={on ? "on" : ""}>
                <label>
                  <input type="checkbox" checked={on} onChange={() => toggle(client.id)} />
                  <span className={`ct-avatar ct-avatar-${standing}`} aria-hidden="true">
                    {initialsOf(client.displayName, client.waId)}
                  </span>
                  <span className="ct-who">
                    <strong>{client.displayName ?? "Unnamed"}</strong>
                    <span>+{client.waId}</span>
                  </span>
                  <span className={`ct-when ct-when-${standing}`}>
                    {sinceWrote(client.lastInboundAt, now).replace("to you", where === "you" ? "to you" : "")}
                    {STANDING_WORDS[standing] ? <em>{STANDING_WORDS[standing]}</em> : null}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {chosen.length > 0 ? (
        <div className="ct-bar" role="region" aria-label="Chosen clients">
          <span>
            <strong>{chosen.length}</strong> chosen
            {chosenFree ? (
              <>
                {" "}
                · <strong>{chosenFree}</strong> can get a free message
              </>
            ) : null}
          </span>
          <div>
            <button type="button" className="cmp-link" onClick={() => onChange(new Set())}>
              Clear
            </button>
            <button type="button" className="cmp-go alt" disabled={chosenFree === 0} onClick={() => onSend("quick")}>
              Quick message ({chosenFree})
            </button>
            <button type="button" className="cmp-go" onClick={() => onSend("approved")}>
              Approved message ({chosen.length})
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
