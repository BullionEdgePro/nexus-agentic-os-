/**
 * Staff-first compact Nexus, piece 4 (26 Nov 2026): every page shows an outline
 * while it loads and, when its load fails, the reason with a Try again that
 * loads it again — never a bare "Loading…" line, never a dead end.
 * Spec: docs/superpowers/specs/2026-11-26-staff-first-loading-design.md
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import * as states from "@/app/kit/load-states";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));

// ---- Task 1: the pieces ----------------------------------------------------------------------------

test("PageLoading: an outline that still says Loading… to a screen reader", () => {
  const { PageLoading } = states;
  assert.equal(typeof PageLoading, "function", "app/kit/load-states exports no PageLoading");
  const html = render(PageLoading, {});
  assert.match(html, /^<div class="kit-loading" role="status" aria-live="polite">/);
  assert.match(html, /<span class="kit-sr">Loading…<\/span>/);
  assert.equal((html.match(/class="kit-skel"/g) ?? []).length, 3);
  assert.equal((render(PageLoading, { rows: 2 }).match(/class="kit-skel"/g) ?? []).length, 2);
});

test("LoadFailed: the reason, and Try again", () => {
  const { LoadFailed } = states;
  assert.equal(typeof LoadFailed, "function", "app/kit/load-states exports no LoadFailed");
  const html = render(LoadFailed, { reason: "Could not reach the server.", onRetry() {} });
  assert.match(html, /^<div class="kit-failed" role="alert">/);
  assert.match(html, /<p class="kit-failed-reason">Could not reach the server\.<\/p>/);
  assert.match(html, /<button type="button" class="kit-failed-retry">Try again<\/button>/);
});

test("the outline shimmers, and stays still under reduced motion", () => {
  assert.ok(existsSync(new URL("../app/kit/load-states.css", import.meta.url)), "no app/kit/load-states.css");
  const css = read("app/kit/load-states.css");
  assert.match(css, /\.kit-skel \{[^}]*animation:/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^@]*\.kit-skel \{ animation: none; \}/);
  assert.match(css, /\.kit-sr \{[^}]*clip: rect\(0 0 0 0\)/);
});

// ---- Task 2: every page ----------------------------------------------------------------------------

// The pages whose failed load now offers Try again, and the arguments their effect loads with.
const RETRY = [
  ["tasks", "load(business, status)"],
  ["bookings", "load(business, status)"],
  ["customers", "load(business, search)"],
  ["knowledge", "load(business)"],
  ["procedures", "load(business)"],
  ["forecast", "load(business)"],
  ["board", "load(business)"],
  ["operators", "load(business)"],
  ["agent", "load(business)"],
  ["broadcasts", "load(business)"],
  ["catalogue", "load()"],
  ["quality", "load(business)"],
  ["my-settings", "load()"],
];
// Outline only: no load of their own to call again (or, for links, an error line its other actions share).
const OUTLINE_PAGES = ["channels", "links", "workflow"];
// Sections drawn inside a page; the page they sit on imports the stylesheet.
const SECTIONS = [
  ["app/deck/activity/response-times.tsx", "app/deck/activity/page.tsx"],
  ["app/deck/procedures/phrases-section.tsx", "app/deck/procedures/page.tsx"],
  ["app/deck/quality/brain-section.tsx", "app/deck/quality/page.tsx"],
];
const page = (name) => read(`app/deck/${name}/page.tsx`);
const IMPORTS_CSS = /import "(\.\.\/)+kit\/load-states\.css";/;
const BARE_LOADING = />\s*Loading…\s*</;

test("every listed page loads with the outline, never a bare Loading… line", () => {
  for (const name of [...RETRY.map(([n]) => n), "notifications", ...OUTLINE_PAGES]) {
    const P = page(name);
    assert.doesNotMatch(P, BARE_LOADING, `${name} still says a bare Loading…`);
    assert.match(P, /<PageLoading/, `${name} draws no outline`);
    assert.match(P, IMPORTS_CSS, `${name} does not import kit/load-states.css`);
  }
  for (const [section, host] of SECTIONS) {
    const S = read(section);
    assert.doesNotMatch(S, BARE_LOADING, `${section} still says a bare Loading…`);
    assert.match(S, /<PageLoading/, `${section} draws no outline`);
    assert.doesNotMatch(S, /\.css";/, `${section} imports a stylesheet (its page does)`);
    assert.match(read(host), IMPORTS_CSS, `${host} does not import kit/load-states.css`);
  }
});

test("a failed load says why and offers Try again, which loads the page again", () => {
  for (const [name, call] of RETRY) {
    const P = page(name);
    assert.ok(
      P.includes(`<LoadFailed reason={loadError} onRetry={() => void ${call}} />`),
      `${name}: no <LoadFailed reason={loadError} onRetry={() => void ${call}} />`,
    );
    assert.doesNotMatch(P, /\{loadError\}<\/p>/, `${name} still prints the bare reason`);
    // The stale-data rule stays: nothing from the last load is drawn under the error — either a
    // `loadError ? null` gate on the content, or the error is the branch drawn instead of it.
    assert.ok(
      /loadError \? null/.test(P) || /<LoadFailed reason=\{loadError\} onRetry=\{[^}]*\} \/>\s*\) :/.test(P),
      `${name} lost its stale-data rule`,
    );
  }
});

test("Follow-ups and Appointments hide their counts and heading under a failed load", () => {
  // Found in the preview (26 Nov 2026): a failed switch to Zipicka left "7 open · 2 overdue" from
  // All businesses above the error — another view's numbers under this one's name.
  for (const name of ["tasks", "bookings"]) {
    const P = page(name);
    assert.match(P, /\{loadError \? null : \(\s*<div className="tk-counts">/, `${name}: counts drawn under a failed load`);
    assert.match(P, /\{loadError \? null : <h2 className="act-sub-head">\{heading\}<\/h2>\}/, `${name}: heading drawn under a failed load`);
  }
});

test("notifications: its load is a function Try again can call, still run once on open", () => {
  const P = page("notifications").replace(/\r\n/g, "\n");
  assert.match(P, /const load = useCallback\(/);
  assert.match(P, /useEffect\(\(\) => \{\n    load\(\);\n  \}, \[load\]\);/);
  assert.match(P, /<LoadFailed reason=\{loadError\} onRetry=\{load\} \/>/);
  assert.doesNotMatch(P, /\{loadError\}<\/p>/);
});
