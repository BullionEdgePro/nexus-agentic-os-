/**
 * Staff-first compact Nexus, piece 1 (26 Nov 2026): one header on every page —
 * the title on one line, the explanation behind an ⓘ (still on the page,
 * hidden until asked) — and My Day, Follow-ups and Appointments content-first.
 * Spec: docs/superpowers/specs/2026-11-26-staff-first-compact-design.md
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, Fragment } from "react";
import * as head from "@/app/kit/page-head";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));

// ---- Task 1: PageHead on every page ---------------------------------------------------------

/** The pages whose header was the plain act-head + act-lede block (spec §4.1). */
const PAGES = [
  "app/deck/agent/page.tsx",
  "app/deck/bookings/page.tsx",
  "app/deck/broadcasts/page.tsx",
  "app/deck/catalogue/page.tsx",
  "app/deck/channels/page.tsx",
  "app/deck/customers/page.tsx",
  "app/deck/forecast/page.tsx",
  "app/deck/knowledge/page.tsx",
  "app/deck/links/page.tsx",
  "app/deck/my-settings/page.tsx",
  "app/deck/notifications/page.tsx",
  "app/deck/operators/page.tsx",
  "app/deck/procedures/page.tsx",
  "app/deck/quality/page.tsx",
  "app/deck/tasks/page.tsx",
  "app/deck/team-chat/page.tsx",
];

test("PageHead: the title on one line, the explanation behind an ⓘ", () => {
  const { PageHead } = head;
  assert.equal(typeof PageHead, "function", "app/kit/page-head exports no PageHead");
  const html = render(PageHead, { title: "Tasks", about: "What a conversation left someone to do." });
  assert.match(html, /<h1>Tasks<\/h1>/);
  assert.match(html, /aria-label="About this page"/);
  assert.match(html, /aria-expanded="false"/);
  const lede = html.match(/<p id="([^"]+)" class="act-lede" hidden="">What a conversation left someone to do\.<\/p>/);
  assert.ok(lede, "the explanation stays on the page, hidden until asked");
  assert.match(html, new RegExp(`aria-controls="${lede[1]}"`));
});

test("PageHead: no ⓘ without an explanation; actions sit on the title's row", () => {
  const { PageHead } = head;
  const html = render(PageHead, { title: "X", children: createElement("button", null, "Refresh") });
  assert.doesNotMatch(html, /About this page/);
  assert.match(html, /<div class="page-actions"><button>Refresh<\/button><\/div>/);
  assert.doesNotMatch(html, /act-lede/);
});

test("PageHead: an explanation with a link stays whole", () => {
  const { PageHead } = head;
  const about = createElement(Fragment, null, "Read ", createElement("a", { href: "/deck/knowledge" }, "Knowledge"), " first.");
  const html = render(PageHead, { title: "Answer rules", about });
  assert.match(html, /class="act-lede" hidden="">Read <a href="\/deck\/knowledge">Knowledge<\/a> first\.<\/p>/);
});

test("every page uses PageHead: no explanation is always on screen", () => {
  const KEEP = new Set([
    "app/kit/page-head.tsx",
    "app/deck/workflow/page.tsx",
    "app/deck/procedures/phrases-section.tsx",
    "app/deck/quality/brain-section.tsx",
  ]);
  const files = readdirSync(new URL("../app", import.meta.url), { recursive: true })
    .map((f) => `app/${String(f).replace(/\\/g, "/")}`)
    .filter((f) => f.endsWith(".tsx"));
  assert.ok(files.includes("app/deck/tasks/page.tsx"));
  for (const f of files) {
    const src = read(f);
    if (!KEEP.has(f)) assert.doesNotMatch(src, /className="act-lede"/, `${f} still shows its explanation on screen`);
    assert.doesNotMatch(src, /<header className="act-head">/, `${f} still has the old header`);
  }
  for (const page of PAGES) assert.match(read(page), /<PageHead\b/, `${page} does not use PageHead`);
});

test("the ⓘ looks like the board's", () => {
  const css = read("app/deck/activity/activity.css");
  assert.match(css, /\.page-about\[aria-expanded="true"\]/);
  assert.match(css, /\.act-titlebar h1 \{[^}]*clamp\(24px, 3vw, 30px\)/);
});

test("the shared header's class is its own: no other stylesheet pulls the ⓘ away from the title", () => {
  // Preview, 26 Nov 2026: `.page-head` was already deck.css's overview header
  // (justify-content: space-between), which threw the ⓘ to the far right.
  const html = render(head.PageHead, { title: "Tasks", about: "x" });
  const cls = html.match(/<header class="act-head ([^"]+)"/)?.[1];
  assert.equal(cls, "act-titlebar");
  const sheets = readdirSync(new URL("../app", import.meta.url), { recursive: true })
    .map((f) => `app/${String(f).replace(/\\/g, "/")}`)
    .filter((f) => f.endsWith(".css") && f !== "app/deck/activity/activity.css");
  for (const f of sheets) assert.doesNotMatch(read(f), new RegExp(`\\.${cls}\\b`), `${f} also styles .${cls}`);
});

