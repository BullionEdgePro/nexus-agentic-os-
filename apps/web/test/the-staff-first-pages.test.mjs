/**
 * Staff-first compact Nexus, piece 5 (26 Nov 2026): Customers, My clients, Knowledge and Answer
 * rules. Staff open their own business (four pages asked the server for Zipicka's and were refused
 * for everyone but Zipicka's staff); the list comes first and forms wait behind a button; a phone
 * fits more and scrolls sideways never.
 * Spec: docs/superpowers/specs/2026-11-26-staff-first-pages-design.md
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as tabs from "@/lib/business-tabs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const page = (name) => read(`app/deck/${name}/page.tsx`);

// ---- Task 1: staff open their own business ---------------------------------------------------------

test("pageBusinessFor: wait until known; staff their own; an admin their choice", () => {
  const { pageBusinessFor } = tabs;
  assert.equal(typeof pageBusinessFor, "function", "lib/business-tabs exports no pageBusinessFor");
  const staff = { known: true, isOperator: false, mySlug: "sfs-international" };
  const admin = { known: true, isOperator: true, mySlug: null };
  assert.deepEqual(pageBusinessFor({ known: false, isOperator: false, mySlug: null }, null, "zipicka"), {
    business: "zipicka",
    ready: false,
  });
  assert.deepEqual(pageBusinessFor(staff, null, "zipicka"), { business: "sfs-international", ready: true });
  // Staff can never switch, whatever was chosen.
  assert.deepEqual(pageBusinessFor(staff, "abr", "zipicka"), { business: "sfs-international", ready: true });
  assert.deepEqual(pageBusinessFor(admin, null, "zipicka"), { business: "zipicka", ready: true });
  assert.deepEqual(pageBusinessFor(admin, "abr", "zipicka"), { business: "abr", ready: true });
  // Who is asking could not be read (fails closed: employee, no business) — ask anyway, so the
  // server's own reason and Try again show, rather than an outline that never ends.
  assert.deepEqual(pageBusinessFor({ known: true, isOperator: false, mySlug: null }, null, "zipicka"), {
    business: "zipicka",
    ready: true,
  });
});

test("Customers, Knowledge, Answer rules and Forecast wait to know who is asking, then load theirs", () => {
  for (const name of ["customers", "knowledge", "procedures", "forecast"]) {
    const P = page(name);
    assert.match(P, /usePageBusiness\(/, `${name} does not use usePageBusiness`);
    assert.doesNotMatch(P, /useState<BusinessSlug>\(/, `${name} still starts on a fixed business`);
    assert.match(P, /useEffect\(\(\) => \{\n    if \(!ready\) return;/, `${name} loads before it knows whose business`);
  }
  assert.match(page("procedures"), /\{ready \? <PhrasesSection business=\{business\} \/> : null\}/);
  assert.match(page("customers"), /\{ready \? \(\s*<ImportCustomers/);
});
