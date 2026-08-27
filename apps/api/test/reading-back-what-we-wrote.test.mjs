/**
 * The CSV a customer list actually arrives as.
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * The platform could export customers and could not read one back. An export
 * that cannot be re-imported is a one-way door, and the owner is about to enter
 * real data for five businesses — one customer at a time was the only way in.
 *
 * The risk in an importer is not that it crashes. It is that it succeeds on a
 * file it has misread: `split(",")` on `"Ahmed Al-Mansouri, Esq.",9715...`
 * gives three columns, files a phone number as a name, reports "imported 40",
 * and the mistake surfaces when somebody is messaged.
 *
 * So these are real assertions about real strings, not source greps, and the
 * round-trip against this codebase's own `toCsv` is the one that matters most:
 * the writer quotes and doubles quotes, and until now nothing read that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { toCsv } from "@nexus/shared";
import { parseCsv, findColumns } from "../../web/lib/csv-parse.ts";

test("a plain file parses", () => {
  assert.deepEqual(parseCsv("name,number\nAhmed,971501234567"), [
    ["name", "number"],
    ["Ahmed", "971501234567"],
  ]);
});

test("a comma inside a quoted name stays inside the name", () => {
  // THE DEFECT THIS PARSER EXISTS FOR. Splitting on commas turns this into
  // three fields and imports "971501234567" as somebody's surname.
  assert.deepEqual(parseCsv('name,number\n"Al-Mansouri, Ahmed",971501234567'), [
    ["name", "number"],
    ["Al-Mansouri, Ahmed", "971501234567"],
  ]);
});

test("doubled quotes become one quote", () => {
  assert.deepEqual(parseCsv('name\n"Said ""call me Sam"""'), [["name"], ['Said "call me Sam"']]);
});

test("a newline inside quotes does not end the row", () => {
  // An address pasted from a spreadsheet. Treating this as a row break would
  // import half an address as a customer and the other half as another.
  const rows = parseCsv('name,address\nAhmed,"Flat 2, Marina\nDubai"');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], ["Ahmed", "Flat 2, Marina\nDubai"]);
});

test("CRLF files from Windows parse the same as LF", () => {
  assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), parseCsv("a,b\n1,2\n"));
});

test("a trailing newline is not an empty customer", () => {
  // Every file ends with one. Importing it as a record creates a contact with
  // no number, which the identity check then refuses -- a refusal the person
  // reading the report cannot explain, for a row they never typed.
  assert.equal(parseCsv("name,number\nAhmed,971501234567\n").length, 2);
  assert.equal(parseCsv("name,number\nAhmed,971501234567\n\n\n").length, 2);
});

test("a byte-order mark does not swallow the first column name", () => {
  // Excel writes one. It is invisible, it becomes part of "name", the header
  // stops matching, and the file reads as having no recognisable columns --
  // which looks like the importer being broken rather than the file.
  const withBom = "﻿name,number\nAhmed,971501234567";
  assert.deepEqual(parseCsv(withBom)[0], ["name", "number"]);
  assert.equal(findColumns(parseCsv(withBom)[0]).name, 0);
});

test("a quote in the middle of an unquoted field is a literal", () => {
  // Spreadsheets write `5" pipe` unquoted. Treating that quote as the start of
  // quoting would swallow the rest of the file into one field.
  assert.deepEqual(parseCsv('size\n5" pipe'), [["size"], ['5" pipe']]);
});

test("an empty field is kept, so columns do not shift left", () => {
  assert.deepEqual(parseCsv("a,b,c\n1,,3"), [
    ["a", "b", "c"],
    ["1", "", "3"],
  ]);
});

// ============================================================
// Which column is which
// ============================================================

test("the columns are found however the export named them", () => {
  assert.deepEqual(findColumns(["Full Name", "WhatsApp Number"]), { name: 0, number: 1 });
  assert.deepEqual(findColumns(["phone", "customer"]), { name: 1, number: 0 });
  assert.deepEqual(findColumns(["displayName", "waId"]), { name: 0, number: 1 });
});

test("WhatsApp wins over phone when a file has both", () => {
  // A CRM export with both columns means the WhatsApp one. Picking "phone"
  // imports landlines as WhatsApp numbers -- every message then fails, per
  // contact, after the import reported success.
  const cols = findColumns(["name", "phone", "whatsapp"]);
  assert.equal(cols.number, 2);
});

test("a missing column is -1 rather than 0", () => {
  // Defaulting to the first column would import whatever happened to be there.
  const cols = findColumns(["something", "else"]);
  assert.equal(cols.number, -1);
  assert.equal(cols.name, -1);
});

// ============================================================
// The round trip
// ============================================================

test("anything this platform exports, it can read back", () => {
  // The point of the whole file. `toCsv` already quoted and doubled quotes
  // correctly; nothing had ever parsed its output, so the export was a
  // one-way door and nobody knew.
  // toCsv(headers, rows) takes arrays, writes CRLF, and leads with a BOM so
  // Excel reads Arabic names correctly. All three are exactly the things a
  // naive reader trips on, which is why this round trip is the real test.
  const csv = toCsv(
    ["name", "number"],
    [
      ['Al-Mansouri, "Ahmed"', "971501234567"],
      [`Line${String.fromCharCode(10)}break`, "971509876543"],
      ["", "971500000001"],
    ]
  );

  const parsed = parseCsv(csv);
  assert.deepEqual(parsed[0], ["name", "number"]);
  assert.equal(parsed.length, 4, "three customers and a header");
  assert.deepEqual(parsed[1], ['Al-Mansouri, "Ahmed"', "971501234567"]);
  assert.deepEqual(parsed[2], ["Line\nbreak", "971509876543"]);
  assert.deepEqual(parsed[3], ["", "971500000001"]);
});