// ---- Task 2: Follow-ups and Appointments content-first ---------------------------------------
import * as fold from "@/app/kit/add-fold";
import { AddAppointment } from "@/app/deck/bookings/add-appointment";

test("AddFold: shut it is one button; open it shows the form and Cancel", () => {
  const { AddFold } = fold;
  assert.equal(typeof AddFold, "function", "app/kit/add-fold exports no AddFold");
  const shut = render(AddFold, { label: "Add a follow-up", open: false, onOpenChange() {}, children: createElement("form") });
  assert.match(shut, /<button type="button" class="add-fold-open" aria-expanded="false">\+ Add a follow-up<\/button>/);
  assert.doesNotMatch(shut, /<form|Cancel/);
  const open = render(AddFold, { label: "Add a follow-up", open: true, onOpenChange() {}, children: createElement("form") });
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /<form/);
  assert.match(open, />Cancel</);
});

test("Follow-ups: the form folds, opens on ?add=1, and closes only after a save", () => {
  const page = read("app/deck/tasks/page.tsx");
  assert.match(page, /<AddFold[\s\S]{0,80}label="Add a follow-up"/);
  assert.match(page, /get\("add"\) === "1"/);
  assert.match(page, /await createTask\([\s\S]{0,1400}setAdding\(false\)[\s\S]{0,200}\} catch/);
  assert.doesNotMatch(page, /<h2 className="act-sub-head">Add a follow-up<\/h2>/);
});

test("the counters are one slim strip", () => {
  const css = read("app/deck/tasks/tasks.css");
  assert.match(css, /\.tk-counts \{[^}]*flex-wrap: wrap/);
  assert.match(css, /\.tk-count \{[^}]*display: inline-flex/);
  assert.match(css, /\.tk-count strong \{[^}]*font-size: 1[0-6]px/);
});

test("Appointments: an answer without counts shows zeros, and ?add=1 opens the form", () => {
  const page = read("app/deck/bookings/page.tsx");
  assert.match(page, /setCounts\(data\.counts \?\? /);
  // Preview, 26 Nov 2026: an answer without its list broke the page the same way.
  assert.match(page, /setBookings\(data\.bookings \?\? \[\]\)/);
  assert.match(page, /startOpen=\{/);
  assert.match(page, /get\("add"\) === "1"/);
  // Preview, 26 Nov 2026: a staff member's one business was never chosen here (the
  // tabs only show its name), so "Add an appointment" never appeared for staff.
  assert.match(page, /useVisibleBusinesses\(\)/);
  assert.match(page, /!isOperator && visibleBusinesses\.length === 1 && !business[\s\S]{0,120}setBusiness\(/);
  const html = render(AddAppointment, {
    business: "sfs-international", businessName: "SFS International", timezone: "Asia/Dubai",
    team: [], onCreated() {}, startOpen: true,
  });
  assert.match(html, /<form/);
});

test("a failed save or action says so on Follow-ups and Appointments", () => {
  // Preview, 26 Nov 2026: both pages kept an action's error in state and never drew
  // it, so a follow-up that failed to save, or a Done that failed, looked like nothing.
  for (const page of ["app/deck/tasks/page.tsx", "app/deck/bookings/page.tsx"]) {
    assert.match(read(page), /\{error \? \(?\s*<p className="act-alert" role="alert">\s*\{error\}\s*<\/p>/, `${page} never shows an action's error`);
  }
  assert.match(read("app/deck/activity/activity.css"), /\.act-alert \{[^}]*var\(--crit\)/);
});

// ---- Task 3: My Day compact --------------------------------------------------------------------

test("My Day's shortcuts land ready", () => {
  const day = read("app/my-day.tsx");
  assert.match(day, /href="\/deck\/tasks\?add=1"/);
  assert.match(day, /href="\/deck\/bookings\?add=1"/);
  const chips = (day.match(/className="day-action"/g) ?? []).length;
  assert.ok(chips >= 5);
  assert.equal((day.match(/className="day-action" title=/g) ?? []).length, chips, "every shortcut says what it does on hover");
});

test("My Day is compact: chips that wrap, a smaller greeting, a one-line all-clear", () => {
  const css = read("app/my-day.css");
  assert.match(css, /\.day-actions \{[^}]*flex-wrap: wrap/);
  const h1 = css.match(/\.day-hero h1 \{[^}]*font-size: clamp\([^,]+,[^,]+,\s*(\d+)px\)/);
  assert.ok(h1 && Number(h1[1]) <= 30, "the greeting is at most 30px");
  const mark = css.match(/\.day-clear-mark \{[^}]*width: (\d+)px/);
  assert.ok(mark && Number(mark[1]) <= 24, "the all-clear tick is small");
  assert.match(css, /@media \(max-width: 1180px\) \{[^@]*\.day-action small \{ display: none; \}/);
});
