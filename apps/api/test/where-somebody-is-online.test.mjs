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
