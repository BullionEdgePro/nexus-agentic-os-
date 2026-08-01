// Unit tests for the Employee Agent Layer's presence engine and twin persona
// composition. Both are pure, so these import the REAL implementations with no
// mocks and no database — the same approach as governance-policy.test.mjs.
//
// All fixed instants below are anchored to Monday 2026-08-03 and evaluated in
// Asia/Dubai (UTC+4, no DST), so the expected local times are unambiguous.
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolvePresence, composeTwinSystemPrompt, containsDigitalSignature } from "@nexus/employees";

function employee(overrides = {}) {
  return {
    id: "emp-1",
    organizationId: "org-1",
    employeeCode: "ivan",
    fullName: "Ivan Cruz",
    email: null,
    avatarUrl: null,
    jobTitle: "Sales Lead",
    department: "Sales",
    permissions: {},
    whatsappPhoneNumberId: null,
    whatsappNumber: null,
    timezone: "Asia/Dubai",
    workingHours: { mon: [{ start: "09:00", end: "18:00" }] },
    breakSchedule: {},
    languages: ["English"],
    skills: [],
    expertise: ["pricing"],
    twinEnabled: true,
    aiPersonality: "Warm and direct.",
    responseStyle: "Short sentences.",
    knowledgeCollection: null,
    escalationRules: {},
    twinDisclosure: null,
    digitalSignature: null,
    manualPresence: null,
    manualPresenceUntil: null,
    lastSeenAt: null,
    humanFirst: false,
    isActive: true,
    ...overrides,
  };
}

const MON_10AM_DUBAI = new Date("2026-08-03T06:00:00Z");
const MON_10PM_DUBAI = new Date("2026-08-03T18:00:00Z");
const TUE_2AM_DUBAI = new Date("2026-08-03T22:00:00Z");
const MON_130PM_DUBAI = new Date("2026-08-03T09:30:00Z");

test("inside working hours the employee reads as online", () => {
  const result = resolvePresence(employee(), MON_10AM_DUBAI);
  assert.equal(result.status, "online");
  assert.equal(result.source, "schedule");
});

test("outside working hours the employee is offline and the twin covers", () => {
  const result = resolvePresence(employee(), MON_10PM_DUBAI);
  assert.equal(result.status, "offline");
  assert.equal(result.shouldTwinRespond, true);
});

test("an online employee still gets twin coverage unless human_first is opted into", () => {
  // This is the anti-silence default: turning the employee layer on must never
  // stop customers getting an answer.
  assert.equal(resolvePresence(employee(), MON_10AM_DUBAI).shouldTwinRespond, true);
  assert.equal(
    resolvePresence(employee({ humanFirst: true }), MON_10AM_DUBAI).shouldTwinRespond,
    false,
    "human_first employees own their conversations while online"
  );
});

test("a scheduled break reads as busy, and the twin covers it", () => {
  const result = resolvePresence(
    employee({ breakSchedule: { mon: [{ start: "13:00", end: "14:00" }] } }),
    MON_130PM_DUBAI
  );
  assert.equal(result.status, "busy");
  assert.equal(result.shouldTwinRespond, true);
});

test("an active manual override beats the schedule, an expired one does not", () => {
  const onVacation = employee({
    manualPresence: "vacation",
    manualPresenceUntil: "2026-08-10T00:00:00Z",
  });
  const live = resolvePresence(onVacation, MON_10AM_DUBAI);
  assert.equal(live.status, "vacation");
  assert.equal(live.source, "manual");

  const expired = resolvePresence(
    employee({ manualPresence: "vacation", manualPresenceUntil: "2026-07-01T00:00:00Z" }),
    MON_10AM_DUBAI
  );
  assert.equal(expired.status, "online", "expired override must fall back to the schedule");
  assert.equal(expired.source, "schedule");
});

test("an overnight shift still counts after midnight", () => {
  // 22:00–06:00 starting Monday must still be 'on shift' at 02:00 Tuesday.
  const nightShift = employee({ workingHours: { mon: [{ start: "22:00", end: "06:00" }] } });
  assert.equal(resolvePresence(nightShift, TUE_2AM_DUBAI).status, "online");
});

test("an inactive employee stands the twin down so routing falls back to the org agent", () => {
  const result = resolvePresence(employee({ isActive: false }), MON_10AM_DUBAI);
  assert.equal(result.shouldTwinRespond, false);
  assert.equal(result.status, "offline");
});

test("an unrecognized timezone degrades to UTC instead of throwing on the hot path", () => {
  const result = resolvePresence(employee({ timezone: "Not/AZone" }), new Date("2026-08-03T10:00:00Z"));
  assert.equal(result.status, "online", "10:00 UTC on a Monday is inside 09:00-18:00");
  assert.match(result.reason, /UTC/);
});

test("twin disabled means the twin never answers, whatever the presence", () => {
  assert.equal(resolvePresence(employee({ twinEnabled: false }), MON_10PM_DUBAI).shouldTwinRespond, false);
});

// ============================================================
// Twin persona composition
// ============================================================

test("the twin prompt discloses it is an AI and never carries the digital signature", () => {
  const emp = employee({ digitalSignature: "Ivan Cruz, Licensed Broker #4471" });
  const prompt = composeTwinSystemPrompt({
    organizationPrompt: "You are the assistant for Zipicka. Never invent prices.",
    employee: emp,
  });

  assert.ok(prompt.includes("Never invent prices"), "tenant rules must survive into the twin prompt");
  assert.ok(prompt.includes("You are not Ivan Cruz"), "the twin must be told it is not the human");
  assert.ok(
    !prompt.includes("Licensed Broker #4471"),
    "the digital signature must never reach the model"
  );
});

test("digital-signature leak detection survives reformatting", () => {
  const emp = employee({ digitalSignature: "Ivan Cruz, Licensed Broker #4471" });
  assert.equal(
    containsDigitalSignature("Best regards,\nIvan   Cruz,  Licensed Broker #4471", emp),
    true,
    "collapsed whitespace and case changes must not slip past the check"
  );
  assert.equal(containsDigitalSignature("Thanks, I'll check that for you.", emp), false);
  assert.equal(
    containsDigitalSignature("anything", employee({ digitalSignature: null })),
    false,
    "no signature configured means nothing to leak"
  );
});
