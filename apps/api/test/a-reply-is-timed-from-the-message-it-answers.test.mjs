// Per-staff response times (DoubleTick: team performance). Pinned as text: the
// correctness is in which rows count and who they are credited to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const SQL = read("packages", "db", "src", "response-times.ts");
const ROUTE = read("apps", "api", "src", "routes", "activity.ts");
const INDEX = read("apps", "api", "src", "index.ts");
const PAGE = read("apps", "web", "app", "deck", "activity", "page.tsx");
const SECTION = read("apps", "web", "app", "deck", "activity", "response-times.tsx");

test("only a person's replies are timed, never the AI's", () => {
  // AI replies carry the ASSIGNED employee in employee_id; without this filter a
  // person would be credited with the machine's speed.
  assert.match(SQL, /m\.sender_type = 'human_agent'/);
  assert.match(SQL, /coalesce\(m\.employee_id::text, m\.sender_id\) as staff_id/);
});

test("a reply is timed from the earliest unanswered customer message", () => {
  assert.match(SQL, /select min\(i\.created_at\)[\s\S]*i\.direction = 'inbound'/);
  assert.match(SQL, /select max\(o\.created_at\) from messages o[\s\S]*o\.direction = 'outbound'/);
});

test("scoped to the business the customer was talking to", () => {
  assert.match(SQL, /m\.serving_organization_id = \$1::uuid/);
  assert.ok(!/m\.organization_id = \$1/.test(SQL), "the number owner's id would count routed traffic against it");
});

test("replies from before attribution are reported, not dropped", () => {
  assert.match(SQL, /Not attributed \(sent before 28 Sep\)/);
});

test("operator-only, like the rest of /api/activity", () => {
  assert.match(ROUTE, /activityRoute\.get\("\/response-times"/);
  assert.match(INDEX, /app\.use\("\/api\/activity\/\*", operatorOnly\)/);
  assert.match(ROUTE, /PERIODS\.has\(days\)/);
});

test("the section has its own failure, and does not blank the roster", () => {
  assert.match(PAGE, /<ResponseTimes business=\{business\} \/>/);
  assert.match(SECTION, /setFailed\(readableError\(err/);
  assert.match(SECTION, /getResponseTimes\(period, slug \|\| undefined\)/);
});
