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
import { AuditTiles, AuditCharts } from "@/app/deck/workflow/audit-charts";
import { Funnel } from "@/app/deck/workflow/funnel";
import { ComplianceTable } from "@/app/deck/workflow/compliance";
import { NoWorkflow } from "@/app/deck/workflow/empty";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));

const byId = (id) => REAL_ESTATE_WORKFLOW.steps.find((step) => step.id === id);

/**
 * An audit for "SFS International": 3 new leads, 1 won, a 5-minute median
 * reply, every other count 2. `overrides` merges into period, evidence and
 * series; `replyMedian` and `bySource` are shortcuts for those two lists.
 */
function sample(overrides = {}) {
  const days = ["2026-11-01", "2026-11-02"];
  const base = {
    business: { slug: "sfs-international", name: "SFS International", timezone: "Asia/Dubai" },
    period: { days: 30, from: "2026-10-04", today: "2026-11-02", bucket: "day" },
    evidence: {
      contacts: { total: 2, added: 2, withSource: 2, optedOut: 2, notACustomer: 2, emailOptedOut: 2 },
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
  const evidence = { ...base.evidence, ...overrides.evidence };
  if (overrides.bySource) evidence.leads = { ...evidence.leads, bySource: overrides.bySource };
  const series = { ...base.series, ...overrides.series };
  if (overrides.replyMedian) series.replyMedian = overrides.replyMedian;
  return { ...base, period: { ...base.period, ...overrides.period }, evidence, series };
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

// ---- Task 6: tiles, charts, funnel and compliance -------------------------------------------

test("six tiles in the spec's words, from the period's own figures", () => {
  const html = render(AuditTiles, { audit: sample() });
  for (const label of ["New leads", "Median first reply", "Hot leads", "Viewings held", "Follow-ups overdue now", "Won (labelled)"]) {
    assert.ok(html.includes(`class="kit-tile-label">${label}<`), label);
  }
  assert.ok(html.includes('class="kit-tile-label">Median first reply</span><span class="kit-tile-figure"><span data-countup="">5 m<'));
  // No reply in the period is a dash, never "0 m".
  const none = render(AuditTiles, { audit: sample({ evidence: { replies: { medianMs: null, byAi: 0, byPerson: 0, unanswered: 0 } } }) });
  assert.ok(none.includes('class="kit-tile-label">Median first reply</span><span class="kit-tile-figure"><span data-countup="">—<'));
});

test("five charts, the reply chart named for the business", () => {
  const html = render(AuditCharts, { audit: sample() });
  for (const title of ["Leads coming in", "How fast SFS International answers", "From lead to won", "Viewings", "Lead quality"]) {
    assert.ok(html.includes(`<h3>${title}</h3>`), title);
  }
});

test("the reply chart draws no-reply days as empty slots, never zero", () => {
  const html = render(AuditCharts, { audit: sample({ replyMedian: [{ bucket: "2026-11-01", medianMs: 300000 }, { bucket: "2026-11-02", medianMs: null }] }) });
  assert.equal((html.match(/kit-bar-empty/g) ?? []).length, 1);
  assert.match(html, /How fast SFS International answers/);
});

test("90 days reads in Monday weeks, and the bucket holding today is drawn in progress", () => {
  const weeks = ["2026-10-26", "2026-11-02"];
  const html = render(AuditCharts, {
    audit: sample({
      period: { days: 90, from: "2026-08-07", today: "2026-11-04", bucket: "week" },
      series: {
        leads: weeks.map((bucket) => ({ bucket, count: 2 })),
        replyMedian: weeks.map((bucket) => ({ bucket, medianMs: 300000 })),
        quality: weeks.map((bucket) => ({ bucket, scored: 2, hot: 1 })),
        viewings: weeks.map((bucket) => ({ bucket, booked: 2, held: 1, noShow: 0, cancelled: 0 })),
      },
    }),
  });
  assert.match(html, /w\/c 26 Oct/);
  // One in-progress bar in each of the three bar charts: the week of 2 Nov holds the 4th.
  assert.equal((html.match(/kit-bar-col partial/g) ?? []).length, 3);
  assert.match(render(AuditCharts, { audit: sample() }), />1 Nov</);
});

test("the funnel says 'x of y' under 20 and % from 20", () => {
  const small = render(Funnel, { funnel: { leads: 7, scored: 3, hot: 1, booked: 1, held: 1, won: 0 } });
  assert.match(small, /3 of 7/);
  assert.doesNotMatch(small, /43%/);
  assert.match(render(Funnel, { funnel: { leads: 40, scored: 18, hot: 6, booked: 3, held: 2, won: 1 } }), /45%/);
});

test("compliance items are kept outside Nexus, beside the consent Nexus does record", () => {
  const html = render(ComplianceTable, { evidence: sample().evidence });
  for (const item of ["Form A", "Trakheesi permit", "Ejari", "Form F", "KYC/AML", "DLD transfer"]) assert.match(html, new RegExp(item));
  assert.match(html, /Kept outside Nexus/);
  assert.match(html, /Opted out of re-engagement/);
  assert.match(html, /Unsubscribed from campaign emails/);
  assert.match(html, /Marked &quot;not a customer&quot;/);
});

test("a long lead source never widens its row", () => {
  const html = render(AuditCharts, { audit: sample({ bySource: [{ source: "Bayut premium featured listing campaign October", count: 3 }] }) });
  assert.match(html, /class="wf-source"[^>]*dir="auto"/);
  assert.match(read("app/deck/workflow/workflow.css"), /\.wf-source \{[^}]*text-overflow: ellipsis/);
});

// ---- Task 7: the page, the sidebar item and the Business HQ link -------------------------------

test("the page loads the audit for its period and ignores answers that arrive late", () => {
  const P = read("app/deck/workflow/page.tsx");
  assert.match(P, /getWorkflowAudit\(/);
  assert.match(P, /const asked = \+\+requestId\.current;/);
  assert.match(P, /if \(asked !== requestId\.current\) return;/);
  assert.match(P, /The audit could not be loaded\./);
  assert.match(P, /<NoWorkflow \/>/);
  assert.match(P, /Loading…/);
  assert.match(P, /const PERIODS: AuditDays\[\] = \[7, 30, 90\];/);
  assert.match(P, /useState<AuditDays>\(30\)/);
  assert.match(P, /aria-pressed=\{d === days\}/);
  assert.match(P, /verdict\(/);
  assert.match(P, /import "\.\.\/\.\.\/kit\/kit\.css";/);
  assert.match(P, /import "\.\/workflow\.css";/);
  assert.doesNotMatch(P, /\[\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,/); // no literal series
});

test("staff see the item only when their business has a workflow; admins reach it from Business HQ", () => {
  assert.match(read("lib/nav.tsx"), /href: "\/deck\/workflow"[\s\S]{0,400}needsWorkflow: true/);
  assert.match(read("app/console-shell.tsx"), /needsWorkflow[\s\S]{0,120}workflowFor\(/);
  assert.match(read("app/console-shell.tsx"), /<RailLinks role=\{role\} mySlug=\{me\?\.organizationSlug \?\? null\} \/>/);
  // The search palette offers the same doors as the rail, so it hides the item the same way.
  assert.match(read("app/command-palette.tsx"), /needsWorkflow[\s\S]{0,120}workflowFor\(/);
  assert.match(read("app/deck/hq/[slug]/tabs.tsx"), /workflowFor\([\s\S]{0,200}\/deck\/workflow\?business=/);
});

test("a business with no workflow says so, not an error", () => {
  const html = render(NoWorkflow, {});
  assert.match(html, /No workflow is set up for this business yet\./);
});

// ---- Task 8: fixes from the browser check ---------------------------------------------------

test("the browser build compiles what the pages import from @nexus/shared", () => {
  // The rail and the audit pages are the first web code to import VALUES from
  // @nexus/shared (workflowFor, stepStatus…), not just types. Its source is
  // TypeScript importing "./x.js", which tsx and tsc resolve and Next's webpack
  // does not: every page failed to build until Next was told to compile it.
  const config = read("next.config.mjs");
  assert.match(config, /transpilePackages: \["@nexus\/shared"\]/);
  assert.match(config, /extensionAlias[\s\S]{0,80}"\.js": \["\.ts", "\.tsx", "\.js"\]/);
});

test("a not-tracked card's muted words stay readable: no extra fading on top of the muted grey", () => {
  // Found in the browser check: on the light theme the kit's .75 / .82 opacity
  // on the tag and subtitle, over the card's slate, read at 3.6:1 and 4.3:1.
  const css = read("app/deck/workflow/workflow.css");
  assert.match(css, /\.wf-untracked \.kit-card-eyebrow,\s*\.wf-untracked \.kit-card-sub \{ opacity: 1; \}/);
  assert.match(css, /\.wf-untracked \.wf-chip \{[^}]*background: transparent/);
});
