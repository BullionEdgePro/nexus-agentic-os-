// The dispatcher only listens (spec 2026-10-09-nexus-mobile-app-design.md,
// "Push notifications"). It hears the same inbox events the web inbox hears and
// tells people's phones; it must never be able to send a customer anything,
// never wake a device its owner paused, and never let one dead phone hold up
// the rest. Device filtering runs for real; the wiring is pinned as text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { devicesFor } from "../src/services/push-dispatcher.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8").replace(/\r\n/g, "\n");
const DISPATCHER = read("src", "services", "push-dispatcher.ts");
const HEALTH = read("src", "lib", "jobs-health.ts");
const WORKER = read("src", "worker.ts");

const device = (id, subject, mode) => ({ id, subject, mode, previews: false, endpoint: `https://push/${id}`, p256dh: "k", auth: "a" });
const SUBS = [
  device("d1", "e:e1", "mine"),
  device("d2", "e:e1", "all"),
  device("d3", "e:e1", "paused"),
  device("d4", "e:e2", "all"),
  device("d5", "e:e2", "mine"),
];
const ids = (subs) => subs.map((s) => s.id).sort();

test("a paused device is never woken", () => {
  assert.deepEqual(ids(devicesFor(SUBS, [{ subjects: ["e:e1"], requiresMode: "mine" }])), ["d1", "d2"]);
});

test("'everything' reaches only devices set to all; 'mine' reaches mine and all", () => {
  assert.deepEqual(ids(devicesFor(SUBS, [{ subjects: ["e:e2"], requiresMode: "all" }])), ["d4"]);
  assert.deepEqual(ids(devicesFor(SUBS, [{ subjects: ["e:e2"], requiresMode: "mine" }])), ["d4", "d5"]);
});

test("a device named twice is told once", () => {
  const twice = devicesFor(SUBS, [
    { subjects: ["e:e2"], requiresMode: "mine" },
    { subjects: ["e:e2"], requiresMode: "all" },
  ]);
  assert.deepEqual(ids(twice), ["d4", "d5"]);
});

test("someone else's devices are not reached by being nearby", () => {
  assert.deepEqual(devicesFor(SUBS, [{ subjects: ["e:e9"], requiresMode: "mine" }]), []);
});

test("the dispatcher cannot reach a customer", () => {
  for (const banned of ["sendWhatsAppText", "insertOutboundMessage", "reply-dispatch", "whatsapp-client", "messenger-client", "publishInboxEvent"]) {
    assert.ok(!DISPATCHER.includes(banned), `push-dispatcher must not touch ${banned}`);
  }
  assert.match(DISPATCHER, /subscribeToInboxEvents\(/);
});

test("who is on shift comes from the presence engine, for the business serving the chat", () => {
  assert.match(DISPATCHER, /listEmployees\(facts\.servingOrganizationId\)/);
  assert.match(DISPATCHER, /active: employee\.isActive/);
  assert.match(DISPATCHER, /resolvePresence\(employee/);
});

test("every send is recorded, and no device waits on another", () => {
  assert.match(DISPATCHER, /Promise\.allSettled\(/);
  assert.match(DISPATCHER, /recordPushOutcome\(sub\.id, outcome\)/);
});

test("the owner hears about a broken platform once per problem per 6 hours", () => {
  assert.match(DISPATCHER, /computeJobsHealth\(\)/);
  assert.match(DISPATCHER, /`push:platform:\$\{/);
  assert.match(DISPATCHER, /"EX", 21_?600, "NX"/);
  assert.match(DISPATCHER, /5 \* 60 \* 1000/);
  assert.match(HEALTH, /export async function computeJobsHealth\(/);
  assert.match(HEALTH, /return Date\.parse\(lastErrorAt\) > Date\.parse\(lastFinishedAt\);/, "same 'last run failed' rule as /health/jobs");
});

test("without keys the dispatcher stays off and says so once", () => {
  assert.match(DISPATCHER, /if \(!pushConfigured\(\)\)/);
  assert.match(WORKER, /startPushDispatcher\(\)/);
});
