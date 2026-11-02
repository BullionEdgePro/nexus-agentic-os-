/**
 * The SFS workflow audit's rules (2 Nov 2026): the boss's 20 steps word for
 * word, what decides each step's status, the funnel's shares, and the buckets.
 * Pure — no database, no browser.
 * Spec: docs/superpowers/specs/2026-11-02-sfs-audit-design.md §4, §5, §7.5
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REAL_ESTATE_WORKFLOW,
  stepStatus,
  verdict,
  share,
  bucketKeys,
  fillBuckets,
  workflowFor,
  BUSINESSES_WITH_WORKFLOW,
} from "@nexus/shared";

/** Every count 0 and no reply time: a business with nothing in the period. */
function emptyEvidence() {
  return {
    contacts: { total: 0, added: 0, withSource: 0, optedOut: 0, notACustomer: 0 },
    outreach: { sent: 0, delivered: 0, failed: 0 },
    calls: { answered: 0, noAnswer: 0, voicemail: 0, busy: 0, failed: 0 },
    reengagement: { sent: 0, replied: 0, optedOut: 0, inCooldown: 0 },
    leads: { total: 0, pitches: 0, byChannel: {}, bySource: [] },
    qualifier: { scored: 0, hot: 0 },
    replies: { medianMs: null, byAi: 0, byPerson: 0, unanswered: 0 },
    viewings: { booked: 0, held: 0, noShow: 0, cancelled: 0 },
    won: 0,
    followUps: { created: 0, done: 0, openNow: 0, overdueNow: 0 },
  };
}

const byId = (id) => REAL_ESTATE_WORKFLOW.steps.find((s) => s.id === id);

test("the workflow is the boss's 20 steps, word for word", () => {
  const steps = REAL_ESTATE_WORKFLOW.steps;
  assert.equal(steps.length, 20);
  assert.deepEqual(
    steps.map((s) => s.id),
    ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10"]
  );
  const s8 = byId("S8");
  assert.deepEqual([s8.tag, s8.name, s8.subtitle, s8.coverage], ["GATE", "Compliance", "Form A + Trakheesi permit", "not_tracked"]);
  const d5 = byId("D5");
  assert.deepEqual([d5.tag, d5.name, d5.subtitle, d5.coverage], ["HUMAN", "Viewing", "AI books slot, agent attends", "built"]);
  const counts = steps.reduce((m, s) => ({ ...m, [s.coverage]: (m[s.coverage] ?? 0) + 1 }), {});
  assert.deepEqual(counts, { partly: 5, built: 4, not_tracked: 11 });
  for (const s of steps.filter((s) => s.coverage === "not_tracked")) assert.ok(s.missing && s.activity === null, s.id);
});

test("a built step is working with activity, idle without; partly and not tracked never change", () => {
  const e = emptyEvidence();
  const d1 = byId("D1");
  assert.equal(stepStatus(d1, e), "idle");
  assert.equal(stepStatus(d1, { ...e, leads: { ...e.leads, total: 3 } }), "working");
  assert.equal(stepStatus(byId("D2"), e), "partly");
  assert.equal(stepStatus(byId("S8"), e), "not_tracked");
  assert.deepEqual(verdict(REAL_ESTATE_WORKFLOW, e), { working: 0, idle: 4, partly: 5, not_tracked: 11 });
  // Nurture and Cold lead read the same re-engagement queue.
  const sent = { ...e, reengagement: { ...e.reengagement, sent: 2 } };
  assert.deepEqual([stepStatus(byId("S4"), sent), stepStatus(byId("D3"), sent)], ["working", "working"]);
});

test("a share is 'x of y' under 20 and a percentage from 20", () => {
  assert.equal(share(3, 7), "3 of 7");
  assert.equal(share(19, 19), "19 of 19");
  assert.equal(share(9, 20), "45%");
  assert.equal(share(1, 3), "1 of 3");
  assert.equal(share(0, 0), "—");
});

test("buckets are days, or Monday weeks, with missing ones filled", () => {
  assert.deepEqual(bucketKeys("2026-10-30", "2026-11-02", "day"), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  assert.deepEqual(bucketKeys("2026-10-29", "2026-11-02", "week"), ["2026-10-26", "2026-11-02"]);
  const filled = fillBuckets([{ bucket: "2026-10-31", count: 2 }], ["2026-10-30", "2026-10-31"], (bucket) => ({ bucket, count: 0 }));
  assert.deepEqual(filled, [
    { bucket: "2026-10-30", count: 0 },
    { bucket: "2026-10-31", count: 2 },
  ]);
});

test("only SFS has a workflow today", () => {
  assert.equal(workflowFor("sfs-international"), REAL_ESTATE_WORKFLOW);
  assert.equal(workflowFor("zipicka"), null);
  assert.deepEqual([...BUSINESSES_WITH_WORKFLOW], ["sfs-international"]);
});
