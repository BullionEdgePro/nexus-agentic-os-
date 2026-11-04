/**
 * A phone reaches every door (audit, 4 Nov 2026).
 *
 * Under 760px a staff phone hides the dock for its four tabs (Queue, Team,
 * Follow-ups, Me) — and the only Sign out, the Search button, My settings,
 * Connections, Board, Knowledge and Workflow lived in that dock. On a shared
 * phone the next person stayed signed in as the last. A Menu button in the phone
 * toolbar now opens every page the dock would offer that person, with Search and
 * Sign out, from the dock's own list so the two can never disagree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const SHELL = read("app/console-shell.tsx");

test("the phone toolbar carries a menu for staff", () => {
  const tools = SHELL.slice(SHELL.indexOf('<div className="shell-phone-tools">'), SHELL.indexOf('<div className="shell-phone-tools">') + 400);
  assert.match(tools, /<PhoneMenu items=\{visibleNav\("employee", me\?\.organizationSlug \?\? null\)/);
});

test("the menu offers search and sign-out alongside the pages", () => {
  const menu = read("app/phone-menu.tsx");
  assert.match(menu, /href="\/api\/auth\/logout"/);
  assert.match(menu, /new Event\("nexus:open-search"\)/);
  assert.match(menu, /items\.map\(/);
});

test("the dock and the phone menu share one list", () => {
  assert.match(SHELL, /export function visibleNav\(/);
  const rail = SHELL.slice(SHELL.indexOf("export function RailLinks("), SHELL.indexOf("export function RailLinks(") + 1500);
  assert.match(rail, /const visible = visibleNav\(role, mySlug\);/);
});
