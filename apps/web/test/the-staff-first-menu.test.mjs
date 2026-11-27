/**
 * Staff-first compact Nexus, piece 6 (27 Nov 2026): the staff menu fits a 768px laptop (daily doors
 * in view, AI agent / Insights / You under "More", tighter rows), the phone Menu reads like the rail,
 * and the home tab says Today.
 * Spec: docs/superpowers/specs/2026-11-27-staff-first-menu-design.md
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as nav from "@/lib/nav";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const items = (...hrefs) => hrefs.map((href) => ({ href }));
const titles = (sections) => sections.map((s) => s.title);

// ---- Task 1: the sections and the staff More fold --------------------------------------------------

test("railSections: Home, Work and People stay in view; the rest go under More", () => {
  const { railSections, MORE_GROUPS } = nav;
  assert.equal(typeof railSections, "function", "lib/nav exports no railSections");
  assert.deepEqual(MORE_GROUPS, ["Grow", "AI agent", "Insights", "Admin", "You"]);
  const staff = railSections(
    items("/", "/inbox", "/deck/tasks", "/deck/customers", "/deck/knowledge", "/deck/forecast", "/deck/my-settings"),
  );
  assert.deepEqual(titles(staff.main), ["Home", "Work", "People"]);
  assert.deepEqual(titles(staff.more), ["AI agent", "Insights", "You"]);
  assert.deepEqual(staff.more[0].items.map((i) => i.href), ["/deck/knowledge"]);
});

test("railSections: an admin's menu folds the same way (27 Nov 2026, owner: \"admin too\")", () => {
  const { railSections } = nav;
  const admin = railSections(
    items("/", "/inbox", "/deck/tasks", "/deck/activity", "/deck/bulk", "/deck/knowledge", "/deck/quality", "/deck/hq", "/deck/notifications"),
  );
  assert.deepEqual(titles(admin.main), ["Home", "Work", "People"]);
  assert.deepEqual(titles(admin.more), ["Grow", "AI agent", "Insights", "Admin", "You"]);
});

test("railSections: empty sections drop; a stray door still shows", () => {
  const { railSections } = nav;
  assert.deepEqual(titles(railSections(items("/", "/deck/hq")).main), ["Home"]);
  // A door no section claims is never lost: it joins the main run under no heading.
  const stray = railSections(items("/", "/deck/somewhere-new"));
  assert.deepEqual(stray.main.at(-1), { title: "", items: [{ href: "/deck/somewhere-new" }] });
});

test("moreStartsOpen: open on arrival only when the current page is one of More's doors", () => {
  const { railSections, moreStartsOpen } = nav;
  const { more } = railSections(items("/", "/deck/knowledge", "/deck/my-settings"));
  assert.equal(moreStartsOpen(more, "/deck/knowledge"), true);
  assert.equal(moreStartsOpen(more, "/deck/my-settings"), true);
  assert.equal(moreStartsOpen(more, "/"), false);
});

test("the rail draws a More button, remembers it safely, and opens it on a More page", () => {
  const S = read("app/console-shell.tsx");
  assert.match(S, /railSections\(visible\)/);
  assert.match(S, /<button\s+type="button"\s+className="rail-more"\s+aria-expanded=\{moreOpen\}/);
  assert.match(S, /moreStartsOpen\(/);
  // Storage can throw (private windows, blocked site data): every touch in the rail's links is guarded.
  const start = S.indexOf("export function RailLinks");
  const rail = S.slice(start, S.indexOf("\nfunction ", start));
  const storage = rail.split("localStorage").length - 1;
  const guarded = (rail.match(/try \{[^}]*localStorage/g) ?? []).length;
  assert.ok(storage >= 2 && guarded === storage, `localStorage used ${storage}× but guarded ${guarded}×`);
});

// ---- Task 2: the phone Menu and the Today tab --------------------------------------------------------

test("the phone Menu reads like the rail: its sections, in order, each door with its tile", () => {
  const M = read("app/phone-menu.tsx");
  assert.match(M, /railSections\(items\)/);
  assert.match(M, /\[\.\.\.main, \.\.\.more\]/, "the Menu does not show every section");
  assert.match(M, /className="pmenu-group"/);
  assert.match(M, /<span className="rail-icon" data-tone=\{toneOf\(item\.href\)\}>\{item\.icon\}<\/span>/);
  const css = read("app/phone-menu.css");
  assert.match(css, /\.pmenu-links \{[^}]*grid-template-columns: 1fr 1fr;/, "not two to a row");
  // The tab bar and Ask sit over the sheet's bottom; the last doors must scroll clear of them.
  assert.match(css, /\.pmenu-sheet \{[^}]*padding: 16px 16px calc\(96px \+ env\(safe-area-inset-bottom\)\);/);
});

test("the home tab says Today, not Me", () => {
  const T = read("app/mobile-tabs.tsx");
  assert.match(T, /\{ href: "\/", label: "Today",/);
  assert.doesNotMatch(T, /label: "Me"/);
});

test("tighter rows: 38px links, 28px tiles, slimmer section headings", () => {
  const css = read("app/console-shell.css");
  assert.match(css, /\.deck-root\.shell \.shell-rail a:not\(\.rail-brand\) \{[^}]*padding: 5px 12px;/);
  assert.match(css, /\.deck-root\.shell \.rail-icon \{[^}]*flex: 0 0 28px;[^}]*width: 28px;[^}]*height: 28px;/);
  assert.match(css, /\.deck-root\.shell \.rail-group \{[^}]*padding: 9px 12px 3px;/);
  assert.match(css, /\.deck-root\.shell \.rail-more \{/);
});
