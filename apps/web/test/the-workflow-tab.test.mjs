/**
 * The SFS workflow as a tab of its own (3 Nov 2026): the same live workflow in
 * Business HQ and on /deck/workflow, reliable (loading, Try again, Updated and
 * Refresh, a quiet period said in words) and with a Pulse on top -- progress per
 * lane, where it is stuck, the lead trend -- built only from the audit's figures.
 * Spec: docs/superpowers/specs/2026-11-03-sfs-workflow-tab-design.md
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { REAL_ESTATE_WORKFLOW, stepStatus } from "@nexus/shared";
import { readFileSync } from "node:fs";
import { laneProgress, whereStuck, leadTrend, isQuiet, updatedLabel } from "@/lib/workflow/pulse";
import { WorkflowPulse } from "@/app/deck/workflow/pulse";
import { WorkflowPanel } from "@/app/deck/workflow/panel";
import { HqBusinessView, tabsFor } from "@/app/deck/hq/[slug]/tabs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const AUDIT = {
  business: { slug: "sfs-international", name: "SFS International", timezone: "Asia/Dubai" },
  period: { days: 30, from: "2026-10-05", today: "2026-11-03", bucket: "day" },
  evidence: {
    contacts: { total: 154, added: 142, withSource: 97, optedOut: 3, notACustomer: 5, emailOptedOut: 1 },
    outreach: { sent: 0, delivered: 0, failed: 0 },
    calls: { answered: 0, noAnswer: 0, voicemail: 0, busy: 0, failed: 0 },
    reengagement: { sent: 0, replied: 0, optedOut: 0, inCooldown: 0 },
    leads: { total: 88, pitches: 11, byChannel: { whatsapp: 80, email: 8 }, bySource: [] },
    qualifier: { scored: 59, hot: 12 },
    replies: { medianMs: 120000, byAi: 40, byPerson: 21, unanswered: 7 },
    viewings: { booked: 6, held: 4, noShow: 1, cancelled: 1 },
    won: 2,
    followUps: { created: 9, done: 5, openNow: 4, overdueNow: 2 },
    board: { S5: 2, D4: 1 },
    permits: { advertised: 0, expired: 0 },
  },
  series: {
    leads: [
      { bucket: "2026-11-01", count: 3 },
      { bucket: "2026-11-02", count: 9 },
      { bucket: "2026-11-03", count: 4 },
    ],
    replyMedian: [],
    quality: [],
    viewings: [],
  },
  funnel: { leads: 88, scored: 59, hot: 12, booked: 6, held: 4, won: 2 },
};

const zeroed = (value) =>
  typeof value === "number" ? 0 : Array.isArray(value) ? [] : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, zeroed(v)]))
    : value;
const QUIET = { ...AUDIT, evidence: zeroed(AUDIT.evidence), funnel: zeroed(AUDIT.funnel), series: { ...AUDIT.series, leads: AUDIT.series.leads.map((b) => ({ ...b, count: 0 })) } };

// ---------------------------------------------------------------------------
// The Pulse
// ---------------------------------------------------------------------------

test("each lane's progress is its steps' own statuses, in order", () => {
  const lanes = laneProgress(REAL_ESTATE_WORKFLOW, AUDIT.evidence);
  assert.deepEqual(lanes.map((l) => l.lane), ["supply", "demand"]);
  for (const lane of lanes) {
    const steps = REAL_ESTATE_WORKFLOW.steps.filter((s) => s.lane === lane.lane);
    assert.deepEqual(lane.steps.map((s) => s.id), steps.map((s) => s.id));
    assert.deepEqual(lane.steps.map((s) => s.status), steps.map((s) => stepStatus(s, AUDIT.evidence)));
    assert.equal(lane.total, steps.length);
    assert.equal(lane.working, steps.filter((s) => stepStatus(s, AUDIT.evidence) === "working").length);
  }
});

test("where it is stuck names the funnel's steepest drop, from its own figures", () => {
  const drop = whereStuck(REAL_ESTATE_WORKFLOW, AUDIT).find((i) => i.kind === "drop");
  // 88→59 loses a third, 59→12 four fifths, 12→6 half: the steepest is scored to hot.
  assert.ok(drop, "no drop named");
  assert.match(drop.title, /scored/i);
  assert.match(drop.title, /hot/i);
  assert.equal(drop.detail, "59 → 12");
});

test("a funnel stage of zero is never the start of a drop", () => {
  const audit = { ...AUDIT, funnel: { leads: 0, scored: 0, hot: 0, booked: 0, held: 0, won: 0 } };
  assert.equal(whereStuck(REAL_ESTATE_WORKFLOW, audit).find((i) => i.kind === "drop"), undefined);
});

test("built steps that sat idle are named", () => {
  const idle = REAL_ESTATE_WORKFLOW.steps.filter((s) => stepStatus(s, AUDIT.evidence) === "idle").map((s) => s.name);
  const item = whereStuck(REAL_ESTATE_WORKFLOW, AUDIT).find((i) => i.kind === "idle");
  if (idle.length === 0) {
    assert.equal(item, undefined);
  } else {
    assert.ok(item, "idle steps exist and are not named");
    for (const name of idle) assert.ok(item.detail.includes(name), `${name} missing`);
  }
});

test("waiting chats and past-due follow-ups appear only when there are some", () => {
  const items = whereStuck(REAL_ESTATE_WORKFLOW, AUDIT);
  assert.match(items.find((i) => i.kind === "unanswered")?.detail ?? "", /\b7\b/);
  assert.equal(items.find((i) => i.kind === "unanswered")?.href, "/inbox");
  assert.match(items.find((i) => i.kind === "overdue")?.detail ?? "", /\b2\b/);
  assert.equal(items.find((i) => i.kind === "overdue")?.href, "/deck/tasks");
  const calm = { ...AUDIT, evidence: { ...AUDIT.evidence, replies: { ...AUDIT.evidence.replies, unanswered: 0 }, followUps: { ...AUDIT.evidence.followUps, overdueNow: 0 } } };
  const kinds = whereStuck(REAL_ESTATE_WORKFLOW, calm).map((i) => i.kind);
  assert.ok(!kinds.includes("unanswered") && !kinds.includes("overdue"));
});

test("with nothing stuck it says so for the period", () => {
  const busyEverywhere = (step) => ({ ...step, coverage: step.coverage === "built" ? "built" : step.coverage, activity: step.activity ? () => 1 : null });
  const workflow = { ...REAL_ESTATE_WORKFLOW, steps: REAL_ESTATE_WORKFLOW.steps.map(busyEverywhere) };
  const flat = { ...AUDIT, funnel: { leads: 5, scored: 5, hot: 5, booked: 5, held: 5, won: 5 }, evidence: { ...AUDIT.evidence, replies: { ...AUDIT.evidence.replies, unanswered: 0 }, followUps: { ...AUDIT.evidence.followUps, overdueNow: 0 } } };
  assert.deepEqual(whereStuck(workflow, flat).map((i) => [i.kind, i.title]), [["clear", "Nothing is stuck in the last 30 days"]]);
});

test("the lead trend is the period's own total and busiest day", () => {
  assert.deepEqual(leadTrend(AUDIT.series, AUDIT.period.bucket), {
    total: 16,
    peak: { bucket: "2026-11-02", count: 9 },
    points: [3, 9, 4],
    unit: "day",
  });
});

test("a period with no leads has a flat trend and no busiest claim", () => {
  const trend = leadTrend(QUIET.series, "week");
  assert.equal(trend.total, 0);
  assert.equal(trend.peak, null);
  assert.equal(trend.unit, "week");
  const html = renderToStaticMarkup(createElement(WorkflowPulse, { workflow: REAL_ESTATE_WORKFLOW, audit: QUIET }));
  assert.doesNotMatch(html, /NaN|Infinity/);
  assert.doesNotMatch(html, /Busiest/);
});

test("the pulse draws progress, the stuck list and the trend, with no number of its own", () => {
  const html = renderToStaticMarkup(createElement(WorkflowPulse, { workflow: REAL_ESTATE_WORKFLOW, audit: AUDIT }));
  for (const lane of laneProgress(REAL_ESTATE_WORKFLOW, AUDIT.evidence)) {
    assert.ok(html.includes(`${lane.working} of ${lane.total} working`), `${lane.lane} progress missing`);
    assert.equal((html.match(new RegExp(`data-lane="${lane.lane}"[^>]*>`, "g")) ?? []).length, 1);
  }
  assert.equal((html.match(/class="wf-seg /g) ?? []).length, REAL_ESTATE_WORKFLOW.steps.length);
  assert.ok(html.includes("59 → 12"));
  assert.ok(html.includes("Busiest day"));
  assert.match(html, /<svg[^>]*class="wf-spark"/);
  // Every number the stuck list and the trend print is one the audit holds,
  // or the trend's own sum of the series.
  const allowed = new Set(["16", "30", ...JSON.stringify(AUDIT).match(/\d+/g)]);
  const printed = html.replace(/<[^>]+>/g, " ").match(/\d+/g) ?? [];
  for (const n of printed) assert.ok(allowed.has(n) || laneProgress(REAL_ESTATE_WORKFLOW, AUDIT.evidence).some((l) => String(l.total) === n || String(l.working) === n), `${n} is not from the audit`);
});

// ---------------------------------------------------------------------------
// The panel: one for the page and for Business HQ, and reliable
// ---------------------------------------------------------------------------

test("a quiet period is one where every count is zero", () => {
  assert.equal(isQuiet(QUIET), true);
  assert.equal(isQuiet(AUDIT), false);
});

test("Updated says how long ago this browser received the figures", () => {
  assert.equal(updatedLabel(1_000, 31_000), "Updated just now");
  assert.equal(updatedLabel(0, 5 * 60_000 + 10_000), "Updated 5 min ago");
  assert.equal(updatedLabel(0, 2 * 3_600_000 + 60_000), "Updated 2 h ago");
  assert.equal(updatedLabel(10_000, 0), "Updated just now", "a clock that moved back is not the future");
});

test("while it loads, the panel shows the page's outline, marked busy", () => {
  const html = renderToStaticMarkup(createElement(WorkflowPanel, { slug: "sfs-international" }));
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /class="wf-skeleton/);
  assert.doesNotMatch(html, /could not be loaded/);
  assert.match(html, />Refresh</);
});

test("the panel asks again on Try again and Refresh, and keeps figures it already has", () => {
  const P = read("app/deck/workflow/panel.tsx");
  assert.match(P, /export function WorkflowPanel\(\{ slug \}/);
  assert.match(P, /getWorkflowAudit\(/);
  assert.match(P, /const asked = \+\+requestId\.current;/);
  assert.match(P, /if \(asked !== requestId\.current\) return;/);
  assert.match(P, /The workflow could not be loaded\./);
  assert.match(P, /onClick=\{\(\) => void load\(days\)\}[^>]*>\s*Try again/);
  assert.match(P, /onClick=\{\(\) => void load\(days\)\}[\s\S]{0,80}>\s*Refresh/);
  assert.doesNotMatch(P, /setAudit\(null\)/, "a failed refresh blanks the figures already on screen");
  // Figures for another period, or another business, never sit under this one's pills.
  assert.match(P, /audit\.period\.days === days && audit\.business\.slug === slug/);
  assert.match(P, /updatedLabel\(fetchedAt, now\)/);
  assert.match(P, /Nothing was recorded in the last \{shown\.period\.days\} days\./);
  assert.match(P, /<WorkflowPulse workflow=\{workflow\} audit=\{shown\} \/>/);
});

test("the workflow page is titled Workflow and draws the panel", () => {
  const page = read("app/deck/workflow/page.tsx");
  assert.match(page, /<h1>Workflow\{/);
  assert.doesNotMatch(page, /Workflow audit/);
  assert.match(page, /<WorkflowPanel key=\{slug\} slug=\{slug\} \/>/);
});

// ---------------------------------------------------------------------------
// Business HQ's Workflow tab, and the name
// ---------------------------------------------------------------------------

const HQ = {
  business: { slug: "sfs-international", name: "SFS International", logoUrl: null, websiteUrl: null },
  profile: {},
  checks: {},
  issues: [],
  score: 70,
  keywords: [],
  socials: [],
  vault: [],
  reveals: [],
  vaultConfigured: true,
  unlockedSeconds: 0,
};
const hq = (tab, business = HQ.business) =>
  renderToStaticMarkup(createElement(HqBusinessView, { data: { ...HQ, business }, tab, now: new Date("2026-11-03T08:00:00Z"), onTab: () => {}, onChanged: () => {} }));

test("SFS's Business HQ has a Workflow tab; a business without a workflow does not", () => {
  assert.deepEqual(tabsFor("sfs-international").at(-1), { id: "workflow", label: "Workflow" });
  assert.deepEqual(tabsFor("zipicka").map((t) => t.id), ["overview", "team", "website", "seo", "social", "vault"]);
});

test("the Workflow tab draws the live workflow in place, not a link away", () => {
  const html = hq("workflow");
  assert.match(html, /role="tab" aria-selected="true"[^>]*>Workflow</);
  assert.match(html, /aria-busy="true"/, "the panel is not drawn in the tab");
  assert.doesNotMatch(html, /\/deck\/workflow\?business=/);
});

test("a #workflow link to a business without a workflow opens on Overview", () => {
  assert.match(read("app/deck/hq/[slug]/page.tsx"), /tabsFor\(slug\)\.some\(\(t\) => t\.id === fromHash\)/);
  const html = hq("workflow", { ...HQ.business, slug: "zipicka", name: "Zipicka" });
  assert.doesNotMatch(html, /aria-busy="true"/);
  assert.match(html, /role="tab" aria-selected="true"[^>]*>Overview</);
});

test("the rail item is called Workflow, and keeps its rules", () => {
  assert.match(read("lib/nav.tsx"), /href: "\/deck\/workflow",\s*label: "Workflow",\s*staffOnly: true,\s*needsWorkflow: true,/);
});

test("on a narrow screen the chosen tab is scrolled into view", () => {
  // Seen in the preview (3 Nov 2026): at phone width the tab bar scrolls
  // sideways, and Workflow -- last of seven -- sat chosen but out of sight.
  const T = read("app/deck/hq/[slug]/tabs.tsx");
  assert.match(T, /<nav ref=\{tabsRef\} className="hq-tabs"/);
  assert.match(T, /if \(a\.left < n\.left \|\| a\.right > n\.right\) nav\.scrollLeft \+= a\.left - n\.left - 16;/);
  assert.match(T, /\}, \[active\]\);/);
  // On first load the bar can still be settling (styles, fonts) when the
  // effect runs -- the preview showed it -- so it checks again as it resizes.
  assert.match(T, /new ResizeObserver\(keepInSight\)/);
  assert.match(T, /return \(\) => watch\?\.disconnect\(\);/);
});

// ---------------------------------------------------------------------------
// From the final review (3 Nov 2026)
// ---------------------------------------------------------------------------

test("a quiet week is quiet even though the business has contacts and open follow-ups", () => {
  // Totals and current counts (every contact ever, follow-ups open now, chats
  // waiting now) are not this period's activity; counting them made the quiet
  // sentence impossible for any real business.
  const quietWeek = {
    ...QUIET,
    evidence: {
      ...QUIET.evidence,
      contacts: { ...QUIET.evidence.contacts, total: 154, withSource: 97, optedOut: 3, notACustomer: 5, emailOptedOut: 1 },
      reengagement: { ...QUIET.evidence.reengagement, inCooldown: 6 },
      replies: { ...QUIET.evidence.replies, unanswered: 3 },
      followUps: { ...QUIET.evidence.followUps, openNow: 4, overdueNow: 2 },
    },
  };
  assert.equal(isQuiet(quietWeek), true);
  assert.equal(isQuiet({ ...quietWeek, evidence: { ...quietWeek.evidence, contacts: { ...quietWeek.evidence.contacts, added: 1 } } }), false);
  assert.equal(isQuiet({ ...quietWeek, evidence: { ...quietWeek.evidence, outreach: { sent: 2, delivered: 0, failed: 0 } } }), false);
  // Units advertised now are a count of now, not this period's work (3 Nov 2026,
  // the workflow board); a card moved on the board is.
  const advertised = { ...quietWeek, evidence: { ...quietWeek.evidence, permits: { advertised: 3, expired: 1 } } };
  assert.equal(isQuiet(advertised), true);
  assert.equal(isQuiet({ ...advertised, evidence: { ...advertised.evidence, board: { S8: 1 } } }), false);
});

test("the biggest drop is the most people lost, not a tiny tail", () => {
  const dropOf = (funnel) => whereStuck(REAL_ESTATE_WORKFLOW, { ...AUDIT, funnel }).find((i) => i.kind === "drop")?.detail;
  // No wins in a week is normal; 4 → 0 must not outrank 59 → 12.
  assert.equal(dropOf({ leads: 88, scored: 59, hot: 12, booked: 6, held: 4, won: 0 }), "59 → 12");
  assert.equal(dropOf({ leads: 40, scored: 30, hot: 12, booked: 2, held: 0, won: 0 }), "30 → 12");
});

test("the quiet sentence has a class of its own; the cards' idle line keeps its look", () => {
  const css = read("app/deck/workflow/workflow.css");
  assert.match(read("app/deck/workflow/panel.tsx"), /<p className="wf-quiet-period">/);
  assert.match(css, /\.wf-quiet-period \{/);
  // .wf-quiet is the idle card's "nothing in this period" line: its rules only.
  const quietRules = css.match(/^[^\n]*\.wf-quiet\b[^-][^\n]*$/gm) ?? [];
  assert.deepEqual(quietRules.map((r) => r.trim()), [
    ".wf-needs, .wf-quiet { font-size: 12px; line-height: 1.35; }",
    ".wf-quiet { opacity: .8; }",
  ]);
});

test("inside Business HQ the workflow keeps its own look", () => {
  // hq.css frames every section and sizes every h3 under .hq-panel; the
  // workflow's sections, lanes and headings are its own, so its tab is drawn
  // in a tab panel of its own, outside .hq-panel, and matches the page.
  const html = hq("workflow");
  assert.match(html, /<div class="hq-workflow" role="tabpanel">/);
  assert.doesNotMatch(html, /class="hq-panel"/);
  assert.match(hq("overview"), /<div class="hq-panel" role="tabpanel">/);
});
