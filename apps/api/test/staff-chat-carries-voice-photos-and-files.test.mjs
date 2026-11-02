// Staff chat like a WhatsApp group: voice notes, photos, files, reactions and
// replies (2 Nov 2026).
//
// The owner asked: "make the staff chat like the whats app group chat also has
// emojis and press to hold mic option be relialble on it", and chose all four
// extras (emoji keyboard, reactions, replies, photos and files) with the files
// kept in the database beside the messages, under the same tenant policy.
// Spec: docs/superpowers/specs/2026-11-02-staff-chat-whatsapp-design.md
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { groupReactions, replySnippet } from "../../../packages/db/src/team-chat-media.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

// ---- Task 1: the data ----------------------------------------------------------

test("the migration adds files, reactions and the two message links, idempotently, under the tenant policy", () => {
  const sql = read("packages", "db", "migrations", "104-team-chat-media.sql");
  for (const table of ["team_files", "team_reactions"]) {
    assert.match(sql, new RegExp(`create table if not exists ${table}`));
    assert.match(sql, new RegExp(`alter table ${table} enable row level security`));
    assert.match(sql, new RegExp(`drop policy if exists ${table}_tenant_isolation on ${table}`));
    assert.match(sql, new RegExp(`grant select, insert, update, delete on ${table} to nexus_app`));
  }
  assert.match(sql, /kind in \('voice', 'photo', 'file'\)/);
  assert.match(sql, /duration_ms between 1000 and 305000/);
  assert.match(sql, /add column if not exists file_id uuid references team_files\(id\) on delete set null/);
  assert.match(sql, /add column if not exists reply_to uuid references team_messages\(id\) on delete set null/);
  assert.match(sql, /primary key \(message_id, reactor\)/);
  assert.match(sql, /char_length\(body\) between 1 and 4000 or \(file_id is not null and char_length\(body\) <= 4000\)/);
});

test("reactions group by emoji in first-reaction order, people in the order they reacted", () => {
  const at = (s) => `2026-11-02T10:00:0${s}Z`;
  const grouped = groupReactions([
    { message_id: "m1", emoji: "❤️", reactor: "b", reactor_name: "Bea", created_at: at(2) },
    { message_id: "m1", emoji: "👍", reactor: "a", reactor_name: "Ali", created_at: at(1) },
    { message_id: "m1", emoji: "👍", reactor: "c", reactor_name: "Cy", created_at: at(3) },
  ]);
  assert.deepEqual(grouped.get("m1"), [
    { emoji: "👍", by: [{ key: "a", name: "Ali" }, { key: "c", name: "Cy" }] },
    { emoji: "❤️", by: [{ key: "b", name: "Bea" }] },
  ]);
});

test("a quote says what was sent", () => {
  const voice = { kind: "voice", durationMs: 12_400, name: "voice.m4a" };
  assert.deepEqual(replySnippet({ body: "", deletedAt: null }, voice), { snippet: "🎤 Voice note 0:12", removed: false });
  assert.equal(replySnippet({ body: "", deletedAt: null }, { kind: "photo", name: "x.jpg" }).snippet, "📷 Photo");
  assert.equal(replySnippet({ body: "see this", deletedAt: null }, { kind: "photo", name: "x.jpg" }).snippet, "📷 see this");
  assert.equal(replySnippet({ body: "", deletedAt: null }, { kind: "file", name: "price-list.pdf" }).snippet, "📄 price-list.pdf");
  assert.equal(replySnippet({ body: "x".repeat(200), deletedAt: null }, null).snippet.length, 120);
  assert.deepEqual(replySnippet({ body: "", deletedAt: "2026-11-02" }, null), { snippet: "Message removed", removed: true });
});

test("removing a message wipes its file in the same statement batch, and a retry finds the first send", () => {
  const DB = read("packages", "db", "src", "team-chat.ts");
  const remove = DB.slice(DB.indexOf("export async function removeTeamMessage"));
  assert.match(remove.slice(0, remove.indexOf("\n}\n")), /update team_files set bytes = null, preview = null, deleted_at = now\(\)/);
  assert.match(read("packages", "db", "src", "team-chat-media.ts"), /where thread_id = \$1 and client_id = \$2/);
});
