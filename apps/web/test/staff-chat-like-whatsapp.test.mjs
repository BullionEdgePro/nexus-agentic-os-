/**
 * Staff chat like a WhatsApp group (2 Nov 2026): voice notes you press and
 * hold to record, an emoji keyboard, reactions, replies, photos and files, in
 * WhatsApp's layout and Nexus's Cream colours.
 * Spec: docs/superpowers/specs/2026-11-02-staff-chat-whatsapp-design.md
 *
 * Every rule that can be decided without a browser — what a press, a slide or
 * a scroll does to a recording, how a photo is sized, which colour a name
 * takes, what a reaction tap does — lives in a small module under
 * lib/team-chat and is tested here directly. The screens are checked for
 * using those modules and for the copy the spec fixes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { toggleReaction, mineOf } from "@/lib/team-chat/reactions";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// ---- Task 5: the client, live events and the thread hook -------------------------

const me = { key: "a", name: "Ali" };

test("tapping the same emoji takes my reaction off; another one replaces it", () => {
  const start = [{ emoji: "👍", by: [{ key: "a", name: "Ali" }, { key: "b", name: "Bea" }] }];
  assert.deepEqual(toggleReaction(start, "👍", me), [{ emoji: "👍", by: [{ key: "b", name: "Bea" }] }]);
  assert.deepEqual(toggleReaction(start, "❤️", me), [
    { emoji: "👍", by: [{ key: "b", name: "Bea" }] },
    { emoji: "❤️", by: [{ key: "a", name: "Ali" }] },
  ]);
  assert.equal(mineOf(start, "a"), "👍");
  assert.equal(mineOf(start, "z"), null);
  assert.deepEqual(toggleReaction([{ emoji: "👍", by: [me] }], "👍", me), []);
});

test("an upload carries its thread, keeps its id and file for a retry, and sends the preview header", () => {
  const HOOK = read("lib/use-team-thread.ts");
  assert.match(HOOK, /function retry\(pending: PendingMessage\)[\s\S]{0,400}pending\.clientId/);
  assert.match(HOOK, /uploadTeamMessage\(\s*item\.threadId/);
  const API = read("lib/api.ts");
  const up = API.slice(API.indexOf("export function uploadTeamMessage"));
  assert.match(up.slice(0, 2000), /withCredentials = true/);
  assert.match(up.slice(0, 2000), /x-nexus-view-as/);
});

test("a finished upload only ever lands in the thread it was made in", () => {
  const HOOK = read("lib/use-team-thread.ts");
  const deliver = HOOK.slice(HOOK.indexOf("async function deliver"));
  assert.match(deliver.slice(0, 1800), /activeRef\.current === item\.threadId/);
});

test("live reactions and room read positions reach the open thread", () => {
  assert.match(read("lib/use-team-socket.ts"), /"team_reaction"/);
  const HOOK = read("lib/use-team-thread.ts");
  assert.match(HOOK, /event\.type === "team_reaction"/);
  assert.match(HOOK, /event\.seenByAllAt/);
});

test("files and reactions are addressed through their thread, and each screen knows its own key", () => {
  const API = read("lib/api.ts");
  assert.match(API, /`\/api\/team-chat\/threads\/\$\{threadId\}\/files\/\$\{id\}\/preview`/);
  assert.match(API, /`\/api\/team-chat\/threads\/\$\{threadId\}\/messages\/\$\{messageId\}\/reaction`/);
  assert.match(API, /key: string;/);
  assert.match(read("app/deck/team-chat/page.tsx"), /useTeamThread\([\s\S]{0,160}data\?\.me\.key/);
  assert.match(read("app/inbox/team-dock.tsx"), /useTeamThread\([\s\S]{0,160}data\?\.me\.key/);
});

// ---- Task 6: the recorder's rules, the waveform and the gestures --------------------

import { step, INITIAL, RECORDER, micOn, elapsedMs } from "@/lib/team-chat/recorder";
import { foldPeaks, formatClock } from "@/lib/team-chat/waveform";
import { GESTURES, swipeReply, isLongPress } from "@/lib/team-chat/gestures";

const press = (pointer = "touch", at = 0) => step(INITIAL, { type: "press", at, x: 100, y: 100, pointer });
const run = (state, ...events) => events.reduce(step, state);

test("recorder numbers are the spec's", () => {
  assert.deepEqual(RECORDER, { cancelPx: 96, lockPx: 72, clickMs: 300, minMs: 1000, maxMs: 300_000 });
  assert.deepEqual(GESTURES, { holdMs: 450, swipePx: 64 });
});

test("press and hold starts recording", () => {
  assert.equal(press().phase, "holding");
  assert.equal(micOn("holding"), true);
});

test("sliding left 96 px cancels; sliding up 72 px locks", () => {
  assert.equal(run(press(), { type: "move", x: 4, y: 100 }).phase, "cancelled"); // 96 px left
  assert.equal(run(press(), { type: "move", x: 10, y: 100 }).phase, "holding"); // 90 px: not yet
  assert.equal(run(press(), { type: "move", x: 100, y: 28 }).phase, "locked");
});

test("a mouse click goes straight to the locked bar", () => {
  assert.equal(run(press("mouse"), { type: "release", at: 200 }).phase, "locked");
});

test("letting go under a second is too short; after that it sends", () => {
  assert.equal(run(press(), { type: "release", at: 600 }).phase, "too-short");
  assert.equal(run(press("mouse"), { type: "release", at: 700 }).phase, "too-short");
  const sent = run(press(), { type: "release", at: 4200 });
  assert.equal(sent.phase, "sending");
  assert.equal(sent.recordedMs, 4200);
});

test("a scroll that steals the press keeps the recording for review, never sends it, never leaves the mic on", () => {
  const s = run(press(), { type: "browser-cancel", at: 4000 });
  assert.equal(s.phase, "review");
  assert.equal(s.reviewReason, "interrupted");
  assert.equal(s.recordedMs, 4000);
  assert.equal(micOn(s.phase), false);
});

test("hiding the tab pauses into review, from holding, locked or paused", () => {
  assert.equal(run(press(), { type: "hidden", at: 2000 }).phase, "review");
  const locked = run(press(), { type: "move", x: 100, y: 20 });
  assert.equal(run(locked, { type: "hidden", at: 3000 }).reviewReason, "interrupted");
  assert.equal(run(locked, { type: "pause", at: 3000 }, { type: "hidden", at: 9000 }).phase, "review");
});

test("five minutes stops into review so nothing is cut and lost", () => {
  const s = run(press(), { type: "tick", at: 299_000 });
  assert.equal(s.phase, "holding");
  const done = run(s, { type: "tick", at: 300_000 });
  assert.equal(done.phase, "review");
  assert.equal(done.reviewReason, "limit");
  assert.equal(done.recordedMs, 300_000);
});

test("pause stops the clock, resume restarts it", () => {
  const locked = run(press(), { type: "move", x: 100, y: 20 });
  const paused = run(locked, { type: "pause", at: 5000 });
  assert.equal(paused.phase, "paused");
  assert.equal(micOn("paused"), true);
  assert.equal(elapsedMs(paused, 60_000), 5000);
  const resumed = run(paused, { type: "resume", at: 60_000 });
  assert.equal(resumed.phase, "locked");
  assert.equal(elapsedMs(resumed, 62_000), 7000);
  assert.equal(run(resumed, { type: "stop", at: 63_000 }).reviewReason, "stopped");
});

test("from the locked bar or review: send, or delete", () => {
  const locked = run(press(), { type: "move", x: 100, y: 20 });
  assert.equal(run(locked, { type: "send", at: 3000 }).phase, "sending");
  assert.equal(run(locked, { type: "send", at: 500 }).phase, "too-short");
  assert.equal(run(locked, { type: "delete" }).phase, "cancelled");
  const review = run(locked, { type: "stop", at: 3000 });
  assert.equal(run(review, { type: "send", at: 9000 }).phase, "sending");
  assert.equal(run(review, { type: "send", at: 9000 }).recordedMs, 3000);
  assert.equal(run(review, { type: "delete" }).phase, "cancelled");
});

test("a blocked microphone, and reset", () => {
  assert.equal(run(press(), { type: "denied" }).phase, "denied");
  assert.equal(run(press(), { type: "reset" }).phase, "idle");
});

test("every way out of recording turns the microphone off", () => {
  for (const phase of ["idle", "review", "sending", "cancelled", "too-short", "denied"]) assert.equal(micOn(phase), false, phase);
});

test("the waveform is 64 bars from 0 to 100, loudest at 100", () => {
  const bars = foldPeaks(Array.from({ length: 640 }, (_, i) => (i % 64) / 64));
  assert.equal(bars.length, 64);
  assert.equal(Math.max(...bars), 100);
  assert.ok(bars.every((b) => Number.isInteger(b) && b >= 0 && b <= 100));
  assert.deepEqual(foldPeaks([], 64), new Array(64).fill(0));
  assert.equal(foldPeaks([0.2, 0.4], 64).length, 64);
  assert.equal(formatClock(12_400), "0:12");
  assert.equal(formatClock(300_000), "5:00");
});

test("a swipe right replies, a hold opens reactions", () => {
  assert.equal(swipeReply(70, 5), true);
  assert.equal(swipeReply(70, 40), false);
  assert.equal(swipeReply(40, 0), false);
  assert.equal(isLongPress(460, 3), true);
  assert.equal(isLongPress(460, 20), false);
  assert.equal(isLongPress(300, 0), false);
});
