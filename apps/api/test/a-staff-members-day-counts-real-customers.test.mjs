// A staff member's "Waiting for you" counts the same customers the admin sees.
//
// FOUND 24 OCT 2026 checking the staff home after the mailbox cleanup: Staff
// work left out senders marked "not a customer" and cold pitches, but the staff
// member's own My Day did not — the same person was "3 waiting" to the admin
// and "10 waiting" to themselves. And 10 was a ceiling, not a count: the query
// fetched ten rows and the counter counted the rows, so thirty people waiting
// read as ten. An email sender with no name printed as "+null".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");
const MY_DAY = read("apps", "api", "src", "routes", "my-day.ts");
const waitingQuery = MY_DAY.slice(MY_DAY.indexOf("async function waitingOnMe"));

test("a sender marked not a customer is never waiting on a staff member", () => {
  assert.match(waitingQuery, /ct\.not_a_customer_at is null/);
});

test("a pitch is not a customer waiting, by the same check Staff work uses", () => {
  assert.match(MY_DAY, /looksLikeAnInboundPitch/);
  assert.match(waitingQuery, /la\.category = 'inbound_pitch'/);
});

test("the count is every customer waiting, not the length of the list shown", () => {
  assert.doesNotMatch(MY_DAY, /waiting: waiting\.length/);
  assert.match(MY_DAY, /waiting: waiting\.slice\(0, 10\)/);
});

test("a nameless email sender shows their address, never '+null'", () => {
  assert.match(waitingQuery, /coalesce\(ct\.display_name, ct\.external_id\)/);
  const DAY = read("apps", "web", "app", "my-day.tsx");
  assert.doesNotMatch(DAY, /`\+\$\{row\.waId\}`/);
});
