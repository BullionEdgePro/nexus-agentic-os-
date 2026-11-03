"use client";

import { useId, useState, type FormEvent } from "react";
import type { Purpose } from "@nexus/shared";
import type { ContactSummary, DealInput, UnitInput } from "@/lib/api";

/**
 * Adding to the workflow board (3 Nov 2026): a unit, opening on Classify unit,
 * or a lead, from the hot list or from the viewer's own customers. A lead needs
 * renting or buying before it can be saved; it starts on Unit matcher, or on
 * Cold lead if chosen.
 * Spec: docs/superpowers/specs/2026-11-03-sfs-workflow-board-design.md §2
 */

/**
 * Dirhams as people type them: "1,200,000" and "85 000" are fine. Nothing
 * typed is nothing (null); anything else that is not an amount is NaN, so the
 * form can say so instead of sending it.
 */
export function toAed(input: string): number | null {
  const plain = input.replace(/[\s,]/g, "");
  if (plain === "") return null;
  return /^\d+(\.\d{1,2})?$/.test(plain) ? Number(plain) : NaN;
}

export const MONEY_HELP = "Write the amount in dirhams, digits only — 1,200,000 is fine.";

export type NewCard =
  | ({ kind: "unit" } & UnitInput & { reference: string })
  | ({ kind: "deal" } & DealInput & { contactId: string; purpose: Purpose; step: "D3" | "D4" });

function CustomerPicker({
  label,
  contacts,
  selected,
  onSearch,
  onPick,
}: {
  label: string;
  contacts: ContactSummary[];
  selected: string | null;
  onSearch: (query: string) => void;
  onPick: (id: string) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  return (
    <div className="wf-board-pick">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="search"
        value={query}
        placeholder="Search your customers by name or number"
        onChange={(e) => {
          setQuery(e.target.value);
          if (e.target.value.trim().length >= 2) onSearch(e.target.value.trim());
        }}
      />
      {contacts.length > 0 ? (
        <ul className="wf-board-pick-list">
          {contacts.map((c) => (
            <li key={c.id}>
              <button type="button" className="kit-pill quiet" aria-pressed={selected === c.id} onClick={() => onPick(c.id)}>
                {c.displayName ?? c.waId}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function AddCard({
  kind,
  preset,
  contacts,
  message,
  onSearch,
  onCreate,
  onDismiss,
}: {
  kind: "unit" | "deal";
  preset: { contactId: string; name: string | null } | null;
  contacts: ContactSummary[];
  message: string;
  onSearch: (query: string) => void;
  onCreate: (card: NewCard) => Promise<void>;
  onDismiss: () => void;
}) {
  const ids = { reference: useId(), community: useId(), price: useId(), step: useId(), budget: useId() };
  const [reference, setReference] = useState("");
  const [community, setCommunity] = useState("");
  const [price, setPrice] = useState("");
  const [person, setPerson] = useState<string | null>(preset?.contactId ?? null);
  const [purpose, setPurpose] = useState<Purpose | null>(null);
  const [step, setStep] = useState<"D3" | "D4">("D4");
  const [budget, setBudget] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);

  const ready = kind === "unit" ? reference.trim() !== "" : person !== null && purpose !== null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const amount = toAed(kind === "unit" ? price : budget);
    if (Number.isNaN(amount)) {
      setProblem(MONEY_HELP);
      return;
    }
    setProblem("");
    setBusy(true);
    try {
      if (kind === "unit") {
        await onCreate({
          kind: "unit",
          reference: reference.trim(),
          ...(community.trim() ? { community: community.trim() } : {}),
          ...(amount !== null ? { priceAed: amount } : {}),
          ...(person ? { ownerContactId: person } : {}),
        });
      } else if (person && purpose) {
        await onCreate({ kind: "deal", contactId: person, purpose, step, ...(amount !== null ? { budgetAed: amount } : {}) });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="wf-board-add" onSubmit={submit}>
      <h2 className="wf-h2">{kind === "unit" ? "Add a unit" : "Put a lead on the board"}</h2>
      {kind === "unit" ? (
        <>
          <p className="wf-board-add-note">It opens on Classify unit. Put it on Rent units or Sale units to classify it.</p>
          <label htmlFor={ids.reference}>Reference</label>
          <input id={ids.reference} value={reference} placeholder="Marina Gate 2 · 1204" onChange={(e) => setReference(e.target.value)} />
          <label htmlFor={ids.community}>Community (optional)</label>
          <input id={ids.community} value={community} onChange={(e) => setCommunity(e.target.value)} />
          <label htmlFor={ids.price}>Yearly rent or asking price, in AED (optional)</label>
          <input id={ids.price} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          <CustomerPicker label="Owner (optional)" contacts={contacts} selected={person} onSearch={onSearch} onPick={setPerson} />
        </>
      ) : (
        <>
          {preset ? (
            <p className="wf-board-add-note">
              Customer: <b dir="auto">{preset.name ?? "A customer"}</b>
            </p>
          ) : (
            <CustomerPicker label="Customer" contacts={contacts} selected={person} onSearch={onSearch} onPick={setPerson} />
          )}
          <fieldset className="wf-board-add-purpose">
            <legend>The lead is</legend>
            <label>
              <input type="radio" name="purpose" value="rent" checked={purpose === "rent"} onChange={() => setPurpose("rent")} /> Renting
            </label>
            <label>
              <input type="radio" name="purpose" value="sale" checked={purpose === "sale"} onChange={() => setPurpose("sale")} /> Buying
            </label>
          </fieldset>
          <label htmlFor={ids.step}>Starts on</label>
          <select id={ids.step} value={step} onChange={(e) => setStep(e.target.value as "D3" | "D4")}>
            <option value="D4">Unit matcher</option>
            <option value="D3">Cold lead</option>
          </select>
          <label htmlFor={ids.budget}>Budget in AED (optional)</label>
          <input id={ids.budget} inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </>
      )}
      {problem || message ? (
        <p className="wf-board-status" role="status">
          {problem || message}
        </p>
      ) : null}
      <div className="wf-board-add-actions">
        <button type="button" className="btn quiet" onClick={onDismiss}>
          Cancel
        </button>
        <button type="submit" className="btn" disabled={!ready || busy}>
          {kind === "unit" ? "Add unit" : "Put on the board"}
        </button>
      </div>
    </form>
  );
}
