// Staff talk to their own team — and only their own (24 Oct 2026).
//
// The owner asked for "a chat box for each of the business staff ... can talk
// to their colleague for the designated business. only." Decided with them:
// one team room per business, private 1-to-1 chats between colleagues of the
// same business, and the admin reads all of it and may post in the rooms.
// Spec: docs/superpowers/specs/2026-10-24-team-chat-design.md
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { teamAccess, directPair } from "../../../packages/db/src/team-chat.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const ZIP = "11111111-1111-1111-1111-111111111111";
const SFS = "22222222-2222-2222-2222-222222222222";
const RALPH = "aaaaaaaa-0000-0000-0000-000000000001";
const SHAH = "aaaaaaaa-0000-0000-0000-000000000002";
const AZIZ = "aaaaaaaa-0000-0000-0000-000000000003";
const KESHAV = "bbbbbbbb-0000-0000-0000-000000000001";

const room = { id: "r", organizationId: ZIP, kind: "room", memberA: null, memberB: null };
const ralphShah = { id: "d", organizationId: ZIP, kind: "direct", memberA: RALPH, memberB: SHAH };
const staff = (employeeId, organizationId) => ({ kind: "staff", employeeId, organizationId });
const admin = { kind: "admin", adminId: "admin-1", name: "Admin" };

// ---- Task 1: who may do what -------------------------------------------------

test("a staff member reads and writes in their own business's room", () => {
  assert.deepEqual(teamAccess(room, staff(RALPH, ZIP)), { read: true, post: true });
});

test("a staff member reads and writes in a direct chat they are in", () => {
  assert.deepEqual(teamAccess(ralphShah, staff(SHAH, ZIP)), { read: true, post: true });
});

test("a colleague cannot read two other people's direct chat", () => {
  assert.deepEqual(teamAccess(ralphShah, staff(AZIZ, ZIP)), { read: false, post: false });
});

test("another business's staff see nothing, room or direct", () => {
  assert.deepEqual(teamAccess(room, staff(KESHAV, SFS)), { read: false, post: false });
  assert.deepEqual(teamAccess(ralphShah, staff(KESHAV, SFS)), { read: false, post: false });
});

test("the admin reads and posts in a room, and only reads a direct chat", () => {
  assert.deepEqual(teamAccess(room, admin), { read: true, post: true });
  assert.deepEqual(teamAccess(ralphShah, admin), { read: true, post: false });
});

test("a direct pair is stored in one order, whoever starts it", () => {
  assert.deepEqual(directPair(SHAH, RALPH), directPair(RALPH, SHAH));
  assert.ok(directPair(SHAH, RALPH)[0] < directPair(SHAH, RALPH)[1]);
});

test("the tables keep one room per business, one thread per pair, one message per send", () => {
  const sql = read("packages", "db", "migrations", "101-team-chat.sql");
  for (const table of ["team_threads", "team_messages", "team_reads"]) {
    assert.match(sql, new RegExp(`create table if not exists ${table}`));
    assert.match(sql, new RegExp(`alter table ${table} enable row level security`));
    assert.match(sql, new RegExp(`grant select, insert, update, delete on ${table} to nexus_app`));
  }
  assert.match(sql, /where kind = 'room'/);
  assert.match(sql, /where kind = 'direct'/);
  assert.match(sql, /unique \(thread_id, client_id\)/);
  assert.match(sql, /member_a < member_b/);
  assert.match(sql, /char_length\(body\) between 1 and 4000/);
});

test("a retried send lands once", () => {
  const DB = read("packages", "db", "src", "team-chat.ts");
  assert.match(DB, /on conflict \(thread_id, client_id\) do nothing/);
});
