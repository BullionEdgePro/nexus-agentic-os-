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
  assert.match(css, /\.page-head h1 \{[^}]*clamp\(24px, 3vw, 30px\)/);
});
