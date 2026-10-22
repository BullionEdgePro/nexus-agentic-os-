// A campaign says what it is waiting for.
//
// FOUND 22 OCT 2026. Ten staff were allowed to send campaigns; one could. The
// other nine opened the Campaigns screen and met a disabled picker with no
// reason: no number of their own (the shared one was switched off on 6 Oct),
// no approved message on the number they did have, or nobody in their book.
// Each of those has a different fix, and only one of them is the staff
// member's to make, so the screen has to say which.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { readinessFrom } from "../src/services/campaign-readiness.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROUTE = readFileSync(join(here, "..", "src", "routes", "my-campaigns.ts"), "utf8");
const EMPLOYEES = readFileSync(join(here, "..", "src", "routes", "employees.ts"), "utf8");

const ready = { canBroadcast: true, ownNumber: true, numberRetired: true, approved: 2, pending: 0, clients: 56 };
const check = (checks, key) => checks.find((c) => c.key === key);

test("everything in place: four green checks, in the order a person fixes them", () => {
  const checks = readinessFrom(ready);
  assert.deepEqual(checks.map((c) => c.key), ["allowed", "number", "message", "clients"]);
  assert.ok(checks.every((c) => c.ok === true));
});

test("not allowed to send: the owner turns it on", () => {
  const c = check(readinessFrom({ ...ready, canBroadcast: false }), "allowed");
  assert.equal(c.ok, false);
  assert.match(c.fix, /owner/i);
});

test("no own number and the shared one switched off: connect in Connections", () => {
  const c = check(readinessFrom({ ...ready, ownNumber: false, numberRetired: true }), "number");
  assert.equal(c.ok, false);
  assert.match(c.fix, /Connections/);
});

test("no own number but the shared one still on: that counts", () => {
  assert.equal(check(readinessFrom({ ...ready, ownNumber: false, numberRetired: false }), "number").ok, true);
});

test("messages submitted but not yet approved: it says it is waiting for WhatsApp", () => {
  const c = check(readinessFrom({ ...ready, approved: 0, pending: 2 }), "message");
  assert.equal(c.ok, false);
  assert.match(c.detail, /waiting for WhatsApp to approve/);
});

test("no message on the number at all: it says so", () => {
  const c = check(readinessFrom({ ...ready, approved: 0, pending: 0 }), "message");
  assert.equal(c.ok, false);
  assert.match(c.detail, /no message on your number yet/);
});

test("an empty book: nobody to send to", () => {
  const c = check(readinessFrom({ ...ready, clients: 0 }), "clients");
  assert.equal(c.ok, false);
  assert.ok(c.fix);
});

test("the send refuses unless every check is green, using the same function", () => {
  assert.match(ROUTE, /campaignReadiness\(/);
  assert.match(ROUTE, /readiness\.some\(\(c\) => c\.ok !== true\)/);
});

test("the owner's view is operator-only", () => {
  const at = EMPLOYEES.indexOf('"/:slug/campaign-readiness"');
  assert.ok(at > 0, "route exists");
  assert.match(EMPLOYEES.slice(at, at + 400), /role !== "operator"/);
});
