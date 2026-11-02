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
