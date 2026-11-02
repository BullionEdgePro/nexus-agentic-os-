/**
 * The SFS workflow audit in Cream (2 Nov 2026): the boss's two lanes drawn
 * live from the business's own data — a card per step in its status's colour,
 * arrows that keep the branches, and a window per step with the full evidence,
 * what Nexus does and does not do, and the screen that holds the detail.
 * Spec: docs/superpowers/specs/2026-11-02-sfs-audit-design.md §4
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { REAL_ESTATE_WORKFLOW } from "@nexus/shared";
import { stepFigures } from "@/lib/workflow/step-figures";
import { WorkflowLanes } from "@/app/deck/workflow/lanes";
import { StepWindow } from "@/app/deck/workflow/step-window";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));

const byId = (id) => REAL_ESTATE_WORKFLOW.steps.find((step) => step.id === id);

/** An audit for "SFS International": 3 new leads, 1 won, a 5-minute median reply, every other count 2. */
function sample(overrides = {}) {
  const days = ["2026-11-01", "2026-11-02"];
  const base = {
    business: { slug: "sfs-international", name: "SFS International", timezone: "Asia/Dubai" },
    period: { days: 30, from: "2026-10-04", today: "2026-11-02", bucket: "day" },
    evidence: {
      contacts: { total: 2, added: 2, withSource: 2, optedOut: 2, notACustomer: 2 },
      outreach: { sent: 2, delivered: 2, failed: 2 },
      calls: { answered: 2, noAnswer: 2, voicemail: 2, busy: 2, failed: 2 },
      reengagement: { sent: 2, replied: 2, optedOut: 2, inCooldown: 2 },
      leads: { total: 3, pitches: 2, byChannel: { whatsapp: 2 }, bySource: [{ source: "Bayut", count: 2 }] },
      qualifier: { scored: 2, hot: 2 },
      replies: { medianMs: 300000, byAi: 2, byPerson: 2, unanswered: 2 },
      viewings: { booked: 2, held: 2, noShow: 2, cancelled: 2 },
      won: 1,
      followUps: { created: 2, done: 2, openNow: 2, overdueNow: 2 },
    },
    series: {
      leads: days.map((bucket) => ({ bucket, count: 2 })),
      replyMedian: days.map((bucket) => ({ bucket, medianMs: 300000 })),
      quality: days.map((bucket) => ({ bucket, scored: 2, hot: 2 })),
      viewings: days.map((bucket) => ({ bucket, booked: 2, held: 2, noShow: 2, cancelled: 2 })),
    },
    funnel: { leads: 3, scored: 2, hot: 2, booked: 2, held: 2, won: 1 },
  };
  return {
    ...base,
    period: { ...base.period, ...overrides.period },
    evidence: { ...base.evidence, ...overrides.evidence },
    series: { ...base.series, ...overrides.series },
  };
}

test("each step is a card in its status's colour, with the boss's words", () => {
  const html = render(WorkflowLanes, { workflow: REAL_ESTATE_WORKFLOW, evidence: sample().evidence, onOpen() {} });
  assert.equal((html.match(/data-step="/g) ?? []).length, 20);
  assert.match(html, /aria-label="INBOUND New lead: Working\. Open the step\."/);
  assert.match(html, /aria-label="GATE Compliance: Not tracked in Nexus yet\. Open the step\."/);
  assert.match(html, /aria-label="AGENT 05 AI qualifier: Partly\. Open the step\."/);
  assert.match(html, /Form A \+ Trakheesi permit/);
  // The tag is on the card, as on the boss's canvas, and the branches keep their words.
  assert.match(html, /class="kit-card-eyebrow"[^>]*>GATE</);
  assert.match(html, />not now</);
  assert.match(html, />cold</);
  // React writes the spec's apostrophe as &#x27; in markup.
  assert.match(html, /Won \(labelled\) in this period: 1 — rent or sale isn&#x27;t recorded/);
  // A built step with nothing in the period is idle: paper with a forest outline, not green.
  const quiet = render(WorkflowLanes, {
    workflow: REAL_ESTATE_WORKFLOW,
    evidence: sample({ evidence: { reengagement: { sent: 0, replied: 0, optedOut: 0, inCooldown: 0 } } }).evidence,
    onOpen() {},
  });
  assert.match(quiet, /class="kit-card tone-paper wf-card wf-idle"[^>]*aria-label="QUEUE Nurture: Idle\. Open the step\."/);
  assert.match(html, /class="kit-card tone-forest wf-card"[^>]*aria-label="QUEUE Nurture: Working\. Open the step\."/);
  assert.match(html, /class="kit-card tone-paper wf-card wf-untracked"[^>]*aria-label="GATE Compliance/);
});

test("a not-tracked step shows no figures; a partly step says what is missing", () => {
  assert.deepEqual(stepFigures("S8", sample().evidence), []);
  assert.deepEqual(stepFigures("D1", sample().evidence)[0], { label: "New leads", value: "3" });
  const html = render(StepWindow, { step: byId("D2"), evidence: sample().evidence, origin: null, onClose() {} });
  assert.match(html, /budget, timeline and finance are not captured/i);
  assert.match(html, /href="\/deck\/customers"/);
  assert.match(render(StepWindow, { step: byId("S4"), evidence: sample().evidence, origin: null, onClose() {} }), /No screen yet/);
  // A not-tracked step's window says what tracking it would need, and shows no figures.
  const gate = render(StepWindow, { step: byId("S8"), evidence: sample().evidence, origin: null, onClose() {} });
  assert.match(gate, /Trakheesi permit number and expiry/);
  assert.doesNotMatch(gate, /<dl/);
});

test("connectors draw in and the pulse runs only when motion is welcome", () => {
  const css = read("app/deck/workflow/workflow.css");
  const motion = css.slice(css.indexOf("@media (prefers-reduced-motion: no-preference)"));
  assert.match(motion, /\.wf-arrow/);
  assert.match(motion, /\.wf-pulse/);
  // A pulse rides only a path that leaves a Working card for a step Nexus tracks.
  const html = render(WorkflowLanes, { workflow: REAL_ESTATE_WORKFLOW, evidence: sample().evidence, onOpen() {} });
  assert.equal((html.match(/class="wf-pulse"/g) ?? []).length, 1);
});
