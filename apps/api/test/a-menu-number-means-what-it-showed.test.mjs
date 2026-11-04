// A menu number means what the menu showed (audit, 4 Nov 2026).
//
// On a shared number a customer who wrote "legal" got a narrowed menu --
// "1. ABR Advocates  2. Juris Prime Legal" -- but their reply was read against
// the FULL list of businesses, so "2" picked the second business overall, and
// routing then stuck: the wrong business's agent answered for the rest of the
// chat. The menu is not stored, so the numbers are now the businesses' places in
// the full list ("2. ABR …  4. Juris Prime Legal") and any reply reads true.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { buildTriageMessage, resolveTriageReply } = await import("../../../packages/agents/src/business-router.ts");

const ALL = [
  { id: "z", slug: "zipicka", name: "Zipicka", routingKeywords: [] },
  { id: "a", slug: "abr", name: "ABR Advocates", routingKeywords: [] },
  { id: "j", slug: "juris-prime", name: "Juris Prime", routingKeywords: [] },
  { id: "l", slug: "juris-prime-legal", name: "Juris Prime Legal", routingKeywords: [] },
  { id: "s", slug: "sfs-international", name: "SFS International", routingKeywords: [] },
];
const LEGAL = [ALL[1], ALL[3]];

test("a narrowed menu numbers each business by its place in the full list", () => {
  const menu = buildTriageMessage(LEGAL, "legal", ALL);
  assert.match(menu, /^2\. ABR Advocates/m);
  assert.match(menu, /^4\. Juris Prime Legal/m);
  assert.doesNotMatch(menu, /^1\. /m);
});

test("and the number the customer replies with is the business they saw", () => {
  const menu = buildTriageMessage(LEGAL, "legal", ALL);
  const shown = /^(\d)\. Juris Prime Legal/m.exec(menu)[1];
  assert.equal(resolveTriageReply(shown, ALL)?.slug, "juris-prime-legal");
});

test("the processor gives the menu the full list to number from", () => {
  const processor = readFileSync(new URL("../src/queue/processor.ts", import.meta.url), "utf8");
  assert.match(processor, /await askWhichBusiness\(ctx, asked, businesses\);/);
  assert.match(processor, /buildTriageMessage\(businesses, ctx\.text, numberedFrom\)/);
});
