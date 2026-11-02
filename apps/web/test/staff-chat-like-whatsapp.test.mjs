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

// ---- Task 7: photo sizes, name colours and message runs ------------------------------

import { fitWithin, SHRINK } from "@/lib/team-chat/shrink-image";
import { nameColourIndex } from "@/lib/team-chat/name-colour";
import { groupRuns } from "@/lib/team-chat/runs";

function lum(hex) {
  return [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

test("a photo is shrunk to 1600 on its longest side, never enlarged", () => {
  assert.deepEqual(SHRINK, { longest: 1600, quality: 0.82, previewLongest: 320 });
  assert.deepEqual(fitWithin(4032, 3024, 1600), { width: 1600, height: 1200 });
  assert.deepEqual(fitWithin(900, 1600, 320), { width: 180, height: 320 });
  assert.deepEqual(fitWithin(800, 600, 1600), { width: 800, height: 600 });
});

test("each colleague keeps one colour", () => {
  const id = "aaaaaaaa-0000-0000-0000-000000000001";
  assert.equal(nameColourIndex(id), nameColourIndex(id));
  const used = new Set(Array.from({ length: 40 }, (_, i) => nameColourIndex(`aaaaaaaa-0000-0000-0000-${String(i).padStart(12, "0")}`)));
  assert.ok(used.size >= 6, `only ${used.size} of 8 colours used across 40 people`);
  for (const i of used) assert.ok(i >= 0 && i <= 7);
});

test("every name colour reads on both bubbles", () => {
  const css = read("app/team-chat/team-chat.css");
  const all = [...css.matchAll(/--tc-name-(\d): (#[0-9A-Fa-f]{6})/g)].map((m) => m[2]);
  const light = all.slice(0, 8);
  const dark = all.slice(8, 16);
  assert.equal(light.length, 8);
  assert.equal(dark.length, 8);
  for (const c of light) assert.ok(contrast(c, "#FFFEFB") >= 4.5, c);
  for (const c of dark) assert.ok(contrast(c, "#1D1A15") >= 4.5, c);
});

test("a run of messages from one person shows the name once", () => {
  const m = (who, min) => ({
    authorEmployeeId: who,
    authorIsAdmin: false,
    createdAt: `2026-11-02T10:${String(min).padStart(2, "0")}:00Z`,
    deletedAt: null,
  });
  assert.deepEqual(groupRuns([m("a", 0), m("a", 1), m("b", 2), m("b", 9)]), [true, false, true, true]);
  const admin = { authorEmployeeId: null, authorIsAdmin: true, createdAt: "2026-11-02T10:03:00Z", deletedAt: null };
  assert.deepEqual(groupRuns([m("a", 0), admin, admin]), [true, true, false]);
  assert.deepEqual(groupRuns([]), []);
});

// ---- Task 8: the emoji list and emoji search -----------------------------------------

import { searchEmoji, withTone, pushRecent, RECENT_KEY } from "@/lib/team-chat/emoji-search";

const EMOJI = JSON.parse(read("public/emoji/en.json"));

test("the emoji list is Emoji 15.0, with search names, and no bare skin-tone swatches", () => {
  assert.equal(EMOJI.version, "15.0");
  const all = EMOJI.groups.flatMap((g) => g.emojis);
  assert.ok(all.length > 1300, `${all.length} emojis`);
  assert.ok(!EMOJI.groups.some((g) => /component/i.test(g.label)));
  assert.ok(!all.some((x) => /[\u{1F3FB}-\u{1F3FF}]/u.test(x.e)), "tone variants are built at runtime, not listed");
  assert.ok(all.find((x) => x.e === "👍").t === 1, "thumbs up takes skin tones");
  assert.equal(EMOJI.groups[0].id, "smileys");
});

test("searching finds the obvious ones", () => {
  assert.ok(searchEmoji(EMOJI, "heart").includes("❤️"));
  assert.ok(searchEmoji(EMOJI, "thumbs").includes("👍"));
  assert.ok(searchEmoji(EMOJI, "LAUGH").length > 0);
  assert.deepEqual(searchEmoji(EMOJI, "zzzznothing"), []);
  assert.deepEqual(searchEmoji(EMOJI, "   "), []);
  assert.ok(searchEmoji(EMOJI, "face").length <= 48);
});

test("skin tones and recents", () => {
  assert.equal(withTone("👍", 3), "👍🏽");
  assert.equal(withTone("👍", 0), "👍");
  assert.equal(withTone("☝️", 1), "☝🏻");
  assert.equal(RECENT_KEY, "nexus-emoji-recent");
  assert.deepEqual(pushRecent(["😀", "👍"], "👍"), ["👍", "😀"]);
  assert.equal(pushRecent(Array.from({ length: 30 }, (_, i) => String(i)), "x").length, 24);
});

test("the emoji list loads only when the panel opens", () => {
  assert.match(read("app/team-chat/emoji-panel.tsx"), /fetch\("\/emoji\/en\.json"\)/);
});

// ---- Task 9: the WhatsApp look ---------------------------------------------------------

test("the thread draws WhatsApp's way: tails on run starts, names in colour, ticks, a day pill and an unread strip", () => {
  const T = read("app/team-chat-thread.tsx");
  assert.match(T, /groupRuns\(/);
  assert.match(T, /data-name=\{[^}]*nameColourIndex\(/);
  for (let i = 0; i < 8; i += 1) {
    assert.match(read("app/team-chat/team-chat.css"), new RegExp(`\\.tc-author\\[data-name="${i}"\\] \\{ color: var\\(--tc-name-${i}\\)`));
  }
  assert.match(T, /data-state=\{/);
  assert.match(T, /unread message/);
  assert.match(T, /import "\.\/team-chat\/team-chat\.css"/);
  const CSS = read("app/team-chat/team-chat.css");
  assert.match(CSS, /--tc-wallpaper: url\("data:image\/svg\+xml/);
  assert.match(CSS, /\.tc-msg\.first[^{]*::before/); // the tail
  assert.match(CSS, /\.tc-day \{[^}]*position: sticky/);
  assert.doesNotMatch(CSS, /rgba\(0,\s*0,\s*0/);
});

test("the bubbles move only when motion is welcome", () => {
  const CSS = read("app/team-chat/team-chat.css");
  const at = CSS.indexOf("@media (prefers-reduced-motion: no-preference)");
  assert.ok(at > 0);
  assert.match(CSS.slice(at), /tc-rise/);
  assert.doesNotMatch(CSS.slice(0, at), /animation:/);
});

test("a quote jumps to the message it quotes, loading earlier pages if it must", () => {
  const T = read("app/team-chat-thread.tsx");
  assert.match(T, /scrollIntoView\(\{ block: "center"/);
  assert.match(T, /thread\.loadEarlier\(\)/);
  assert.match(T, /That message is older than this chat shows\./);
});

test("the header lists the members, and the old stylesheet is gone", () => {
  const PAGE = read("app/deck/team-chat/page.tsx");
  assert.match(PAGE, /className="tc-members"/);
  assert.match(PAGE, /aria-expanded=\{showMembers\}/);
  assert.match(PAGE, /unreadAtOpen=\{/);
  assert.throws(() => read("app/deck/team-chat/team-chat.css"));
});

// ---- Task 10: one message box for the page and the dock --------------------------------

test("the page and the inbox dock use the one message box, fresh for each chat", () => {
  const PAGE = read("app/deck/team-chat/page.tsx");
  const DOCK = read("app/inbox/team-dock.tsx");
  assert.match(PAGE, /<TeamComposer[\s\S]{0,80}key=\{active\.id\}/);
  assert.match(DOCK, /<TeamComposer[\s\S]{0,80}key=\{active\.id\}/);
  assert.doesNotMatch(DOCK, /<textarea/);
  assert.doesNotMatch(PAGE, /<textarea/);
});

test("the round button is a mic when empty and send once there is text", () => {
  const C = read("app/team-chat/composer.tsx");
  assert.match(C, /draft\.trim\(\) \? \(/);
  assert.match(C, /aria-label="Send"/);
  assert.match(C, /<VoiceRecorder/);
  assert.match(C, /<AttachButton/);
  assert.match(C, /if \(!thread\.canPost\) return null;/);
});

test("a reply shows its quote above the box and can be cleared", () => {
  const C = read("app/team-chat/composer.tsx");
  assert.match(C, /thread\.replyingTo/);
  assert.match(C, /aria-label="Cancel reply"/);
});

test("sending plays the pop, and @mentions still work", () => {
  const C = read("app/team-chat/composer.tsx");
  assert.match(C, /play\("pop"\)/);
  assert.match(C, /thread\.send\(body, mentions\)/);
  assert.match(C, /role="listbox" aria-label="Mention a colleague"/);
});

test("the emoji keyboard searches, remembers recents safely, and offers skin tones", () => {
  const P = read("app/team-chat/emoji-panel.tsx");
  assert.match(P, /searchEmoji\(/);
  assert.match(P, /try \{[\s\S]{0,160}localStorage/);
  assert.match(P, /withTone\(/);
  assert.match(P, /Escape/);
});

// ---- Task 11: press and hold to record, and playing a note -----------------------------

test("recording picks a type every phone can play, and the mic is let go on every way out", () => {
  const R = read("app/team-chat/voice-recorder.tsx");
  assert.match(R, /\["audio\/mp4", "audio\/webm;codecs=opus", "audio\/ogg;codecs=opus"\]/);
  assert.match(R, /getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/);
  assert.match(R, /!micOn\(state\.phase\)/);
  assert.match(R, /onPointerCancel/);
  assert.match(R, /setPointerCapture/);
  assert.match(R, /visibilitychange/);
  assert.match(R, /Hold to record, release to send/);
  assert.match(R, /‹ Slide to cancel/);
  assert.match(R, /play\("tick"\)/);
  assert.match(R, /play\("whoosh"\)/);
  assert.match(R, /Nexus can't use your microphone\. Allow it in your browser's site settings, then try again\./);
});

test("a recording with no sound recorded is never sent", () => {
  const R = read("app/team-chat/voice-recorder.tsx");
  assert.match(R, /if \(!blob \|\| blob\.size === 0\)/);
});

test("a voice note is fetched once with credentials, plays one at a time, and falls back to a download", () => {
  const V = read("app/team-chat/voice-note.tsx");
  assert.match(V, /credentials: "include"/);
  assert.match(V, /URL\.createObjectURL/);
  assert.match(V, /canPlayType\(/);
  assert.match(V, /playbackRate/);
  assert.match(V, /nowPlaying/);
  assert.match(V, /data-voice-note/);
  // The not-yet-played dot is per device, and never breaks without storage.
  assert.match(V, /"nexus-voice-played"/);
  assert.match(V, /try \{[\s\S]{0,200}localStorage/);
  assert.match(read("app/team-chat/file-bubble.tsx"), /<VoiceNote/);
});

// ---- Task 12: photos and files ----------------------------------------------------------

test("photos are shrunk on the device, and one the browser cannot read goes as a document", () => {
  const A = read("app/team-chat/attach.tsx");
  assert.match(A, /shrinkImage\(/);
  assert.match(A, /kind: "file"/);
  assert.match(A, /accept="image\/\*"/);
  assert.match(A, /capture="environment"/);
  assert.match(A, /onPaste/);
  assert.match(A, /onDrop/);
});

test("each upload shows progress and can be cancelled", () => {
  const T = read("app/team-chat-thread.tsx");
  assert.match(T, /p\.file\.progress/);
  assert.match(T, /thread\.cancel\(p\.clientId\)/);
});

test("limits are told before sending, not after", () => {
  const A = read("app/team-chat/attach.tsx");
  assert.match(A, /16 MB/);
  assert.match(A, /refused/);
});

test("a photo opens full screen, zooms, downloads and closes with Escape", () => {
  const V = read("app/team-chat/photo-viewer.tsx");
  assert.match(V, /useFileBlob\(/);
  assert.match(V, /Escape/);
  assert.match(V, /downloadFile\(/);
  assert.match(V, /onWheel/);
  assert.match(read("app/team-chat-thread.tsx"), /<PhotoViewer/);
  assert.match(read("app/team-chat/composer.tsx"), /<AttachSheet/);
});
