/**
 * Adding numbers to a campaign (30 Oct 2026): a list arrives however people
 * keep it — pasted from WhatsApp, a spreadsheet column, typed with local
 * prefixes — and every row says what became of it before anything is saved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { COUNTRIES, UAE, countOutcomes, gridToLines, readPhoneList, readPhoneNumber } from "../lib/phone-list.ts";

const read = (raw) => readPhoneNumber(raw, UAE);

test("UAE numbers in every common form", () => {
  for (const raw of ["+971 50 123 4567", "00971501234567", "971501234567"]) {
    assert.deepEqual(read(raw), { waId: "971501234567", corrected: false });
  }
  for (const raw of ["050 123 4567", "0501234567", "50-123-4567", "(050) 123.4567"]) {
    assert.deepEqual(read(raw), { waId: "971501234567", corrected: true });
  }
});

test("Arabic-Indic digits are read as digits", () => {
  assert.deepEqual(read("٠٥٠١٢٣٤٥٦٧"), { waId: "971501234567", corrected: true });
});

test("Excel's shortened numbers are refused with a reason", () => {
  assert.match(read("9.71501E+11").error, /Excel shortened/);
});

test("too short, too long and letters are refused", () => {
  assert.ok("error" in read("12345"));
  assert.ok("error" in read("+9715012345678901"));
  assert.ok("error" in read("call me"));
});

test("a list: names, separators, duplicates, known customers", () => {
  const rows = readPhoneList(
    "Name,Phone\nAhmed 050 123 4567\n+971 55 987 6543 Sara; 0521112222\n\n+971501234567\nnobody here",
    UAE,
    new Set(["971521112222"])
  );
  assert.deepEqual(
    rows.map((r) => [r.name, r.waId, r.outcome]),
    [
      ["Ahmed", "971501234567", "corrected"],
      ["Sara", "971559876543", "ready"],
      [null, "971521112222", "known"],
      [null, "971501234567", "duplicate"],
      [null, null, "refused"],
    ]
  );
  assert.equal(rows[0].note, "050 123 4567 → +971 50 123 4567");
  assert.deepEqual(countOutcomes(rows), { ready: 1, corrected: 1, known: 1, duplicate: 1, refused: 1 });
});

test("another country completes local numbers with its own code", () => {
  const india = COUNTRIES.find((c) => c.code === "IN");
  assert.deepEqual(readPhoneNumber("09876543210", india), { waId: "919876543210", corrected: true });
});

test("the add tab asks for consent and sends only usable rows", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../app/deck/bulk/add-numbers.tsx", import.meta.url), "utf8");
  assert.match(src, /These people agreed to get WhatsApp messages from \{businessName\}/);
  assert.match(src, /disabled=\{[^}]*!consent/);
  assert.match(src, /outcome === "ready" \|\| row\.outcome === "corrected"/);
  assert.match(src, /readPhoneList\(/);
});

test("the client list can show only the numbers just added", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../app/deck/my-campaigns/clients-tab.tsx", import.meta.url), "utf8");
  assert.match(src, /justAdded\?: Set<string>/);
  assert.match(src, /Just added/);
});

test("the AI writer drafts and changes text through the bulk routes, previewed with a real first name", async () => {
  const { readFileSync } = await import("node:fs");
  const writer = readFileSync(new URL("../app/deck/bulk/ai-writer.tsx", import.meta.url), "utf8");
  assert.match(writer, /writeBulkDrafts\(/);
  assert.match(writer, /rewriteBulkDraft\(/);
  assert.match(writer, /previewTemplate\(draft, sampleName\)/);
  assert.match(writer, /maxLength=\{500\}/);
  assert.match(writer, /Writing 3 drafts…/);
  const quick = readFileSync(new URL("../app/deck/my-campaigns/quick-message.tsx", import.meta.url), "utf8");
  assert.match(quick, /assist\?: \(put: \(text: string\) => void, current: string\) => ReactNode/);
});

test("a new approved message is written, sent for approval, watched and fixed from the page", async () => {
  const { readFileSync } = await import("node:fs");
  const panel = readFileSync(new URL("../app/deck/bulk/new-approved.tsx", import.meta.url), "utf8");
  assert.match(panel, /submitBulkTemplate\(/);
  assert.match(panel, /refreshBulkTemplates\(/);
  assert.match(panel, /<AiWriter[\s\S]{0,120}kind="approved"/);
  assert.match(panel, /Waiting for WhatsApp/);
  assert.match(panel, /Ask AI to fix it/);
  assert.match(panel, /maxLength=\{1024\}/);
  const page = readFileSync(new URL("../app/deck/bulk/page.tsx", import.meta.url), "utf8");
  assert.match(page, /<NewApproved/);
  // Opening a number with messages waiting asks WhatsApp once, by itself.
  assert.match(page, /pending\?\.length[\s\S]{0,200}refreshBulkTemplates\(/);
});

test("a spreadsheet becomes lines as it was written, so Excel's shortened numbers are refused", () => {
  // The reader already expands numeric cells in full; a TEXT cell holding
  // "9.71501E+11" has lost its digits and must be refused, never expanded
  // into 971501000000 — a stranger's number.
  const lines = gridToLines([["Name", "Mobile"], ["Ahmed", "971501234567"], ["Sara", "9.71501E+11"], ["", ""]]);
  assert.equal(lines, ["Ahmed 971501234567", "Sara 9.71501E+11"].join("\n"));
  const rows = readPhoneList(lines, UAE, new Set());
  assert.deepEqual(rows.map((r) => r.outcome), ["ready", "refused"]);
  assert.match(rows[1].note, /Excel shortened/);
  // No number column recognised: every row, every cell, as typed.
  assert.equal(gridToLines([["0501234567", "Ahmed"]]), "0501234567 Ahmed");
});

test("a 0 kept after the country code is dropped and shown, or the number is refused", () => {
  assert.deepEqual(read("+971 050 123 4567"), { waId: "971501234567", corrected: true });
  assert.deepEqual(read("00971 04 123 4567"), { waId: "97141234567", corrected: true });
  assert.deepEqual(read("9710501234567"), { waId: "971501234567", corrected: true });
  assert.ok("error" in read("+971 5012345"));
  // A country this list does not know keeps the plain length rule.
  assert.deepEqual(read("+86 173 6786 6817"), { waId: "8617367866817", corrected: false });
  const rows = readPhoneList("+971 050 123 4567", UAE, new Set());
  assert.equal(rows[0].outcome, "corrected");
  assert.equal(rows[0].note, "+971 050 123 4567 → +971 50 123 4567");
});

test("a new approved message has one language, shared by the writer and the submission", async () => {
  const { readFileSync } = await import("node:fs");
  const writer = readFileSync(new URL("../app/deck/bulk/ai-writer.tsx", import.meta.url), "utf8");
  assert.match(writer, /language\?: "en" \| "ar"/);
  assert.match(writer, /onLanguageChange\?\.\("ar"\)/);
  const panel = readFileSync(new URL("../app/deck/bulk/new-approved.tsx", import.meta.url), "utf8");
  assert.match(panel, /<AiWriter[\s\S]{0,200}language=\{language\}[\s\S]{0,80}onLanguageChange=\{setLanguage\}/);
});
