// What to do next for one unit on Bayut and dubizzle (23 Nov 2026): the steps,
// in order, from what is wanted AND ready against what Bayut holds. A publish is
// asked once and then waited for; a refusal waits for a change; no portal is
// published twice within 24 hours.
//
// Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §9
import { test } from "node:test";
import assert from "node:assert/strict";
import { bayutNextSteps, SCHEDULED_JOBS, JOB_STALE_AFTER_SECONDS } from "@nexus/shared";

const now = new Date("2026-11-23T12:00:00Z");
const hoursAgo = (h) => new Date(now.getTime() - h * 3600_000).toISOString();
const both = ["bayut", "dubizzle"];
const should = (portals, fingerprint = "f1") => ({ portals, fingerprint });
const row = (state = null, publishedAt = null) => ({ state, publishedAt });
const remote = (ref, fingerprint, bayut = row(), dubizzle = row()) => ({ ref, fingerprint, portals: { bayut, dubizzle } });

test("a unit never sent is created, then published where wanted", () => {
  assert.deepEqual(bayutNextSteps(should(both), remote(null, null), now), [
    { kind: "create" },
    { kind: "publish", portals: ["bayut", "dubizzle"] },
  ]);
});

test("a changed listing is updated, then published where not live", () => {
  assert.deepEqual(bayutNextSteps(should(both, "f1"), remote("95", "f0", row("live"), row(null)), now), [
    { kind: "update" },
    { kind: "publish", portals: ["dubizzle"] },
  ]);
});

test("an unchanged listing publishes only what is not live or pending", () => {
  assert.deepEqual(bayutNextSteps(should(both), remote("95", "f1", row("pending"), row("unpublished")), now), [
    { kind: "publish", portals: ["dubizzle"] },
  ]);
});

test("a pending publish is waited for, never repeated", () => {
  assert.deepEqual(bayutNextSteps(should(["bayut"]), remote("95", "f1", row("pending", hoursAgo(72))), now), []);
  // a draft that has a publish behind it is treated the same way
  assert.deepEqual(bayutNextSteps(should(["bayut"]), remote("95", "f1", row("draft", hoursAgo(72))), now), []);
  // a draft never published is ready to publish
  assert.deepEqual(bayutNextSteps(should(["bayut"]), remote("95", "f1", row("draft")), now), [
    { kind: "publish", portals: ["bayut"] },
  ]);
});

test("a pending or draft listing comes off when no longer wanted", () => {
  assert.deepEqual(bayutNextSteps(should([]), remote("95", "f1", row("pending"), row("draft")), now), [
    { kind: "remove", portals: ["bayut", "dubizzle"] },
  ]);
});

test("unwanted live comes off, unpublished stays", () => {
  assert.deepEqual(bayutNextSteps(should(["bayut"]), remote("95", "f1", row("live"), row("live")), now), [
    { kind: "remove", portals: ["dubizzle"] },
  ]);
  assert.deepEqual(bayutNextSteps(should(["bayut"]), remote("95", "f1", row("live"), row("unpublished")), now), []);
});

test("a refusal waits for a change", () => {
  assert.deepEqual(bayutNextSteps(should(["bayut"], "f1"), remote("95", "f1", row("refused")), now), []);
  assert.deepEqual(bayutNextSteps(should(["bayut"], "f2"), remote("95", "f1", row("refused")), now), [
    { kind: "update" },
    { kind: "publish", portals: ["bayut"] },
  ]);
});

test("never published twice within 24 hours", () => {
  assert.deepEqual(bayutNextSteps(should(["bayut"]), remote("95", "f1", row("failed", hoursAgo(2))), now), []);
  assert.deepEqual(bayutNextSteps(should(["bayut"]), remote("95", "f1", row("failed", hoursAgo(25))), now), [
    { kind: "publish", portals: ["bayut"] },
  ]);
});

test("nothing wanted and nothing held gives nothing", () => {
  assert.deepEqual(bayutNextSteps(should([], null), remote(null, null), now), []);
  assert.deepEqual(bayutNextSteps(should([]), remote("95", "f1", row("unpublished"), row(null)), now), []);
});

test("the Bayut sync is a scheduled job, stale after 45 minutes", () => {
  assert.ok(SCHEDULED_JOBS.includes("bayut-sync"));
  assert.equal(JOB_STALE_AFTER_SECONDS["bayut-sync"], 2700);
});
