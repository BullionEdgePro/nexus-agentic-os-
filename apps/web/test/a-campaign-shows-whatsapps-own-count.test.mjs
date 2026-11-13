/**
 * A campaign shows WhatsApp's own count (13 Nov 2026).
 *
 * The first SFS campaign reached about 150 phones and cost AED 32.89 by Meta's
 * dashboard; Nexus, given four delivery receipts, said "Delivered 4", and could
 * not say what it cost. The owner asked both, more than once. Under a recent
 * campaign's Delivered figure the page now says what WhatsApp itself counted,
 * and what it charged -- and says nothing when WhatsApp gave no answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { whatsAppCountLine } from "../lib/whatsapp-count.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("it says how many WhatsApp counts as delivered, and about what it charged", () => {
  assert.equal(whatsAppCountLine({ delivered: 150, cost: 32.89, currency: "AED" }), "WhatsApp counts 150 delivered · about AED 32.89");
});

test("money always reads to the cent", () => {
  assert.equal(whatsAppCountLine({ delivered: 12, cost: 2.5, currency: "USD" }), "WhatsApp counts 12 delivered · about USD 2.50");
});

test("when WhatsApp keeps the charge to itself, the line says where the cost is", () => {
  // Meta will not give charges to a partner app for a customer's account (live,
  // 13 Nov 2026: "COST is not shown for businesses who bill through a partner"),
  // which is every number connected from Nexus. The owner asked what the campaign
  // cost, twice; the honest answer here is where to look.
  assert.equal(whatsAppCountLine({ delivered: 148, cost: null, currency: "AED" }), "WhatsApp counts 148 delivered · for the cost, see WhatsApp Manager");
  assert.equal(whatsAppCountLine({ delivered: 150, cost: null, currency: null }), "WhatsApp counts 150 delivered · for the cost, see WhatsApp Manager");
  assert.equal(
    whatsAppCountLine({ delivered: 3, cost: 1.2, currency: null }),
    "WhatsApp counts 3 delivered · for the cost, see WhatsApp Manager",
    "a figure with no currency is not money"
  );
});

test("a campaign WhatsApp charged nothing for has no talk of money", () => {
  assert.equal(whatsAppCountLine({ delivered: 3, cost: 0, currency: "AED" }), "WhatsApp counts 3 delivered");
});

test("large counts are grouped as a person writes them", () => {
  assert.equal(whatsAppCountLine({ delivered: 12500, cost: 0, currency: "AED" }), "WhatsApp counts 12,500 delivered");
});

test("the Bulk page asks for the counts apart from its first load, and never shows a failure for them", () => {
  const page = read("app/deck/bulk/page.tsx");
  assert.match(page, /getBulkWhatsAppCounts\(slug\)\s*\.then\(\(data\) => setWhatsAppCounts\(data\.counts\)\)\s*\.catch\(\(\) => undefined\)/);
  assert.match(page, /whatsAppCounts\[campaign\.id\] \? \(\s*<span className="bk-wa-count">\{whatsAppCountLine\(whatsAppCounts\[campaign\.id\]\)\}<\/span>/);
  assert.match(read("lib/api.ts"), /request\(`\/api\/bulk\/\$\{orgSlug\}\/whatsapp-counts`\)/);
});
