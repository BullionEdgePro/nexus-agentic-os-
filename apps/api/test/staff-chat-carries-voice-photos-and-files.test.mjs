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

// ---- Task 2: what a file really is, and how it is served -----------------------

import { sniff, checkUpload, cleanName, servedHeaders, isEmoji, TEAM_LIMITS } from "../src/lib/team-files.ts";

const bytes = (...b) => new Uint8Array([...b, ...new Array(32).fill(0)]);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const M4A = bytes(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20); // ....ftypM4A
const WEBM = bytes(0x1a, 0x45, 0xdf, 0xa3);
const HTML = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
const wave = new Array(64).fill(50);

test("a file is what its bytes say, not what its name says", () => {
  assert.equal(sniff(JPEG), "image/jpeg");
  assert.equal(sniff(PNG), "image/png");
  assert.equal(sniff(M4A), "audio/mp4");
  assert.equal(sniff(WEBM), "audio/webm");
  assert.equal(sniff(HTML), null);
});

test("a picture sent as a voice note, or a web page sent as a photo, is refused", () => {
  assert.equal(checkUpload({ kind: "voice", bytes: PNG, preview: null, durationMs: 5000, waveform: wave }).ok, false);
  assert.equal(checkUpload({ kind: "photo", bytes: HTML, preview: null }).ok, false);
  assert.equal(checkUpload({ kind: "voice", bytes: M4A, preview: null, durationMs: 400_000, waveform: wave }).ok, false);
  assert.equal(checkUpload({ kind: "voice", bytes: M4A, preview: null, durationMs: 5000, waveform: [101] }).ok, false);
  const ok = checkUpload({ kind: "voice", bytes: M4A, preview: null, durationMs: 5000, waveform: wave });
  assert.deepEqual([ok.ok, ok.mime, ok.durationMs], [true, "audio/mp4", 5000]);
  const doc = checkUpload({ kind: "file", bytes: HTML, preview: null });
  assert.deepEqual([doc.ok, doc.mime], [true, "application/octet-stream"]);
});

test("a name keeps only its last part", () => {
  assert.equal(cleanName("../../etc/passwd"), "passwd");
  assert.equal(cleanName(String.raw`C:\Users\x\cv.pdf`), "cv.pdf");
  assert.equal(cleanName("  \n "), "file");
  assert.equal(cleanName("x".repeat(300)).length, 200);
});

test("only real photos and voice notes open in the browser; everything else downloads, sandboxed", () => {
  const photo = servedHeaders({ kind: "photo", mime: "image/png", name: "a.png" });
  assert.equal(photo["Content-Type"], "image/png");
  assert.equal(photo["X-Content-Type-Options"], "nosniff");
  assert.equal(photo["Content-Security-Policy"], "sandbox");
  assert.equal(photo["Cache-Control"], "private, max-age=31536000, immutable");
  const page = servedHeaders({ kind: "file", mime: "application/octet-stream", name: "x.html" });
  assert.equal(page["Content-Type"], "application/octet-stream");
  assert.match(page["Content-Disposition"], /^attachment;/);
  const svg = servedHeaders({ kind: "file", mime: "image/svg+xml", name: "logo.svg" });
  assert.equal(svg["Content-Type"], "application/octet-stream");
});

test("a download name can never break or inject a header", () => {
  const h = servedHeaders({ kind: "file", mime: "application/octet-stream", name: 'a"b\r\nSet-Cookie: x.pdf' })["Content-Disposition"];
  assert.doesNotMatch(h, /[\r\n]/);
  assert.match(h, /filename="[ -~]*"; filename\*=UTF-8''/);
  const ar = servedHeaders({ kind: "file", mime: "application/octet-stream", name: "عرض سعر.pdf" })["Content-Disposition"];
  assert.match(ar, /filename\*=UTF-8''%D8%B9/);
});

test("a reaction is an emoji and nothing else", () => {
  for (const ok of ["👍", "❤️", "👍🏽", "🇦🇪", "1️⃣"]) assert.equal(isEmoji(ok), true, ok);
  for (const bad of ["", "<script>", "nice one", "👍".repeat(9), 7, null]) assert.equal(isEmoji(bad), false, String(bad));
});

test("the limits are the spec's", () => {
  assert.equal(TEAM_LIMITS.fileBytes, 16 * 1024 * 1024);
  assert.equal(TEAM_LIMITS.requestBytes, 17 * 1024 * 1024);
  assert.equal(TEAM_LIMITS.voiceMaxMs, 305_000);
});

// ---- Final review: an upload never holds a database connection while it arrives ----------

test("the upload gate runs before the tenant context on every API request", () => {
  const INDEX = read("apps", "api", "src", "index.ts");
  const gate = INDEX.indexOf('app.use("/api/team-chat/*", teamUploadGate)');
  const tenant = INDEX.indexOf('app.use("/api/*", tenantContext)');
  assert.ok(gate > 0, "the gate is mounted");
  assert.ok(gate < tenant, "and before the tenant context");
});
