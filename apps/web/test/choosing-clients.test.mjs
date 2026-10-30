/** The Clients tab's filters (30 Oct 2026): who can get a free message, who wrote this week, who went quiet. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { standingOf, matchesFilter, sinceWrote, initialsOf } from "../lib/client-filters.ts";

const now = Date.parse("2026-10-30T12:00:00Z");
const ago = (hours) => new Date(now - hours * 3_600_000).toISOString();

test("free inside 23h50m, then this week, this month, quiet, never", () => {
  assert.equal(standingOf(ago(2), now), "free");
  assert.equal(standingOf(ago(23.9), now), "week");
  assert.equal(standingOf(ago(24 * 10), now), "month");
  assert.equal(standingOf(ago(24 * 40), now), "quiet");
  assert.equal(standingOf(null, now), "never");
});

test("'wrote this week' includes today; 'quiet' is 30 days or more", () => {
  assert.equal(matchesFilter("week", ago(2), now), true);
  assert.equal(matchesFilter("week", ago(24 * 10), now), false);
  assert.equal(matchesFilter("quiet", ago(24 * 31), now), true);
  assert.equal(matchesFilter("all", null, now), true);
});

test("labels read as a person would say them", () => {
  assert.equal(sinceWrote(ago(3), now), "wrote 3h ago");
  assert.equal(sinceWrote(ago(48), now), "wrote 2 days ago");
  assert.equal(sinceWrote(null, now), "never wrote to you");
  assert.equal(initialsOf("Ahmed Al-Mansouri", "971501234567"), "AA");
  assert.equal(initialsOf(null, "971501234567"), "67");
});
