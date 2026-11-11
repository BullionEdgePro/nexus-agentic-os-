/**
 * Bulk starts afresh for each business (11 Nov 2026).
 *
 * The owner switched Bulk from Zipicka to SFS International and read, in red,
 * "That number is not one of this business's connected numbers." -- with SFS's
 * own number connected and working right beneath it. The page had kept the
 * number chosen for the business before and asked the server about it under
 * the new one (/api/bulk/sfs-international/number/<Zipicka's number> -> 422);
 * when that refusal came back before SFS's own list did, it stayed on screen.
 *
 * Everything chosen for one business -- its number, customers, message and any
 * error -- now lives in a part of the page that is built anew for the next, so
 * nothing chosen for one business can be asked of, or shown under, another.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../app/deck/bulk/page.tsx", import.meta.url), "utf8");

/** One top-level function of the page: from its declaration to the next one. */
function partOf(declaration) {
  const from = page.indexOf(declaration);
  assert.notEqual(from, -1, `${declaration} is in the page`);
  const next = page.indexOf("\nfunction ", from + declaration.length);
  return page.slice(from, next === -1 ? page.length : next);
}

test("switching business rebuilds everything under the tabs", () => {
  const shell = partOf("export default function BulkMessagingPage(");
  assert.match(shell, /<BulkFor key=\{business\} business=\{business\} \/>/);
});

test("the part that only switches business keeps no number, customers or error of its own", () => {
  const shell = partOf("export default function BulkMessagingPage(");
  assert.doesNotMatch(shell, /numberId|getBulkNumber|getBulkOverview|setView|setPicked|setError/);
});

test("the number is chosen and read inside the part built for that one business", () => {
  const forOne = partOf("function BulkFor(");
  assert.match(forOne, /const \[numberId, setNumberId\] = useState\(""\)/);
  assert.match(forOne, /getBulkNumber\(business, numberId\)/);
  assert.match(forOne, /if \(!numberId\) return;/);
});
