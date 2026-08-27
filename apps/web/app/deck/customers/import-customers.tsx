"use client";

import { useMemo, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import { parseCsv, findColumns } from "@/lib/csv-parse";
import { importContacts, readableError, type ImportedContact } from "@/lib/api";

/**
 * Bringing a customer list in.
 *
 * ============================================================
 * WHY IT SHOWS YOU THE FILE BEFORE IT WRITES ANYTHING
 * ============================================================
 *
 * The platform could export customers and could not read one back, so the only
 * way in was one at a time. That is fine for a walk-in and hopeless for five
 * businesses starting from a spreadsheet.
 *
 * The danger in an importer is not failure, it is confident success on a file
 * it has misread. A column guessed wrong imports phone numbers as names, or
 * landlines as WhatsApp numbers, and every one of those is a real row in the
 * database reported as a win. So the columns it has chosen and the first rows
 * it has read are shown BEFORE the import button does anything, and the column
 * choice can be overridden.
 *
 * Nothing here is clever about the file. `parseCsv` handles the quoting, and
 * this screen's whole job is to let a person see what was understood.
 */
export function ImportCustomers({
  business,
  businessName,
  onImported,
}: {
  business: BusinessSlug;
  businessName: string;
  onImported: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [nameCol, setNameCol] = useState<number | null>(null);
  const [numberCol, setNumberCol] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<ImportedContact[] | null>(null);

  const grid = useMemo(() => (text.trim() ? parseCsv(text) : []), [text]);
  const header = grid[0] ?? [];
  const guessed = useMemo(() => (header.length ? findColumns(header) : { name: -1, number: -1 }), [header]);

  // An explicit choice beats the guess; the guess beats nothing.
  const numberIndex = numberCol ?? (guessed.number >= 0 ? guessed.number : null);
  const nameIndex = nameCol ?? (guessed.name >= 0 ? guessed.name : null);

  // Row 1 is the header. Line numbers are 1-based and count it, so a refusal
  // can be pointed at the line a spreadsheet shows.
  const rows = useMemo(() => {
    if (numberIndex === null) return [];
    return grid.slice(1).map((cells, i) => ({
      line: i + 2,
      waId: (cells[numberIndex] ?? "").trim(),
      displayName: nameIndex === null ? null : (cells[nameIndex] ?? "").trim() || null,
    }));
  }, [grid, numberIndex, nameIndex]);

  const usable = rows.filter((r) => r.waId.replace(/\D/g, "").length >= 8);
  const unusable = rows.length - usable.length;

  async function run() {
    setBusy(true);
    setError("");
    try {
      // Every row is sent, including the ones this screen thinks are unusable.
      // The server's refusal carries a sentence written for a person, and
      // silently dropping them here would mean the report did not mention rows
      // that were in the file.
      const data = await importContacts(business, rows);
      setResults(data.results);
      onImported();
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="cu-import-open" onClick={() => setOpen(true)}>
        Import a customer list
      </button>
    );
  }

  const refused = results?.filter((r) => r.outcome === "refused") ?? [];

  return (
    <div className="cu-import">
      <div className="cu-import-head">
        <strong>Import customers into {businessName}</strong>
        <button
          type="button"
          className="cu-import-close"
          onClick={() => {
            setOpen(false);
            setResults(null);
            setText("");
          }}
        >
          Close
        </button>
      </div>

      {results ? (
        <div className="cu-import-done">
          <p className="cu-import-tally">
            <b>{results.filter((r) => r.outcome === "added").length}</b> added ·{" "}
            <b>{results.filter((r) => r.outcome === "already-known").length}</b> already on file ·{" "}
            <b className={refused.length ? "bad" : ""}>{refused.length}</b> refused
          </p>

          {/* NAMED, NOT COUNTED. A refusal the reader cannot locate in their own
              file is the same as no report at all. */}
          {refused.length > 0 ? (
            <ul className="cu-import-refused">
              {refused.slice(0, 20).map((row) => (
                <li key={`${row.line}-${row.waId}`}>
                  <span>Line {row.line ?? "?"}</span>
                  <span>{row.waId || "(no number)"}</span>
                  <span>{row.reason}</span>
                </li>
              ))}
              {refused.length > 20 ? <li>…and {refused.length - 20} more</li> : null}
            </ul>
          ) : null}

          <p className="cu-import-note">
            Fix any lines above and import the same file again — nobody is duplicated.
          </p>
        </div>
      ) : (
        <>
          <label className="cu-import-field">
            <span>Paste the file, or drop it in</span>
            <textarea
              rows={5}
              value={text}
              placeholder={"name,whatsapp\nAhmed Al-Mansouri,971501234567"}
              onChange={(event) => setText(event.target.value)}
              onDrop={(event) => {
                const file = event.dataTransfer.files?.[0];
                if (!file) return;
                event.preventDefault();
                void file.text().then(setText);
              }}
            />
          </label>

          {header.length > 0 ? (
            <div className="cu-import-cols">
              <label>
                <span>WhatsApp number column</span>
                <select
                  value={numberIndex ?? ""}
                  onChange={(event) =>
                    setNumberCol(event.target.value === "" ? null : Number(event.target.value))
                  }
                >
                  <option value="">Not found — choose one</option>
                  {header.map((h, i) => (
                    <option key={`${h}-${i}`} value={i}>
                      {h || `Column ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Name column</span>
                <select
                  value={nameIndex ?? ""}
                  onChange={(event) =>
                    setNameCol(event.target.value === "" ? null : Number(event.target.value))
                  }
                >
                  <option value="">No names in this file</option>
                  {header.map((h, i) => (
                    <option key={`${h}-${i}`} value={i}>
                      {h || `Column ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}

          {/* THE PREVIEW IS THE POINT. Whatever this shows is what will be
              written, so a wrong column is visible before it is a row. */}
          {rows.length > 0 ? (
            <div className="cu-import-preview">
              <p>
                {rows.length} row{rows.length === 1 ? "" : "s"} read
                {unusable > 0 ? (
                  <em className="bad"> · {unusable} without a usable number</em>
                ) : null}
              </p>
              <table>
                <tbody>
                  {rows.slice(0, 4).map((row) => (
                    <tr key={row.line}>
                      <td>{row.displayName ?? <em>no name</em>}</td>
                      <td>{row.waId || <em>no number</em>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > 4 ? <p className="cu-import-more">…and {rows.length - 4} more</p> : null}
            </div>
          ) : text.trim() && numberIndex === null ? (
            <p className="cu-import-note bad">
              No column here looks like a WhatsApp number. Choose one above.
            </p>
          ) : null}

          {error ? <p className="cu-import-note bad">{error}</p> : null}

          <div className="cu-import-foot">
            <button type="button" disabled={busy || rows.length === 0} onClick={() => void run()}>
              {busy ? "Importing…" : `Import ${rows.length || ""}`.trim()}
            </button>
            <span>
              Numbers need the country code and no plus — 971501234567. Running the same file
              twice adds nobody twice.
            </span>
          </div>
        </>
      )}
    </div>
  );
}
