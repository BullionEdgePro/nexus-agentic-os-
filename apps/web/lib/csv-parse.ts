/**
 * Reading a CSV somebody exported from somewhere else.
 *
 * ============================================================
 * WHY NOT `split(",")`
 * ============================================================
 *
 * Because the first real file breaks it. A customer list from Excel, Google
 * Sheets or a competitor's CRM routinely contains:
 *
 *   "Ahmed Al-Mansouri, Esq.",971501234567     <- a comma inside a name
 *   "Said ""call me Sam""",971509876543        <- escaped quotes
 *   "Flat 2, Marina\nDubai",97150...           <- a newline inside a field
 *
 * Splitting on commas turns the first into two columns and files a phone number
 * as a name. Nothing errors. Someone is imported under the wrong identity and
 * the mistake is only found when they are messaged.
 *
 * This platform already WRITES csv correctly — `toCsv` quotes and doubles
 * quotes — and could not read back what it produced. An export that cannot be
 * re-imported is a one-way door.
 */

/** One row, already split into fields, with quoting resolved. */
export type CsvRow = string[];

/**
 * Parse RFC-4180-shaped CSV.
 *
 * Handles quoted fields, doubled quotes inside them, commas and newlines inside
 * quotes, and CRLF or LF line endings. Blank lines are dropped — a trailing
 * newline is the normal shape of a file, not an empty record.
 *
 * Deliberately tolerant in one direction only: a quote appearing in the middle
 * of an UNQUOTED field is kept as a literal character rather than treated as
 * the start of quoting, because that is what a spreadsheet does with `5" pipe`
 * and refusing the row would help nobody.
 */
export function parseCsv(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let row: CsvRow = [];
  let field = "";
  let quoted = false;
  let started = false;

  const endField = () => {
    row.push(field);
    field = "";
    started = false;
  };
  const endRow = () => {
    endField();
    // A line that is entirely empty is not a record. One containing a single
    // empty FIELD is, which is why this checks the joined length rather than
    // the row's length.
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  // A BOM is invisible and would otherwise become part of the first header,
  // so "name" stops matching and the whole file looks like it has no columns.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];

    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && !started) {
      quoted = true;
      started = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\r") {
      // Swallowed; the \n that follows ends the row. A lone \r as a line
      // ending is old-Mac and not worth carrying.
      if (src[i + 1] === "\n") i += 1;
      endRow();
    } else if (ch === "\n") {
      endRow();
    } else {
      field += ch;
      started = true;
    }
  }

  // Whatever is left when the text runs out is a final row unless the file
  // ended on a newline, in which case field and row are already empty.
  if (field !== "" || row.length > 0) endRow();

  return rows;
}

/**
 * Which column holds what, from the header row.
 *
 * Matched loosely on purpose. Every export names these differently — "Phone",
 * "phone number", "WhatsApp", "Mobile", "Full Name", "customer name" — and
 * making somebody rename their columns before the platform will read their file
 * is a reason not to bother importing at all.
 *
 * Returns -1 for a column that is not present, which the caller must handle:
 * a missing NAME is survivable, a missing NUMBER means there is nothing to
 * import.
 */
export function findColumns(header: CsvRow): { name: number; number: number } {
  const norm = header.map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));

  // CANDIDATE ORDER WINS, NOT HEADER ORDER.
  //
  // The first version asked "which header matches any candidate", which is a
  // different question: given `name,phone,whatsapp` it returned `phone`,
  // because phone appears earlier in the FILE. The priority list existed
  // precisely to prefer whatsapp over phone, and the loop threw it away. A
  // landline imported as a WhatsApp number fails on every message, one contact
  // at a time, after an import that reported success.
  //
  // Exact matches for every candidate before any substring match, so a column
  // literally called "phone" never loses to one merely containing "whatsapp".
  const findBy = (candidates: string[]) => {
    for (const c of candidates) {
      const exact = norm.indexOf(c);
      if (exact !== -1) return exact;
    }
    for (const c of candidates) {
      const loose = norm.findIndex((h) => h.includes(c));
      if (loose !== -1) return loose;
    }
    return -1;
  };

  return {
    // `waid` and `whatsapp` come first: a file with both "phone" and "whatsapp"
    // columns means the second one, and picking "phone" would import landlines.
    number: findBy(["waid", "whatsapp", "whatsappnumber", "mobile", "phone", "phonenumber", "number"]),
    name: findBy(["displayname", "fullname", "name", "customer", "contact"]),
  };
}
