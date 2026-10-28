/**
 * Staff keep their clients in Excel (28 Oct 2026), so My campaigns reads .xlsx
 * as well as CSV. These build a real workbook — a deflated zip, shared strings,
 * a phone number stored the way Excel stores it — and read it back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";

import { readXlsxRows, numberCellText } from "../lib/xlsx-read.ts";

/** A minimal zip: local headers, central directory, end record. CRCs are not read. */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

const workbook = `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Clients" sheetId="1" r:id="rId3"/></sheets></workbook>`;
const rels = `<Relationships><Relationship Id="rId3" Type="worksheet" Target="worksheets/clients.xml"/></Relationships>`;
const shared = `<sst><si><t>Name</t></si><si><t>WhatsApp</t></si><si><r><t>Ahmed </t></r><r><t>Al-Mansouri</t></r></si><si><t>Sara &amp; Co</t></si></sst>`;
const sheet = `<worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>971501234567</v></c></row>
<row r="4"><c r="A4" t="s"><v>3</v></c><c r="B4"><v>9.71559876543E+11</v></c></row>
<row r="5"><c r="B5" t="inlineStr"><is><t>+971 52 111 2222</t></is></c></row>
<row r="6"/>
</sheetData></worksheet>`;

test("reads the first sheet named in the workbook, shared strings and numbers in full", async () => {
  const rows = await readXlsxRows(
    zip({
      "xl/workbook.xml": workbook,
      "xl/_rels/workbook.xml.rels": rels,
      "xl/sharedStrings.xml": shared,
      "xl/worksheets/clients.xml": sheet,
    })
  );
  assert.deepEqual(rows, [
    ["Name", "WhatsApp"],
    ["Ahmed Al-Mansouri", "971501234567"],
    [],
    ["Sara & Co", "971559876543"],
    ["", "+971 52 111 2222"],
  ]);
});

test("a number Excel wrote in E-notation comes back as the digits a person typed", () => {
  assert.equal(numberCellText("9.71501234567E+11"), "971501234567");
  assert.equal(numberCellText("971501234567"), "971501234567");
  assert.equal(numberCellText("12.5"), "12.5");
});

test("a file that is not a workbook says so instead of importing nothing", async () => {
  await assert.rejects(() => readXlsxRows(new TextEncoder().encode("name,whatsapp\nA,9715")), /not an Excel/);
});
