/**
 * Forecast and Agent quality in Cream (2 Nov 2026, part 2a): chart cards whose
 * hover labels say what each bar is, the forecast's baseline beside every
 * range, the in-progress day marked, and the refusals kept as calm paper notes.
 * Spec: docs/superpowers/specs/2026-11-02-cream-pages-2a-design.md §4
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { BarChart, describeBar } from "@/app/kit/charts";
import { NumberTile } from "@/app/kit/number-tile";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));

test("a bar's label carries its note: the forecast's baseline, the day still in progress", () => {
  const plain = (n) => String(n);
  assert.equal(
    describeBar({ label: "Mon 03", value: 7, low: 4, high: 9, note: "the same weekday last week said 6" }, plain),
    "Mon 03: 4–9, most likely 7. the same weekday last week said 6"
  );
  assert.equal(
    describeBar({ label: "02", value: 5, part: 2, partial: true }, plain, "escalated"),
    "02: 5, 2 escalated. Still in progress, counts only so far"
  );
});

test("an in-progress day's bar is drawn marked, never as a collapse in volume", () => {
  const html = render(BarChart, { bars: [{ label: "01", value: 9 }, { label: "02", value: 2, partial: true }], ariaLabel: "Daily" });
  assert.match(html, /class="kit-bar-col partial"/);
  assert.equal((html.match(/kit-bar-col partial/g) ?? []).length, 1);
});

test("a number tile can carry a coloured edge for good, watch and bad", () => {
  assert.match(render(NumberTile, { label: "Handled", value: "82%", edge: "forest" }), /class="kit-tile kit-edge-forest"/);
  assert.match(render(NumberTile, { label: "Tokens", value: "1.2k" }), /class="kit-tile"/);
});

test("forecasts draw as range bands, and the refusals stay", () => {
  const F = read("app/deck/forecast/page.tsx");
  assert.match(F, /<BarChart[\s\S]{0,300}low:/);
  assert.match(F, /note: `the same weekday last week said \$\{formatCount\(row\.baseline\)\}`/);
  assert.match(F, /<ChartCard/);
  assert.match(F, /className="fc-blocked kit-card tone-paper"/); // the refusal cards are still drawn
  assert.match(F, /className="kit-table fc-acc-table"/);
});

test("agent quality: number tiles and a daily chart with the escalated part shaded", () => {
  const Q = read("app/deck/quality/page.tsx");
  assert.match(Q, /<NumberTile/);
  assert.match(Q, /<BarChart[\s\S]{0,300}part:/);
  assert.match(Q, /partial: !day\.isComplete/);
  assert.match(Q, /partLabel="escalated"/);
  assert.match(Q, /<table className="kit-table">/);
  // The kit's table look exists.
  assert.match(read("app/kit/kit.css"), /\.kit-table \{/);
});
