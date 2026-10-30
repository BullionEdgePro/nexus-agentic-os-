/**
 * Reading phone numbers the way people keep them (30 Oct 2026).
 *
 * Bulk messaging takes numbers pasted from anywhere: a spreadsheet column, a
 * WhatsApp chat, typed by hand with the local "0". WhatsApp needs the full
 * international form, digits only, and a number completed wrongly is a
 * stranger in another country ("525631476" sent as it stands is +52, Mexico).
 * So a local number is completed from the chosen country and SHOWN corrected,
 * and anything that cannot be read with certainty is refused with the reason —
 * never guessed. The server accepts nothing but the finished international form.
 */

import { findColumns } from "./csv-parse";

export interface DialCountry {
  /** ISO code, the picker's key. */
  code: string;
  name: string;
  /** The country calling code, digits only. */
  dial: string;
  /** How many digits follow the calling code (the local "0" dropped). */
  lengths: number[];
}

export const COUNTRIES: DialCountry[] = [
  { code: "AE", name: "United Arab Emirates", dial: "971", lengths: [8, 9] },
  { code: "SA", name: "Saudi Arabia", dial: "966", lengths: [9] },
  { code: "OM", name: "Oman", dial: "968", lengths: [8] },
  { code: "QA", name: "Qatar", dial: "974", lengths: [8] },
  { code: "BH", name: "Bahrain", dial: "973", lengths: [8] },
  { code: "KW", name: "Kuwait", dial: "965", lengths: [8] },
  { code: "IN", name: "India", dial: "91", lengths: [10] },
  // Landline lengths too where they differ from mobiles, so a real landline
  // written with its country code is never refused for its length.
  { code: "PK", name: "Pakistan", dial: "92", lengths: [9, 10] },
  { code: "PH", name: "Philippines", dial: "63", lengths: [9, 10] },
  { code: "GB", name: "United Kingdom", dial: "44", lengths: [9, 10] },
];

export const UAE = COUNTRIES[0] as DialCountry;

export type PhoneOutcome = "ready" | "corrected" | "known" | "duplicate" | "refused";

export interface PhoneRow {
  /** 1-based, counting blank lines, so it matches the line the person sees. */
  line: number;
  raw: string;
  name: string | null;
  /** International digits; null when refused. */
  waId: string | null;
  outcome: PhoneOutcome;
  /** What happened, for the person: the correction, or the reason. */
  note: string | null;
}

const EXCEL_SHORTENED =
  "Excel shortened this number (it shows like 9.7E+11). Format the column as Text in Excel and copy it again.";

/** A number Excel turned into scientific notation, digits already lost. */
const EXCEL_RUN = /\d(?:[.,]\d+)?e\+\d+/i;

/** A phone-number-shaped run: optional + or 00, then digits with spaces, dots, dashes, brackets. */
const NUMBER_RUN = /(?:\+|00)?\d[\d\s().\-]{6,}\d/g;

/** Arabic-Indic and Persian digits as 0-9: numbers are often typed on an Arabic keyboard. */
function westernDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

function internationalLengthProblem(waId: string): string | null {
  if (waId.length < 8) return "Too short for a phone number.";
  if (waId.length > 15) return "Too long for a phone number.";
  if (waId.startsWith("0")) return "A number written with + cannot continue with 0.";
  return null;
}

/** The listed country whose calling code begins these digits (calling codes never prefix one another). */
function countryOf(digits: string): DialCountry | undefined {
  return COUNTRIES.find((candidate) => digits.startsWith(candidate.dial));
}

/**
 * The digits after a known country's code, checked against that country.
 *
 * "+971 050 123 4567" — the local 0 kept after the code — is the commonest
 * slip, and as written it is a number that does not exist: it is corrected
 * and shown. A length the country does not use is refused rather than stored.
 */
function afterCountryCode(digits: string, country: DialCountry): { waId: string; corrected: boolean } | { error: string } {
  const rest = digits.slice(country.dial.length);
  if (rest.startsWith("0")) {
    return country.lengths.includes(rest.length - 1)
      ? { waId: country.dial + rest.slice(1), corrected: true }
      : { error: `Not a ${country.name} number. Check the digits after +${country.dial}.` };
  }
  return country.lengths.includes(rest.length)
    ? { waId: digits, corrected: false }
    : { error: `Not a ${country.name} number. Check the digits after +${country.dial}.` };
}

/** One number, completed from `country` when it was typed locally. */
export function readPhoneNumber(
  raw: string,
  country: DialCountry
): { waId: string; corrected: boolean } | { error: string } {
  const text = westernDigits(raw).trim();
  if (EXCEL_RUN.test(text)) return { error: EXCEL_SHORTENED };
  if (/[a-z]/i.test(text) || !/\d/.test(text)) return { error: "That is not a phone number." };

  const digits = text.replace(/\D/g, "");
  if (text.startsWith("+") || digits.startsWith("00")) {
    const waId = digits.replace(/^00/, "");
    const problem = internationalLengthProblem(waId);
    if (problem) return { error: problem };
    // A code this list does not know keeps the plain length rule above.
    const known = countryOf(waId);
    return known ? afterCountryCode(waId, known) : { waId, corrected: false };
  }
  // International form typed without the + ("971501234567", "9710501234567").
  // Only when it reads cleanly as one: otherwise it may be a local number that
  // happens to start with those digits, and the local reading below decides.
  if (digits.startsWith(country.dial)) {
    const reading = afterCountryCode(digits, country);
    if (!("error" in reading)) return reading;
  }
  const national = digits.replace(/^0/, "");
  if (country.lengths.includes(national.length)) return { waId: country.dial + national, corrected: true };
  if (digits.length < 8) return { error: "Too short for a phone number." };
  return { error: `Not a ${country.name} number. Write it with its country code, starting with +.` };
}

