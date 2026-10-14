// Every business is checked every morning (Business HQ spec §7). A daily job
// at 06:00 Dubai time, "Check now" at most once per 5 minutes per business, the
// job watched by /health/jobs like every other, and the owner's phone told once
// a day per critical problem — not once per check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SCHEDULED_JOBS, JOB_STALE_AFTER_SECONDS } from "@nexus/shared";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8").replace(/\r\n/g, "\n");
const QUEUE = read("src", "queue", "hq-checks-queue.ts");
const PROC = read("src", "queue", "hq-checks-processor.ts");
const WORKER = read("src", "worker.ts");
const PUSH = read("src", "services", "push-dispatcher.ts");

test("the checks run at 6 every morning, Dubai time", () => {
  assert.match(QUEUE, /export const HQ_CHECKS_QUEUE = "hq-checks";/);
  assert.match(QUEUE, /pattern: "0 6 \* \* \*"/);
  assert.match(QUEUE, /tz: "Asia\/Dubai"/);
  assert.match(WORKER, /scheduleHqChecks\(\)/);
  assert.match(WORKER, /new Worker\(HQ_CHECKS_QUEUE/);
});

test("the job is watched like every other scheduled job", () => {
  assert.ok(SCHEDULED_JOBS.includes("hq-checks"));
  assert.equal(JOB_STALE_AFTER_SECONDS["hq-checks"], 30 * 3600, "a daily job absorbs a deploy, like the others");
  assert.match(PROC, /withJobHeartbeat\("hq-checks"/);
});

test("the review sandbox and switched-off businesses are not checked", () => {
  assert.match(PROC, /slug !== "review-demo"/);
  assert.match(PROC, /isActive/);
});

test("Check now is refused within 5 minutes of the last one", () => {
  assert.match(QUEUE, /`hq:checknow:\$\{organizationId\}`/);
  assert.match(QUEUE, /"EX", 300, "NX"/);
  assert.match(QUEUE, /return "too-soon";/);
});

test("the owner hears about a critical problem once a day, not on every check", () => {
  assert.match(PROC, /notifyOwnersOfHqCritical\(/);
  assert.match(PROC, /severity === "critical"/);
  assert.match(PUSH, /export async function notifyOwnersOfHqCritical\(/);
  assert.match(PUSH, /`push:hq:\$\{org\.id\}:\$\{issue\.code\}`/);
  assert.match(PUSH, /"EX", 86_?400, "NX"/);
});

// FINAL REVIEW, Important 1: the domain typed in Business HQ was saved and
// never checked — the worker always used organizations.website_url.
test("the website address an admin typed is the one that gets checked", () => {
  assert.match(PROC, /getHqProfile\(/);
  assert.match(PROC, /websiteUrl: profile\?\.domain \|\| business\.websiteUrl/);
});
