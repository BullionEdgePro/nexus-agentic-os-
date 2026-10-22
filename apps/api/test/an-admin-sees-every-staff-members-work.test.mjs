// An admin sees every staff member's work — every chat, email and social
// message, and everything they did in Nexus (the owner, 22 Oct 2026).
//
// The page it replaces ("Team activity") was a table of counts. Staff work is
// per person: their channels, their chats on every channel, the customers
// waiting on them, the replies they sent (from Nexus AND from their phone),
// and a timeline of what they did. It is the admin's only: staff see their own
// work and nobody else's (a-staff-member-sees-only-their-own).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { staffStatus } from "@nexus/db";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");
const ROUTE = read("apps", "api", "src", "routes", "activity.ts");
const DB = read("packages", "db", "src", "staff-work.ts");
const INDEX = read("apps", "api", "src", "index.ts");
const PAGE = read("apps", "web", "app", "deck", "activity", "page.tsx");

const now = new Date("2026-10-22T12:00:00Z");
const ago = (minutes) => new Date(now.getTime() - minutes * 60_000).toISOString();

test("someone seen in the last ten minutes is online", () => {
  assert.equal(staffStatus({ lastActiveAt: ago(4), lastLoginAt: ago(600), now }), "online");
});

test("someone seen earlier is away", () => {
  assert.equal(staffStatus({ lastActiveAt: ago(90), lastLoginAt: ago(600), now }), "away");
});

test("someone who never signed in says so, rather than looking idle", () => {
  assert.equal(staffStatus({ lastActiveAt: null, lastLoginAt: null, now }), "never-signed-in");
});

test("both views are served under /api/activity, which is the admin's", () => {
  assert.match(ROUTE, /activityRoute\.get\("\/staff-work"/);
  assert.match(ROUTE, /activityRoute\.get\("\/staff-work\/:employeeId"/);
  assert.match(INDEX, /app\.use\("\/api\/activity\/\*", operatorOnly\)/);
});

test("a reply counts whether it was sent from Nexus or typed on the phone", () => {
  // From Nexus: sender_id is the employee. From the phone (a WhatsApp echo):
  // employee_id is set. Either one is that person's reply.
  assert.match(DB, /m\.sender_type = 'human_agent'/);
  assert.match(DB, /m\.employee_id = e\.id or m\.sender_id = e\.id::text/);
});

test("a customer is waiting when the latest message in their chat is theirs", () => {
  assert.match(DB, /last_direction = 'inbound'/);
});

test("a chat that belongs to nobody is counted for the admin to assign", () => {
  assert.match(DB, /c\.employee_id is null/);
});

test("every query runs across businesses on purpose, and says so", () => {
  const exported = DB.match(/export async function \w+/g) ?? [];
  assert.ok(exported.length >= 2);
  assert.equal((DB.match(/withAllTenants\(/g) ?? []).length >= exported.length, true);
});

test("the page shows people, attention, their chats and their timeline", () => {
  assert.match(PAGE, /getStaffWork\(/);
  assert.match(PAGE, /getStaffMemberWork\(/);
  assert.match(PAGE, /Needs your attention/);
  assert.match(PAGE, /What they did/);
});

test("FOUND ON SCREEN: a sales pitch is not a customer kept waiting", () => {
  // The first live render listed "Harmowiy digital1", "Debby Ecom21" and
  // "Ridof Digital Team" — store-growth pitches in Ralph's mailbox — as
  // customers waiting 24 days. The customer-waiting operator already knows
  // a pitch (looksLikeAnInboundPitch); Staff work now asks the same rule.
  assert.match(ROUTE, /staffWorkOverview\(organizationId, looksLikeAnInboundPitch\)/);
  assert.match(ROUTE, /staffMemberWork\(c\.req\.param\("employeeId"\), looksLikeAnInboundPitch\)/);
  assert.match(DB, /la\.category = 'inbound_pitch'/);
  assert.match(DB, /isPitch\(/);
});

test("FOUND ON SCREEN: someone who signed in is not 'active never'", () => {
  assert.match(DB, /r\.last_login_at\]/);
});