/** "971501234567" → "+971 50 123 4567"; other countries "+<code> <rest>". */
export function formatInternational(waId: string): string {
  const country = [...COUNTRIES]
    .sort((a, b) => b.dial.length - a.dial.length)
    .find((candidate) => waId.startsWith(candidate.dial));
  if (!country) return `+${waId}`;
  const rest = waId.slice(country.dial.length);
  if (country.code === "AE" && rest.length === 9) return `+971 ${rest.slice(0, 2)} ${rest.slice(2, 5)} ${rest.slice(5)}`;
  if (country.code === "AE" && rest.length === 8) return `+971 ${rest.slice(0, 1)} ${rest.slice(1, 4)} ${rest.slice(4)}`;
  return `+${country.dial} ${rest}`;
}

/**
 * Every number in a pasted list, each with what became of it.
 *
 * A line is split on commas, semicolons and tabs; each number takes the words
 * beside it in its own piece as the name ("Ahmed 050 123 4567"), or — when the
 * line holds one number alone in its piece — the line's first wordy piece
 * ("Ahmed, 0501234567", a spreadsheet row). The first non-blank line without a
 * digit is a header and skipped; a later one is reported, not dropped.
 */
export function readPhoneList(text: string, country: DialCountry, known: Set<string>): PhoneRow[] {
  const rows: PhoneRow[] = [];
  const seen = new Set<string>();
  let first = true;

  westernDigits(text)
    .split(/\r?\n/)
    .forEach((lineText, index) => {
      const line = index + 1;
      if (!lineText.trim()) return;
      const isFirst = first;
      first = false;
      if (!/\d/.test(lineText)) {
        if (!isFirst) {
          rows.push({ line, raw: lineText.trim(), name: null, waId: null, outcome: "refused", note: "No phone number on this line." });
        }
        return;
      }

      const segments = lineText.split(/[,;\t]/);
      const found: Array<{ raw: string; name: string | null; excel: boolean }> = [];
      for (const segment of segments) {
        if (EXCEL_RUN.test(segment)) {
          found.push({ raw: segment.trim(), name: null, excel: true });
          continue;
        }
        const runs = segment.match(NUMBER_RUN) ?? [];
        const words = runs.reduce((rest, run) => rest.replace(run, " "), segment).replace(/\s+/g, " ").trim();
        for (const run of runs) found.push({ raw: run.trim(), name: words || null, excel: false });
      }
      if (found.length === 1 && found[0] && !found[0].name) {
        const label = segments.find((segment) => segment.trim() && !/\d/.test(segment));
        if (label) found[0].name = label.trim();
      }
      if (found.length === 0) {
        rows.push({ line, raw: lineText.trim(), name: null, waId: null, outcome: "refused", note: "No phone number on this line." });
        return;
      }

      for (const item of found) {
        const read = item.excel ? { error: EXCEL_SHORTENED } : readPhoneNumber(item.raw, country);
        if ("error" in read) {
          rows.push({ line, raw: item.raw, name: item.name, waId: null, outcome: "refused", note: read.error });
        } else if (seen.has(read.waId)) {
          rows.push({ line, raw: item.raw, name: item.name, waId: read.waId, outcome: "duplicate", note: "Already in this list." });
        } else {
          seen.add(read.waId);
          if (known.has(read.waId)) {
            rows.push({ line, raw: item.raw, name: item.name, waId: read.waId, outcome: "known", note: "Already a customer — will be ticked." });
          } else if (read.corrected) {
            rows.push({
              line,
              raw: item.raw,
              name: item.name,
              waId: read.waId,
              outcome: "corrected",
              note: `${item.raw} → ${formatInternational(read.waId)}`,
            });
          } else {
            rows.push({ line, raw: item.raw, name: item.name, waId: read.waId, outcome: "ready", note: null });
          }
        }
      }
    });

  return rows;
}

/**
 * A spreadsheet's rows as "name number" lines, so a file goes through the same
 * reader as a paste and the person sees what will be read.
 *
 * Cells are taken exactly as the file holds them. The .xlsx reader already
 * writes numeric cells out in full; a cell that still reads "9.71501E+11" is
 * text whose digits Excel threw away, and expanding it would invent a number.
 */
export function gridToLines(grid: string[][]): string {
  const header = grid[0] ?? [];
  const columns = header.length ? findColumns(header) : { name: -1, number: -1 };
  if (columns.number < 0) return grid.map((row) => row.join(" ").trim()).filter(Boolean).join("\n");
  return grid
    .slice(1)
    .map((row) => {
      const name = columns.name >= 0 ? (row[columns.name] ?? "").trim() : "";
      return `${name} ${(row[columns.number] ?? "").trim()}`.trim();
    })
    .filter(Boolean)
    .join("\n");
}

export function countOutcomes(rows: PhoneRow[]): Record<PhoneOutcome, number> {
  const counts: Record<PhoneOutcome, number> = { ready: 0, corrected: 0, known: 0, duplicate: 0, refused: 0 };
  for (const row of rows) counts[row.outcome]++;
  return counts;
}
