/**
 * Reading the first sheet of an Excel file (.xlsx) as rows of text.
 *
 * ============================================================
 * WHY NOT A LIBRARY
 * ============================================================
 *
 * Staff keep their clients in Excel, and "save it as CSV first" is a step half
 * of them will not know how to take (28 Oct 2026). The well-known readers are
 * large, and the most used one stopped publishing fixes to npm, which is not a
 * dependency to put in front of every staff member's client list.
 *
 * An .xlsx file is a zip of XML, and the browser already unzips (the
 * DecompressionStream "deflate-raw" format). So this reads the zip directory,
 * inflates the three files it needs — the workbook, the shared strings, the
 * first sheet — and pulls the cell values out. Everything an importer needs and
 * nothing else: no formats, no dates, no formulas beyond their cached value.
 *
 * Phone numbers are the cells that matter. Excel stores 971501234567 as a
 * number, sometimes written 9.71501234567E+11, and a reader that hands that
 * back as text has turned every client into a stranger, so whole numbers are
 * always written out in full.
 */

type Entry = { method: number; compressedSize: number; localOffset: number };

function u16(view: DataView, at: number): number {
  return view.getUint16(at, true);
}
function u32(view: DataView, at: number): number {
  return view.getUint32(at, true);
}

/** The zip's directory: file name to where its bytes are. */
function readDirectory(bytes: Uint8Array): Map<string, Entry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end record sits in the last 64 KB + 22 bytes (its comment is at most 64 KB).
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65_557); at--) {
    if (u32(view, at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("That is not an Excel (.xlsx) file.");

  const count = u16(view, end + 10);
  let at = u32(view, end + 16);
  const names = new TextDecoder();
  const entries = new Map<string, Entry>();
  for (let i = 0; i < count; i++) {
    if (u32(view, at) !== 0x02014b50) throw new Error("That Excel file is damaged.");
    const nameLength = u16(view, at + 28);
    const name = names.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.set(name, {
      method: u16(view, at + 10),
      compressedSize: u32(view, at + 20),
      localOffset: u32(view, at + 42),
    });
    at += 46 + nameLength + u16(view, at + 30) + u16(view, at + 32);
  }
  return entries;
}

async function readEntry(bytes: Uint8Array, entries: Map<string, Entry>, name: string): Promise<string | null> {
  const entry = entries.get(name);
  if (!entry) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = entry.localOffset + 30 + u16(view, entry.localOffset + 26) + u16(view, entry.localOffset + 28);
  const raw = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return new TextDecoder().decode(raw);
  if (entry.method !== 8) throw new Error("That Excel file is packed in a way this cannot read. Save it as CSV instead.");
  const stream = new Blob([new Uint8Array(raw)]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return await new Response(stream).text();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return String.fromCodePoint(n);
    }
    return ENTITIES[code.toLowerCase()] ?? "";
  });
}

/** All the text runs inside one element, joined — rich text is several. */
function textRuns(xml: string): string {
  let out = "";
  for (const match of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += match[1];
  return unescapeXml(out);
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? unescapeXml(match[1]) : null;
}

/** "AB12" → 27 (zero-based column). */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "").toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Excel's number as a person would type it: whole numbers in full. Exported for its test. */
export function numberCellText(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return n.toFixed(0);
  return value;
}

/** The workbook's first sheet's path inside the zip. */
function firstSheetPath(workbook: string | null, rels: string | null): string {
  const sheet = workbook?.match(/<sheet\s[^>]*>/)?.[0];
  const id = sheet ? attribute(sheet, "r:id") : null;
  if (id && rels) {
    for (const rel of rels.match(/<Relationship\s[^>]*>/g) ?? []) {
      if (attribute(rel, "Id") === id) {
        const target = attribute(rel, "Target") ?? "";
        return target.startsWith("/") ? target.slice(1) : `xl/${target}`;
      }
    }
  }
  return "xl/worksheets/sheet1.xml";
}

/**
 * The first sheet as rows of cell text, one array per spreadsheet row from row 1,
 * so row i is line i + 1 in Excel. Trailing empty rows are dropped.
 */
export async function readXlsxRows(data: ArrayBuffer | Uint8Array): Promise<string[][]> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const entries = readDirectory(bytes);

  const shared: string[] = [];
  const sharedXml = await readEntry(bytes, entries, "xl/sharedStrings.xml");
  for (const match of sharedXml?.matchAll(/<si>([\s\S]*?)<\/si>/g) ?? []) shared.push(textRuns(match[1]));

  const path = firstSheetPath(
    await readEntry(bytes, entries, "xl/workbook.xml"),
    await readEntry(bytes, entries, "xl/_rels/workbook.xml.rels")
  );
  const sheet = await readEntry(bytes, entries, path);
  if (sheet === null) throw new Error("That Excel file has no sheet in it.");

  const rows: string[][] = [];
  for (const rowMatch of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNumber = Number(attribute(rowMatch[1], "r")) || rows.length + 1;
    const cells: string[] = [];
    for (const cellMatch of (rowMatch[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const inner = cellMatch[2] ?? "";
      const ref = attribute(attrs, "r");
      const col = ref ? columnIndex(ref) : cells.length;
      const type = attribute(attrs, "t");
      const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let text = "";
      if (type === "s") text = shared[Number(value)] ?? "";
      else if (type === "inlineStr") text = textRuns(inner);
      else if (type === "str" || type === "e") text = value !== undefined ? unescapeXml(value) : "";
      else if (type === "b") text = value === "1" ? "TRUE" : "FALSE";
      else if (value !== undefined) text = numberCellText(value);
      while (cells.length < col) cells.push("");
      cells[col] = text.trim();
    }
    while (rows.length < rowNumber - 1) rows.push([]);
    rows[rowNumber - 1] = cells;
  }
  while (rows.length && rows[rows.length - 1].every((cell) => !cell)) rows.pop();
  return rows;
}
