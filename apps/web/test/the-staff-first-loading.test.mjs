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
