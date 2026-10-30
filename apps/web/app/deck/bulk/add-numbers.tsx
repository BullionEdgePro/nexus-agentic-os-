"use client";

import { useMemo, useRef, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import { addBulkCustomers, readableError, type BulkCustomerResult } from "@/lib/api";
import { parseCsv } from "@/lib/csv-parse";
import {
  COUNTRIES,
  UAE,
  countOutcomes,
  formatInternational,
  gridToLines,
  readPhoneList,
  type DialCountry,
  type PhoneOutcome,
} from "@/lib/phone-list";
import { readXlsxRows } from "@/lib/xlsx-read";

/**
 * "+ Add numbers": client numbers straight into a campaign (30 Oct 2026).
 *
 * Three ways in, one list: paste anything, upload a spreadsheet, or type one
 * at a time — each lands as lines in the same box, so the person always sees
 * what will be read. Every line is checked as it is typed (ready, corrected
 * with the correction shown, already a customer, duplicate, refused with the
 * reason) and nothing is saved until the consent box is ticked and Add is
 * pressed. The server answers for every number it was sent.
 */

const OUTCOME_WORDS: Record<PhoneOutcome, string> = {
  ready: "Ready",
  corrected: "Corrected",
  known: "Already a customer",
  duplicate: "Duplicate",
  refused: "Refused",
};

/** A spreadsheet as "name number" lines, so it goes through the same reader as a paste. */
async function linesFromFile(file: File): Promise<string> {
  if (/\.xls$/i.test(file.name)) {
    throw new Error("That is the old Excel format. In Excel choose File → Save As → Excel Workbook (.xlsx) or CSV, then add that file.");
  }
  const grid = /\.xlsx$/i.test(file.name) ? await readXlsxRows(await file.arrayBuffer()) : parseCsv(await file.text());
  return gridToLines(grid);
}

export function AddNumbers({
  business,
  businessName,
  numberId,
  known,
  onAdded,
  onShowList,
}: {
  business: BusinessSlug;
  businessName: string;
  numberId: string;
  /** The WhatsApp numbers already customers of this business. */
  known: Set<string>;
  /** Every number now a customer and ready to tick: added, or already known. */
  onAdded: (ids: string[]) => void;
  /** Go to the customer list, where the added numbers are ticked. */
  onShowList: () => void;
}) {
  const [country, setCountry] = useState<DialCountry>(UAE);
  const [text, setText] = useState("");
  const [oneNumber, setOneNumber] = useState("");
  const [oneName, setOneName] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<BulkCustomerResult[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const rows = useMemo(() => readPhoneList(text, country, known), [text, country, known]);
  const counts = countOutcomes(rows);
  const usable = rows.filter((row) => row.outcome === "ready" || row.outcome === "corrected" || row.outcome === "known");
  const fresh = counts.ready + counts.corrected;

  function addLine(line: string) {
    setText((current) => (current.trim() ? `${current.replace(/\s+$/, "")}\n${line}` : line));
    setResults(null);
  }

  async function onFile(file: File) {
    setError("");
    try {
      const lines = await linesFromFile(file);
      if (!lines.trim()) setError(`${file.name} has no rows to read.`);
      else addLine(lines);
    } catch (err) {
      setError(readableError(err));
    }
  }

  async function add() {
    setBusy(true);
    setError("");
    try {
      const data = await addBulkCustomers(business, {
        phoneNumberId: numberId,
        consent: true,
        rows: usable.map((row) => ({ waId: row.waId as string, displayName: row.name, line: row.line })),
      });
      setResults(data.results);
      setText("");
      setConsent(false);
      onAdded(data.results.flatMap((result) => (result.contactId && result.outcome !== "refused" ? [result.contactId] : [])));
    } catch (err) {
      setError(readableError(err, "Nothing was added."));
    } finally {
      setBusy(false);
    }
  }

  const refusedResults = results?.filter((result) => result.outcome === "refused" || result.reason) ?? [];

  return (
    <section className="bk-add" aria-label="Add numbers">
      <p className="bk-add-lead">
        Paste numbers, upload a spreadsheet, or type them one at a time. Each number is checked before anything is saved.
      </p>

      <label className="bk-add-country">
        Numbers without a country code are completed with
        <select
          value={country.code}
          onChange={(event) => setCountry(COUNTRIES.find((c) => c.code === event.target.value) ?? UAE)}
        >
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name} (+{c.dial})
            </option>
          ))}
        </select>
      </label>

      <div className="bk-add-ways">
        <label className="bk-add-paste">
          <span>Paste a list</span>
          <textarea
            rows={6}
            value={text}
            placeholder={"Ahmed 050 123 4567\n+971 55 987 6543 Sara\n0521112222, 0569998888"}
            onChange={(event) => {
              setText(event.target.value);
              setResults(null);
            }}
          />
          <em>One per line, or separated by commas. A name beside a number is kept.</em>
        </label>

        <div className="bk-add-side">
          <div className="bk-add-one">
            <span>Or type one</span>
            <input
              type="tel"
              inputMode="tel"
              placeholder="050 123 4567"
              value={oneNumber}
              onChange={(event) => setOneNumber(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && oneNumber.trim()) {
                  event.preventDefault();
                  addLine(`${oneName.trim()} ${oneNumber.trim()}`.trim());
                  setOneNumber("");
                  setOneName("");
                }
              }}
            />
            <input placeholder="Name (optional)" value={oneName} onChange={(event) => setOneName(event.target.value)} />
            <button
              type="button"
              className="bk-ghost"
              disabled={!oneNumber.trim()}
              onClick={() => {
                addLine(`${oneName.trim()} ${oneNumber.trim()}`.trim());
                setOneNumber("");
                setOneName("");
              }}
            >
              Add to the list
            </button>
          </div>

          <div className="bk-add-file">
            <span>Or upload a file</span>
            <button type="button" className="bk-ghost" onClick={() => fileInput.current?.click()}>
              Excel or CSV…
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".xlsx,.xls,.csv,text/csv"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void onFile(file);
                event.target.value = "";
              }}
            />
          </div>
        </div>
      </div>

      {rows.length ? (
        <>
          <p className="bk-add-counts">
            <b>{counts.ready}</b> ready · <b>{counts.corrected}</b> corrected · <b>{counts.known}</b> already customers ·{" "}
            <b>{counts.duplicate}</b> duplicates · <b>{counts.refused}</b> refused
          </p>
          <ul className="bk-rows">
            {rows.slice(0, 200).map((row, index) => (
              <li key={`${row.line}-${index}`} className={`bk-row bk-row-${row.outcome}`}>
                <span className="bk-row-outcome">{OUTCOME_WORDS[row.outcome]}</span>
                <span className="bk-row-who">
                  {row.name ? <strong>{row.name}</strong> : null}
                  {row.waId ? formatInternational(row.waId) : row.raw}
                </span>
                {row.note ? <em>{row.note}</em> : null}
              </li>
            ))}
            {rows.length > 200 ? <li className="bk-row-more">and {rows.length - 200} more</li> : null}
          </ul>

          <label className="bk-consent">
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            These people agreed to get WhatsApp messages from {businessName}.
          </label>
          <button type="button" className="cmp-go" disabled={busy || !consent || usable.length === 0} onClick={() => void add()}>
            {busy
              ? "Adding…"
              : `Add ${fresh} ${fresh === 1 ? "number" : "numbers"}${counts.known ? ` and tick ${counts.known} already here` : ""}`}
          </button>
        </>
      ) : null}

      {error ? <p className="mc-error">{error}</p> : null}

      {results ? (
        <div className="bk-add-done">
          <p className="cmp-test-ok">
            Added {results.filter((r) => r.outcome === "added").length}
            {results.some((r) => r.outcome === "already-known")
              ? ` · ${results.filter((r) => r.outcome === "already-known").length} were already customers`
              : ""}
            {results.some((r) => r.outcome === "refused") ? ` · ${results.filter((r) => r.outcome === "refused").length} refused` : ""}.
            They are ticked in the customer list.
          </p>
          {refusedResults.length ? (
            <ul className="cmp-why">
              {refusedResults.map((result, index) => (
                <li key={`${result.waId}-${index}`}>
                  {result.line ? `Line ${result.line}: ` : ""}+{result.waId} — {result.reason}
                </li>
              ))}
            </ul>
          ) : null}
          <button type="button" className="bk-ghost" onClick={onShowList}>
            Show them in the customer list
          </button>
        </div>
      ) : null}
    </section>
  );
}
