// Customer lists (migration 093; DoubleTick: Segmentation Studio), and the two
// audience defects found while building them: operator broadcasts messaged
// opted-out contacts, and queued contacts with no WhatsApp number.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normaliseSegmentFilter } from "../../../packages/db/src/segments.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const SEG = read("packages", "db", "src", "segments.ts");
const BSQL = read("packages", "db", "src", "broadcasts.ts");
const BROUTE = read("apps", "api", "src", "routes", "broadcasts.ts");
const OROUTE = read("apps", "api", "src", "routes", "organizations.ts");
const MIGRATION = read("packages", "db", "migrations", "093-a-list-that-keeps-itself.sql");
const CLIENT = read("packages", "db", "src", "client.ts");

test("no list can reach an opted-out contact, one with no number, or another business's", () => {
  const base = SEG.slice(SEG.indexOf("function whereFor"), SEG.indexOf("export async function segmentContacts"));
  assert.match(base, /contactServedBy\("\$1"\)/);
  assert.match(base, /"ct\.reengagement_opted_out = false"/);
  assert.match(base, /"coalesce\(ct\.wa_id, ''\) <> ''"/);
  assert.ok(!/organization_id = \$1/.test(base.replace(/routed_organization_id, c\.organization_id\) = \$1/g, "")));
});

test("the everyone-audience now keeps the same two rules", () => {
  const fn = BSQL.slice(BSQL.indexOf("export async function getContactsForAudience"), BSQL.indexOf("export async function createBroadcastRecipients"));
  assert.match(fn, /ct\.reengagement_opted_out = false/);
  assert.match(fn, /coalesce\(ct\.wa_id, ''\) <> ''/);
});

test("a campaign is evaluated at send, and refuses if its list is gone", () => {
  const send = BROUTE.slice(BROUTE.indexOf('broadcastsRoute.post("/:id/send"'));
  assert.match(send, /\["\$segment"\]/);
  assert.match(send, /segmentContacts\(broadcast\.organizationId, segment\.filter\)/);
  assert.match(send, /has been deleted\. Nothing was sent\./);
  // A draft for a list may only name this business's own list.
  const create = BROUTE.slice(BROUTE.indexOf('broadcastsRoute.post("/"'), BROUTE.indexOf('broadcastsRoute.post("/:id/send"'));
  assert.match(create, /getSegment\(organization\.id, body\.segmentId\)/);
});

test("lists are the owner's, and their table is protected", () => {
  for (const route of ['"/:slug/segments"', '"/:slug/segments/preview"', '"/:slug/segments/:segmentId"']) {
    const at = OROUTE.indexOf(route);
    assert.ok(at > -1, `${route} is missing`);
    assert.match(OROUTE.slice(at, at + 200), /if \(!ownerOnly\(c\)\)/);
  }
  assert.match(MIGRATION, /alter table contact_segments enable row level security/);
  assert.match(MIGRATION, /create policy contact_segments_tenant_isolation on contact_segments/);
  assert.ok(CLIENT.includes('"contact_segments",'));
});

test("only filters the evaluator understands are ever stored", () => {
  const f = normaliseSegmentFilter({
    tags: ["VIP", " VIP ", "", 7],
    stages: ["Qualified"],
    activeWithinDays: "30",
    quietForDays: -4,
    minScore: 250,
    dropTable: "contacts",
    field: { key: "city", value: "Dubai" },
  });
  assert.deepEqual(f, { tags: ["VIP"], stages: ["Qualified"], activeWithinDays: 30, field: { key: "city", value: "Dubai" } });
});
