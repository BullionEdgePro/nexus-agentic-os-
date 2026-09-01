// A staff member's self-reported socials — a directory, not a connection.
//
// The trap this file guards is the same one the rota had: jsonb accepts any
// shape, so a mistyped row stores cleanly and reads back as nonsense. And a
// second, quieter one: this must stay a plain list and never grow a token —
// connecting an account is social_connections, a different thing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseSocialAccounts } from "@nexus/employees";
import { SOCIAL_PLATFORMS } from "@nexus/shared";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");
const MY_DESK = read("apps", "api", "src", "routes", "my-desk.ts");
const PANEL = read("apps", "web", "app", "deck", "my-clients", "social-accounts.tsx");

test("a normal list is accepted and normalised", () => {
  const result = parseSocialAccounts([
    { platform: "Instagram", label: "  @zipicka  ", url: "instagram.com/zipicka" },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.accounts[0].platform, "instagram"); // lowercased
  assert.equal(result.accounts[0].label, "@zipicka"); // trimmed
  // A bare host is upgraded to a real URL rather than refused.
  assert.match(result.accounts[0].url, /^https:\/\/instagram\.com\/zipicka/);
});

test("empty and missing input are the empty list, not an error", () => {
  assert.deepEqual(parseSocialAccounts(undefined), { ok: true, errors: [], accounts: [] });
  assert.deepEqual(parseSocialAccounts([]), { ok: true, errors: [], accounts: [] });
});

test("an unknown platform is refused, naming the row", () => {
  const result = parseSocialAccounts([{ platform: "myspace", label: "x" }]);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /Row 1/);
  assert.match(result.errors[0], /not a platform/);
});

test("a row with no name is refused", () => {
  const result = parseSocialAccounts([{ platform: "tiktok", label: "   " }]);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /name or handle/);
});

test("a url that is not a link is refused, but a blank url is fine", () => {
  assert.equal(parseSocialAccounts([{ platform: "x", label: "me", url: "not a url" }]).ok, false);
  assert.equal(parseSocialAccounts([{ platform: "x", label: "me", url: "" }]).ok, true);
});

test("the list is capped so nobody pastes a novel", () => {
  const many = Array.from({ length: 26 }, () => ({ platform: "other", label: "x" }));
  assert.equal(parseSocialAccounts(many).ok, false);
});

test("the platform set covers the socials staff actually use", () => {
  for (const p of ["instagram", "facebook", "tiktok"]) assert.ok(SOCIAL_PLATFORMS.includes(p));
});

test("the endpoint is self-scoped — edits only the caller's own list", () => {
  // Keyed off the session (deskOf), never an employee id from the request, so a
  // staff member cannot touch a colleague's directory.
  assert.match(MY_DESK, /myDeskRoute\.get\("\/social-accounts"/);
  assert.match(MY_DESK, /myDeskRoute\.patch\("\/social-accounts"/);
  const patch = MY_DESK.slice(MY_DESK.indexOf('myDeskRoute.patch("/social-accounts"'));
  const body = patch.slice(0, patch.indexOf("\n});"));
  assert.match(body, /const desk = deskOf\(c\)/);
  assert.match(body, /updateEmployeeSocialAccounts\(desk\.employeeId/);
  assert.match(body, /parseSocialAccounts\(body\.accounts\)/);
  assert.ok(!/param\("employeeId"\)/.test(body), "reads an employee id from the request instead of the session");
});

test("it stays a directory — no token, no message reading", () => {
  // The whole point: this never becomes a connection. The panel says so, and
  // nothing here touches social_connections or a token.
  assert.match(PANEL, /does not connect anything or read your messages/i);
  assert.ok(!/accessToken|connectionSecret|oauth/i.test(PANEL), "the directory panel touched a token path");
});

// ============================================================
// The business-level twin (org social accounts, owner-set)
// ============================================================

const ORG_ROUTE = read("apps", "api", "src", "routes", "organizations.ts");

test("a business's social accounts are operator-only to write", () => {
  // Staff record their OWN on /api/my/social-accounts; the company's public
  // pages are the owner's to set. The write refuses a non-operator.
  assert.match(ORG_ROUTE, /organizationsRoute\.patch\("\/:slug\/social-accounts"/);
  const patch = ORG_ROUTE.slice(ORG_ROUTE.indexOf('organizationsRoute.patch("/:slug/social-accounts"'));
  const body = patch.slice(0, patch.indexOf("\n});"));
  assert.match(body, /scope\?\.role !== "operator"/);
  assert.match(body, /403/);
  // Same validator as the staff directory — one check for both levels.
  assert.match(body, /parseSocialAccounts\(body\.accounts\)/);
  assert.match(body, /updateOrganizationSocialAccounts\(organization\.id/);
});

test("reading a business's social accounts is allowed to anyone scoped to it", () => {
  // A staff member can see where the company is online; only writing is gated.
  assert.match(ORG_ROUTE, /organizationsRoute\.get\("\/:slug\/social-accounts"/);
  const get = ORG_ROUTE.slice(ORG_ROUTE.indexOf('organizationsRoute.get("/:slug/social-accounts"'));
  const body = get.slice(0, get.indexOf("\n});"));
  assert.ok(!/role !== "operator"/.test(body), "the read is gated to operators");
});

// ============================================================
// The owner SEES staff handles (read-only), never edits them
// ============================================================

test("the team listing carries each member's own social accounts", () => {
  // Already flows through: EMPLOYEE_COLUMNS includes social_accounts, toEmployee
  // maps it, and the route spreads ...employee. So the owner's roster has the
  // handles without a second call.
  const DB = read("packages", "db", "src", "employees.ts");
  assert.match(DB, /social_accounts,/); // in EMPLOYEE_COLUMNS
  assert.match(DB, /socialAccounts: row\.social_accounts \?\? \[\]/);
});

test("the owner's view of staff handles is read-only", () => {
  // The person edits their own on their deck; the owner only looks. The team
  // panel shows the list but offers no save/edit control for it, and points the
  // owner at where the staff member sets them.
  const TEAM = read("apps", "web", "app", "deck", "team", "team-workspace.tsx");
  const start = TEAM.indexOf('className="team-socials"');
  // Bound to the panel itself: up to the empty-state paragraph that closes it,
  // so the slice never runs into the "Add someone" form below (which has its
  // own onChange handlers).
  const block = TEAM.slice(start, TEAM.indexOf("team-socials-empty", start) + 200);
  assert.match(block, /Their social accounts/);
  assert.match(block, /My clients &rarr; Your social accounts/);
  assert.ok(!/saveMySocialAccounts|saveBusinessSocialAccounts|onChange=/.test(block), "the read-only staff-socials view grew an edit control");
});
