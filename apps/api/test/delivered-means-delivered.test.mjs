// The deck had a column headed "Delivered" and no evidence of delivery.
//
// Found on 2026-08-18 by sweeping the deck for claims that are ASSERTED rather
// than measured — the same audit that caught "Checked within the last ten
// minutes" on the operators page earlier the same day.
//
// The number under that heading was `count(*) filter (where status in ('sent',
// 'delivered'))`. `sent` is written the moment the Graph API returns 2xx, and
// 2xx means Meta TOOK the message. Nothing had ever written 'delivered' at all
// until migration 051 wired up the receipts. So the column was a claim about
// receipt built entirely from evidence of acceptance, shown to a business about
// its own campaign.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const BROADCASTS = read("packages", "db", "src", "broadcasts.ts");
const PAGE = read("apps", "web", "app", "deck", "broadcasts", "page.tsx");
const API = read("apps", "web", "lib", "api.ts");

test("accepted and delivered are counted separately", () => {
  // Two facts, two columns. `sent` keeps counting both states because a
  // delivered message was necessarily accepted first — it is the honest ceiling
  // on what a campaign achieved.
  assert.match(BROADCASTS, /filter \(where r\.status in \('sent', 'delivered'\)\)::text as sent/);
  assert.match(BROADCASTS, /filter \(where r\.status = 'delivered'\)::text\s+as delivered/);
  assert.match(API, /delivered: number;/);
});

test("the heading says what the number is", () => {
  // The LAST thead, not the first. This page has two tables — approved templates
  // above, campaigns below — and slicing from the first one tested the wrong
  // header block entirely, which is how this assertion failed on a page that was
  // already correct.
  const head = PAGE.slice(PAGE.lastIndexOf("<thead>"), PAGE.lastIndexOf("</thead>"));
  assert.match(head, /<th>Accepted<\/th>/);
  assert.match(head, /<th>Delivered<\/th>/);

  // The last column showed a DATE under a heading of "Sent", which reads as a
  // count beside four other counts.
  assert.match(head, /<th>Sent on<\/th>/);
});

test("a campaign with no receipts shows unknown, not zero", () => {
  // Every campaign sent before migration 051 has a genuine 0 in this column and
  // an unknown in reality: nothing wrote the state. Printing the zero would
  // turn a gap in the record into a statement that nobody received it — which
  // is a worse lie than the one being fixed, and about the same campaign.
  assert.match(PAGE, /broadcast\.sent > 0 && broadcast\.delivered === 0 \? "—" : broadcast\.delivered/);
});

test("the old conflation cannot come back by relabelling", () => {
  // The specific defect: `sent` rendered under a Delivered heading. Asserted as
  // an ordering so a future edit that swaps the cells is caught too.
  const body = PAGE.slice(PAGE.indexOf("<tbody>"));
  const acceptedAt = body.indexOf("{broadcast.sent}");
  const deliveredAt = body.indexOf("broadcast.delivered ===");
  assert.ok(acceptedAt > 0 && deliveredAt > acceptedAt, "accepted must be rendered before delivered");
});
