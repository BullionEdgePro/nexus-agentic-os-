// What to do next for one unit on Property Finder (7 Nov 2026): the unit should
// be live when it is wanted there AND ready (the feed's own rule); what Property
// Finder holds is its reference, its last answer and a fingerprint of what was
// sent. One step at a time; a refusal waits for the listing to change.
//
// Spec: docs/superpowers/specs/2026-11-07-property-finder-connection-design.md §5
import { test } from "node:test";
import assert from "node:assert/strict";
import { pfNextStep, PF_LISTING_CALLS_READY } from "@nexus/shared";

const live = (fingerprint = "f1") => ({ live: true, fingerprint });
const off = { live: false, fingerprint: null };
const remote = (ref, state, fingerprint) => ({ ref, state, fingerprint });

test("a unit never sent is created", () => {
  assert.equal(pfNextStep(live(), remote(null, null, null)), "create");
  assert.equal(pfNextStep(live(), remote(null, "failed", null)), "create");
});

test("a changed listing is updated", () => {
  assert.equal(pfNextStep(live("f2"), remote("PF-1", "live", "f1")), "update");
  assert.equal(pfNextStep(live("f2"), remote("PF-1", "unpublished", "f1")), "update");
});

test("an unchanged listing that is not live is published", () => {
  for (const state of [null, "unpublished", "failed"]) {
    assert.equal(pfNextStep(live("f1"), remote("PF-1", state, "f1")), "publish", String(state));
  }
});

test("an unchanged live listing is left alone", () => {
  assert.equal(pfNextStep(live("f1"), remote("PF-1", "live", "f1")), "none");
});

test("a refusal waits for the listing to change", () => {
  assert.equal(pfNextStep(live("f1"), remote("PF-1", "refused", "f1")), "none");
  assert.equal(pfNextStep(live("f1"), remote(null, "refused", "f1")), "none");
  assert.equal(pfNextStep(live("f2"), remote("PF-1", "refused", "f1")), "update");
  assert.equal(pfNextStep(live("f2"), remote(null, "refused", "f1")), "create");
});

test("a unit that should not be live comes off only if it is live", () => {
  assert.equal(pfNextStep(off, remote("PF-1", "live", "f1")), "unpublish");
  for (const state of [null, "unpublished", "refused", "failed"]) {
    assert.equal(pfNextStep(off, remote("PF-1", state, "f1")), "none", String(state));
  }
  assert.equal(pfNextStep(off, remote(null, null, null)), "none");
});

test("the listing calls are switched off until Property Finder's format is known", () => {
  assert.equal(PF_LISTING_CALLS_READY, false);
});
