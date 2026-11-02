# Staff chat like a WhatsApp group — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Team chat (the room and direct chats, on its page and in the inbox dock) looks and works like a WhatsApp group in Cream colours, with press-and-hold voice notes, an emoji keyboard, reactions, replies, photos and files.

**Architecture:** One idempotent migration adds `team_files` and `team_reactions` and two links on `team_messages`; files are bytea under the existing tenant policy. The existing `/api/team-chat` route accepts multipart sends and gains file, reaction and read-position endpoints; every rule that can be pure (type sniffing, limits, recorder state, gestures, waveform, image sizes, emoji search, name colours, run grouping) lives in a small module tested without a browser. The screen keeps `useTeamThread` and `ThreadMessages` and adds one shared `TeamComposer` for the page and the dock.

**Tech Stack:** Next.js 14 App Router, React 18, Hono 4 on Node, Postgres via `pg` (`withTenant` wraps each call in one transaction), Redis pub/sub for live events, node:test with tsx. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-11-02-staff-chat-whatsapp-design.md`

## Global Constraints

- No new npm dependency, web or API. Browser-native MediaRecorder, Web Audio, canvas, XMLHttpRequest.
- Limits (one place each side, `TEAM_LIMITS`): photo 5 MB after shrinking; photo preview 200 KB; file 16 MB; voice 6 MB and 5 minutes (client stops at 300 000 ms, server accepts `durationMs` 1000–305 000); whole request 17 MB; waveform ≤128 values each 0–100 (client sends 64); text 4000 characters (0 allowed when a file is attached).
- Gesture numbers: slide-to-cancel 96 px left; lock 72 px up; a mouse press released within 300 ms is a click; under 1000 ms is too short to send; reaction hold 450 ms; swipe-to-reply 64 px right.
- Photo shrink: longest side 1600 px, JPEG quality 0.82; preview longest side 320 px. GIFs are not re-encoded.
- Recording type preference: `audio/mp4`, then `audio/webm;codecs=opus`, then `audio/ogg;codecs=opus`. Mono.
- Emoji data: Emoji 15.0 and earlier, from Unicode `emoji-test.txt` 15.0 and CLDR English annotations, committed as `apps/web/public/emoji/en.json`, fetched on first panel open.
- Name colours (index = stable hash of employee id mod 8; the admin is ink). Light, on `#FFFEFB`: `#A8461F #2F5D50 #7A3B69 #1F6B75 #875400 #A23A5A #3F4F9A #5B6B1E`. Warm Night, on `#1D1A15`: `#E0835A #6FA892 #C98BB9 #6EC1CB #E9B65C #E88AA5 #9AA8F0 #B5C46A`. Every one ≥4.5:1.
- Copy, verbatim: "Hold to record, release to send", "‹ Slide to cancel", "Not sent · Retry", "Message removed", "N unread messages" (N the number), "Your admin can read team chats." (kept), "Read only — between" (kept).
- Sounds via part 1's `play()` from `@/lib/sound`: `pop` on send, `tick` on record start, `whoosh` on cancel; incoming keeps `ping`. Motion only inside `@media (prefers-reduced-motion: no-preference)`.
- No pure black `rgba(0,0,0,…)` in any stylesheet (part 1 guardrail); colours come from tokens.
- Every write and fetch keeps the existing rule: `teamAccess` plus `sameBusiness`, and anything not yours is `404 {"error":"Not found"}`.
- The `x-nexus-view-as` preview header rides on every request, uploads included.
- Commits stay local on branch `staff-chat-whatsapp` until the owner says "Deploy it". End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A press that the browser cancels** (`pointercancel` when a phone starts a scroll, or a second finger) must leave the recorder in review with the audio kept, never stuck recording with the mic on, and never sent.
2. **Switching threads, or leaving the page, mid-recording or mid-upload:** the mic is released, the pending upload still goes to the thread it was made in, and it never appears in the newly opened thread.
3. **A reaction that is not an emoji** (`"<script>"`, a long sentence, an empty string) is refused 400, and nothing is stored or published.
4. **A file name carrying a path** (`../../etc/passwd`, `C:\Users\x\cv.pdf`) is stored as its last part only (`passwd`, `cv.pdf`), and an empty result becomes `file`.
5. **A file name with quotes, newlines or non-Latin letters** (`a"b\r\n.pdf`, `عرض سعر.pdf`) is served with a safe `Content-Disposition` (`filename*=UTF-8''…` percent-encoded, plain `filename` ASCII-only), never a broken or injected header.

Each line has its test in the task that owns the code: 1 → Task 6, 2 → Tasks 5 and 10, 3 → Task 4, 4 and 5 → Task 2.

---

### Task 1: Migration 104 and the data layer for files, replies and reactions

**Files:**
- Create: `packages/db/migrations/104-team-chat-media.sql`
- Create: `packages/db/src/team-chat-media.ts`
- Modify: `packages/db/src/team-chat.ts` (MessageRow, toMessage, MESSAGE_COLUMNS, postTeamMessage, removeTeamMessage)
- Modify: `packages/db/src/index.ts` (add `export * from "./team-chat-media.js";`)
- Test: `apps/api/test/staff-chat-carries-voice-photos-and-files.test.mjs` (new; Task 1 section)

**Interfaces:**
- Produces (`team-chat.ts`): `TeamMessage` gains `fileId: string | null`, `replyToId: string | null` (both null once removed). `postTeamMessage(input)` input gains `fileId?: string | null`, `replyToId?: string | null`, `body` may be `""` when `fileId` is set. `removeTeamMessage(id, employeeId)` also nulls the file's `bytes` and `preview` and sets its `deleted_at` (same call, same transaction).
- Produces (`team-chat-media.ts`):
  - `type TeamFileKind = "voice" | "photo" | "file"`
  - `interface TeamFileMeta { id: string; threadId: string; kind: TeamFileKind; mime: string; name: string; size: number; width: number | null; height: number | null; durationMs: number | null; waveform: number[] | null; deletedAt: string | null }`
  - `saveTeamFile(input: { thread: TeamThread; uploader: string; kind: TeamFileKind; mime: string; name: string; bytes: Uint8Array; preview: Uint8Array | null; width: number | null; height: number | null; durationMs: number | null; waveform: number[] | null }): Promise<TeamFileMeta>`
  - `teamFileMeta(ids: string[]): Promise<Map<string, TeamFileMeta>>`
  - `teamFileBytes(id: string, which: "bytes" | "preview"): Promise<{ meta: TeamFileMeta; bytes: Uint8Array } | null>` — null when missing or removed
  - `findMessageByClientId(threadId: string, clientId: string): Promise<TeamMessage | null>`
  - `teamMessagesByIds(ids: string[]): Promise<Map<string, TeamMessage>>`
  - `interface TeamReaction { emoji: string; by: Array<{ key: string; name: string }> }`
  - `setTeamReaction(input: { thread: TeamThread; messageId: string; reactor: string; reactorName: string; emoji: string }): Promise<void>` (insert or replace)
  - `removeTeamReaction(messageId: string, reactor: string): Promise<void>`
  - `reactionsFor(messageIds: string[]): Promise<Map<string, TeamReaction[]>>`
  - `groupReactions(rows: Array<{ message_id: string; emoji: string; reactor: string; reactor_name: string; created_at: Date | string }>): Map<string, TeamReaction[]>` — pure; emojis ordered by first reaction time, people in reaction order
  - `replySnippet(message: { body: string; deletedAt: string | null }, file: TeamFileMeta | null): { snippet: string; removed: boolean }` — pure
  - `seenByAllAt(thread: TeamThread): Promise<string | null>` — earliest `last_read_at` among the room's active employees; null for a direct thread or when any member has never read it

- [ ] **Step 1: Write the failing tests** (Task 1 section of the new test file; the file header names the spec)

```js
import { groupReactions, replySnippet } from "../../../packages/db/src/team-chat-media.ts";

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
```

- [ ] **Step 2: Run to see it fail**

Run: `cd apps/api && node --import tsx --experimental-test-module-mocks --test test/staff-chat-carries-voice-photos-and-files.test.mjs`
Expected: FAIL — cannot find `team-chat-media.ts` / no migration file.

- [ ] **Step 3: Write `104-team-chat-media.sql`** following `101-team-chat.sql`'s policy block exactly (`using`/`with check` on `app.current_org` or `app.tenant_scope = 'all'`). Tables and columns as spec §4. The body check is replaced: 101 declared it inline on the column, so its name is Postgres's default `team_messages_body_check`; write `alter table team_messages drop constraint if exists team_messages_body_check;` then `alter table team_messages drop constraint if exists team_messages_body_length;` then `alter table team_messages add constraint team_messages_body_length check (char_length(body) between 1 and 4000 or (file_id is not null and char_length(body) <= 4000));` (the second drop keeps a re-run idempotent). Index `team_files (thread_id)` and `team_reactions (message_id)`.

- [ ] **Step 4: Implement `team-chat-media.ts`** with the signatures above, and the `team-chat.ts` changes. `replySnippet`: removed → "Message removed"; voice → `🎤 Voice note m:ss` (floor seconds); photo → `📷 ` + caption or `📷 Photo`; file → `📄 ` + name; else the body cut to 120 characters. `saveTeamFile` never returns `bytes`.

- [ ] **Step 5: Run the test file again** — Expected: PASS. Then `cd apps/api && npx tsc --noEmit -p .` — Expected: no errors.

- [ ] **Step 6: Commit** — `git add packages/db apps/api/test/staff-chat-carries-voice-photos-and-files.test.mjs && git commit -m "Staff chat: files, replies and reactions in the database (migration 104)"`

---

### Task 2: What a file really is, and how it is served

**Files:**
- Create: `apps/api/src/lib/team-files.ts`
- Test: same test file, Task 2 section

**Interfaces:**
- Produces:
  - `TEAM_LIMITS = { photoBytes: 5 * 1024 * 1024, previewBytes: 200 * 1024, fileBytes: 16 * 1024 * 1024, voiceBytes: 6 * 1024 * 1024, requestBytes: 17 * 1024 * 1024, voiceMinMs: 1000, voiceMaxMs: 305_000, waveformMax: 128, bodyMax: 4000 }`
  - `sniff(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "audio/mp4" | "audio/webm" | "audio/ogg" | null`
  - `checkUpload(input: { kind: string; bytes: Uint8Array; preview: Uint8Array | null; durationMs: unknown; waveform: unknown; width: unknown; height: unknown }): { ok: true; kind: TeamFileKind; mime: string; durationMs: number | null; waveform: number[] | null; width: number | null; height: number | null } | { ok: false; error: string }` — photos must sniff as an image type (and the preview, when present, as JPEG within `previewBytes`); voice must sniff as an audio type with a valid duration and waveform; files may be anything within `fileBytes` and are stored with the sniffed type or `application/octet-stream`.
  - `cleanName(raw: unknown): string` — last path part after `/` or `\`, control characters removed, trimmed, 200 characters max, `file` when empty
  - `servedHeaders(meta: { kind: TeamFileKind; mime: string; name: string }): Record<string, string>`
  - `isEmoji(value: unknown): value is string` — 1–16 characters, at least one `\p{Extended_Pictographic}` or regional indicator, no letters/digits other than keycap sequences, no `<>`

- [ ] **Step 1: Write the failing tests**

```js
import { sniff, checkUpload, cleanName, servedHeaders, isEmoji, TEAM_LIMITS } from "../src/lib/team-files.ts";
const bytes = (...b) => new Uint8Array([...b, ...new Array(32).fill(0)]);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0), PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const M4A = bytes(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20); // ....ftypM4A
const WEBM = bytes(0x1a, 0x45, 0xdf, 0xa3), HTML = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
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
  assert.equal(cleanName("C:\\Users\\x\\cv.pdf"), "cv.pdf");
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
```

- [ ] **Step 2: Run** — Expected: FAIL, module not found.
- [ ] **Step 3: Implement `team-files.ts`.** Magic bytes: JPEG `FF D8 FF`; PNG `89 50 4E 47 0D 0A 1A 0A`; GIF `GIF87a`/`GIF89a`; WebP `RIFF....WEBP`; MP4/M4A `ftyp` at offset 4; WebM/Matroska `1A 45 DF A3`; Ogg `OggS`. Inline types: the four image types for `photo`, the three audio types for `voice`; everything else `application/octet-stream` + `attachment`. Disposition: `attachment; filename="<ASCII printable only, quotes and backslashes replaced by _>"; filename*=UTF-8''<encodeURIComponent(name)>`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Staff chat: a file is what its bytes say, and downloads are sandboxed"`

---

### Task 3: Sending a voice note, photo or file

**Files:**
- Modify: `apps/api/src/routes/team-chat.ts` (the `POST /threads/:id/messages` handler; `withCards` becomes `shapeMessages`)
- Test: same test file, Task 3 section (behaviour, through `teamChatRoute.request`)

**Interfaces:**
- Consumes: Task 1 (`saveTeamFile`, `findMessageByClientId`, `teamMessagesByIds`, `teamFileMeta`, `reactionsFor`, `replySnippet`), Task 2 (`checkUpload`, `cleanName`, `TEAM_LIMITS`).
- Produces: `async function shapeMessages(messages: TeamMessage[]): Promise<ShapedMessage[]>` where `ShapedMessage = TeamMessage & { share: …as today…; file: { id, kind, name, size, mime, durationMs, waveform, width, height } | null; replyTo: { id: string; authorName: string; snippet: string; removed: boolean } | null; reactions: TeamReaction[] }`. Every response and event that carried `withCards(...)` output now carries `shapeMessages(...)` output.
- Request (multipart): fields `clientId`, `body`, `replyTo`, `mentions` (JSON array string), `kind` (`voice|photo|file`), `file` (File), and `preview`, `width`, `height` (photo), `durationMs`, `waveform` (JSON array string, voice). JSON sends keep working unchanged, now also accepting `replyTo`.

- [ ] **Step 1: Write the failing behaviour tests.** At the top of the file, `mock.module("@nexus/db", { exports: { …every name the route imports, plus Task 1's… } })` backed by in-memory arrays (`threads`, `messages`, `files`, `reactions`, `reads`), `withTenant: (_org, fn) => fn()`; `mock.module("@nexus/employees", { exports: { resolvePresence: () => "online" } })`; mock `../src/lib/team-events.ts` (resolved with `new URL(..., import.meta.url).href`) so `publishTeamEvent` pushes to a `published` array. Mount: `const app = new Hono(); app.use("*", async (c, next) => { c.set("scope", scopeNow); await next(); }); app.route("/", teamChatRoute);` with `scopeNow` switched per test between a Zipicka staff scope (`{ role: "employee", employeeId: RALPH, organizationId: ZIP }`), an SFS staff scope and the admin (`{ role: "operator", sub: "admin-1" }`). Helper `upload(fields)` builds a `FormData` and sets `Content-Length` from `new Response(form).arrayBuffer()`.

```js
test("a voice note sent twice with the same id is stored once", async () => {
  const first = await send(ROOM, { clientId: "c1", kind: "voice", file: m4a(), durationMs: "4200", waveform: JSON.stringify(wave) });
  const again = await send(ROOM, { clientId: "c1", kind: "voice", file: m4a(), durationMs: "4200", waveform: JSON.stringify(wave) });
  assert.deepEqual([first.status, again.status], [201, 200]);
  assert.equal(files.length, 1);
  assert.equal((await again.json()).message.file.kind, "voice");
  assert.equal(published.filter((e) => e.type === "team_message").length, 1);
});

test("a photo with no caption is a message; a caption over 4000 characters is not", async () => {
  assert.equal((await send(ROOM, { clientId: "p1", kind: "photo", file: jpeg(), width: "1600", height: "900" })).status, 201);
  assert.equal((await send(ROOM, { clientId: "p2", kind: "photo", file: jpeg(), body: "x".repeat(4001) })).status, 400);
});

test("an upload without a length is refused before it is read, and one over 17 MB too", async () => {
  assert.equal((await rawSend(ROOM, { headers: {} })).status, 411);
  assert.equal((await rawSend(ROOM, { headers: { "Content-Length": String(17 * 1024 * 1024 + 1) } })).status, 413);
});

test("another business, or the admin in a direct chat, cannot send a file", async () => {
  scopeNow = SFS_STAFF;
  assert.equal((await send(ROOM, { clientId: "x1", kind: "file", file: pdf() })).status, 404);
  scopeNow = ADMIN;
  assert.equal((await send(DIRECT, { clientId: "x2", kind: "file", file: pdf() })).status, 404);
});

test("a reply must quote a message of the same thread, and comes back with its snippet", async () => {
  const other = seedMessage(DIRECT, "elsewhere");
  assert.equal((await sendJson(ROOM, { clientId: "r1", body: "yes", replyTo: other.id })).status, 400);
  const here = seedMessage(ROOM, "Customer from Dubai wants a callback");
  const res = await sendJson(ROOM, { clientId: "r2", body: "On it", replyTo: here.id });
  assert.deepEqual((await res.json()).message.replyTo, { id: here.id, authorName: "Shah", snippet: "Customer from Dubai wants a callback", removed: false });
});

test("a file name with a path keeps only its last part", async () => {
  const res = await send(ROOM, { clientId: "n1", kind: "file", file: pdf("../../etc/passwd") });
  assert.equal((await res.json()).message.file.name, "passwd");
});
```

- [ ] **Step 2: Run** — Expected: FAIL (multipart not accepted; no `file` on messages).
- [ ] **Step 3: Implement.** Order inside the handler: access checks as today → if `Content-Type` starts with `multipart/form-data`: require `Content-Length` (411) ≤ `TEAM_LIMITS.requestBytes` (413) before `c.req.parseBody()`; read fields → validate text (`bodyMax`, empty allowed only with a file) → `replyTo` must be a uuid of a message in this thread (`teamMessagesByIds`, 400 "That message is not in this chat.") → `checkUpload` → inside ONE `withTenant(thread.organizationId, …)`: `findMessageByClientId` first (when found: return it 200 with no new file), else `saveTeamFile` then `postTeamMessage({ …, fileId, replyToId })`, then `markTeamRead`. Publish after, as today. Uploader key is `readerKey(who.viewer)`.
- [ ] **Step 4: Run** — Expected: PASS; the existing `staff-talk-to-their-own-team` tests still pass (`created ? 201 : 200`, `!access.post`, publish after `postTeamMessage(`).
- [ ] **Step 5: Commit** — `git commit -m "Staff chat: send voice notes, photos and files, once, to the right thread"`

---

### Task 4: Fetching files, reactions, "seen by everyone", and removal

**Files:**
- Modify: `apps/api/src/routes/team-chat.ts` (new `GET /files/:id`, `GET /files/:id/preview`, `PUT` and `DELETE /messages/:id/reaction`; `GET /threads/:id/messages` adds `seenByAllAt`; `POST /threads/:id/read` adds `seenByAllAt` to its room event; `DELETE /messages/:id` unchanged in shape)
- Modify: `apps/api/src/lib/team-events.ts` (`type` adds `"team_reaction"`; fields `messageId?: string`, `reactions?: TeamReaction[]`, `seenByAllAt?: string | null`)
- Test: same test file, Task 4 section

**Interfaces:**
- Consumes: Task 1 (`teamFileBytes`, `setTeamReaction`, `removeTeamReaction`, `reactionsFor`, `seenByAllAt`), Task 2 (`servedHeaders`, `isEmoji`).
- Produces: `GET /threads` → `me` gains `key: string` (`readerKey(who.viewer)`: the employee id, or `admin:<adminId>`), so each screen knows which reactions are its own. `GET /files/:id` → bytes with `servedHeaders`; 404 for removed, unknown, or unreadable. `PUT /messages/:id/reaction` body `{ emoji }` → `{ reactions: TeamReaction[] }`; `DELETE` → same. Event `{ type: "team_reaction", threadId, messageId, reactions }`.

- [ ] **Step 1: Write the failing tests**

```js
test("only people who can read the chat can fetch its file, and the admin can listen to a direct chat", async () => {
  const f = seedFile(DIRECT, "voice");
  scopeNow = AZIZ_STAFF;            // same business, not in this direct chat
  assert.equal((await app.request(`/files/${f.id}`)).status, 404);
  scopeNow = ADMIN;
  const res = await app.request(`/files/${f.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("a removed message's file is gone", async () => {
  const m = seedMessage(ROOM, "", { file: seedFile(ROOM, "photo"), author: RALPH });
  scopeNow = RALPH_STAFF;
  await app.request(`/messages/${m.id}`, { method: "DELETE" });
  assert.equal((await app.request(`/files/${m.fileId}`)).status, 404);
});

test("one reaction per person: another emoji replaces it, removing takes it off, and everyone hears", async () => {
  const m = seedMessage(ROOM, "hello");
  scopeNow = RALPH_STAFF;
  await react(m.id, "👍");
  const after = await (await react(m.id, "❤️")).json();
  assert.deepEqual(after.reactions.map((r) => r.emoji), ["❤️"]);
  await app.request(`/messages/${m.id}/reaction`, { method: "DELETE" });
  assert.equal(reactions.length, 0);
  assert.equal(published.filter((e) => e.type === "team_reaction").length, 3);
});

test("a reaction that is not an emoji is refused and nothing is published", async () => {
  const m = seedMessage(ROOM, "hello");
  for (const emoji of ["<script>", "nice one", ""]) assert.equal((await react(m.id, emoji)).status, 400);
  assert.equal(published.length, 0);
});

test("the admin cannot react in a direct chat", async () => {
  scopeNow = ADMIN;
  assert.equal((await react(seedMessage(DIRECT, "hi").id, "👍")).status, 404);
});

test("each screen is told its own reaction key", async () => {
  scopeNow = ADMIN;
  assert.equal((await (await app.request("/threads?business=zipicka")).json()).me.key, "admin:admin-1");
  scopeNow = RALPH_STAFF;
  assert.equal((await (await app.request("/threads")).json()).me.key, RALPH);
});

test("a room reports when everyone has seen it", async () => {
  const page = await (await app.request(`/threads/${ROOM}/messages`)).json();
  assert.ok("seenByAllAt" in page);
});
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the routes with the same `viewerOf → readableThread → sameBusiness` opening as the other id routes; reaction writes require `teamAccess(...).post`; the reaction reactor key is `readerKey(who.viewer)` and name `who.name`.
- [ ] **Step 4: Run** the whole API suite: `cd apps/api && npm test > ../../.superpowers/api-test.log 2>&1; tail -5 ../../.superpowers/api-test.log` — Expected: everything passes except the known Windows-only "mirror.sh is itself executable".
- [ ] **Step 5: Commit** — `git commit -m "Staff chat: fetch files safely, react, and see who has read the room"`

---

### Task 5: The web client — API calls, live events and the thread hook

**Files:**
- Modify: `apps/web/lib/api.ts` (types and calls), `apps/web/lib/use-team-socket.ts` (event type), `apps/web/lib/use-team-thread.ts`
- Create: `apps/web/lib/team-chat/reactions.ts`
- Test: `apps/web/test/staff-chat-like-whatsapp.test.mjs` (new; Task 5 section)

**Interfaces:**
- Produces (`api.ts`): `interface TeamChatFile { id: string; kind: "voice" | "photo" | "file"; name: string; size: number; mime: string; durationMs: number | null; waveform: number[] | null; width: number | null; height: number | null }`; `interface TeamReaction { emoji: string; by: Array<{ key: string; name: string }> }`; `TeamChatMessage` gains `fileId`, `replyToId`, `file: TeamChatFile | null`, `replyTo: { id; authorName; snippet; removed } | null`, `reactions: TeamReaction[]`; `getTeamMessages` result gains `seenByAllAt: string | null`; `sendTeamMessage` input gains `replyTo?: string`;
  `uploadTeamMessage(threadId: string, form: FormData, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<{ message: TeamChatMessage }>` (XMLHttpRequest, `withCredentials = true`, `x-nexus-view-as` when previewing, rejects with the same `API <status> on <path>: <body>` text `request` throws, and with an `AbortError` on abort);
  `setTeamReaction(messageId: string, emoji: string)`, `clearTeamReaction(messageId: string)` → `Promise<{ reactions: TeamReaction[] }>`; `teamFileUrl(id: string, preview?: boolean): string`.
- Produces (`reactions.ts`): `toggleReaction(reactions: TeamReaction[], emoji: string, me: { key: string; name: string }): TeamReaction[]` (same emoji removes mine; another replaces mine; empty groups dropped) and `mineOf(reactions: TeamReaction[], key: string): string | null`.
- Produces (`use-team-thread.ts`): `PendingMessage` gains `replyTo?: string` and `file?: PendingFile` where `PendingFile = { kind: "voice" | "photo" | "file"; blob: Blob; name: string; preview?: Blob; width?: number; height?: number; durationMs?: number; waveform?: number[]; progress: number }`. The hook adds `sendFile(file: Omit<PendingFile, "progress">, caption?: string, replyTo?: string): boolean`, `cancel(clientId: string): void`, `react(message: TeamChatMessage, emoji: string): void`, `replyingTo: TeamChatMessage | null`, `setReplyingTo`, `seenByAllAt`, and `send(body, mentions, replyTo?)`. `myKey` comes from `TeamThreadsResponse.me.key` (Task 4), passed in as a fourth argument `myReaderKey: string | null`; `TeamThreadsResponse.me` gains `key: string`.

- [ ] **Step 1: Write the failing tests**

```js
import { toggleReaction, mineOf } from "@/lib/team-chat/reactions";
const me = { key: "a", name: "Ali" };

test("tapping the same emoji takes my reaction off; another one replaces it", () => {
  const start = [{ emoji: "👍", by: [{ key: "a", name: "Ali" }, { key: "b", name: "Bea" }] }];
  assert.deepEqual(toggleReaction(start, "👍", me), [{ emoji: "👍", by: [{ key: "b", name: "Bea" }] }]);
  assert.deepEqual(toggleReaction(start, "❤️", me), [
    { emoji: "👍", by: [{ key: "b", name: "Bea" }] },
    { emoji: "❤️", by: [{ key: "a", name: "Ali" }] },
  ]);
  assert.equal(mineOf(start, "a"), "👍");
  assert.deepEqual(toggleReaction([{ emoji: "👍", by: [me] }], "👍", me), []);
});

test("an upload carries its thread, keeps its id and file for a retry, and sends the preview header", () => {
  const HOOK = read("lib/use-team-thread.ts");
  assert.match(HOOK, /function retry\(pending: PendingMessage\)[\s\S]{0,400}pending\.clientId/);
  assert.match(HOOK, /uploadTeamMessage\(item\.threadId/);
  const API = read("lib/api.ts");
  const up = API.slice(API.indexOf("export function uploadTeamMessage"));
  assert.match(up.slice(0, 1500), /withCredentials = true/);
  assert.match(up.slice(0, 1500), /x-nexus-view-as/);
});

test("live reactions and room read positions reach the open thread", () => {
  assert.match(read("lib/use-team-socket.ts"), /"team_reaction"/);
  assert.match(read("lib/use-team-thread.ts"), /event\.type === "team_reaction"/);
});
```

(`read` here is `readFileSync(new URL("../" + p, import.meta.url), "utf8")`.)

- [ ] **Step 2: Run** `npm --prefix apps/web test` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** In the hook, a pending file's `deliver` builds the `FormData`, keeps an `AbortController` per clientId in a ref, updates `progress`, and on success removes the pending item and appends the message only if `activeRef.current === item.threadId` (the existing rule — Review Focus 2). `cancel` aborts and drops the pending item. `react` applies `toggleReaction` at once, calls the API, and on failure restores the previous reactions and sets the error "That reaction could not be saved.".
- [ ] **Step 4: Run** web tests and `cd apps/web && npx tsc --noEmit -p .` — Expected: PASS, no type errors (callers of `useTeamThread` updated for the new argument).
- [ ] **Step 5: Commit** — `git commit -m "Staff chat: the screen can send files, react and follow reads live"`

---

### Task 6: The recorder's rules, the waveform and the gestures (pure)

**Files:**
- Create: `apps/web/lib/team-chat/recorder.ts`, `apps/web/lib/team-chat/waveform.ts`, `apps/web/lib/team-chat/gestures.ts`
- Test: web test file, Task 6 section

**Interfaces:**
- Produces (`recorder.ts`):
  - `RECORDER = { cancelPx: 96, lockPx: 72, clickMs: 300, minMs: 1000, maxMs: 300_000 }`
  - `type Phase = "idle" | "holding" | "locked" | "paused" | "review" | "sending" | "cancelled" | "too-short" | "denied"`
  - `interface RecorderState { phase: Phase; startedAt: number; pointer: "touch" | "mouse" | null; x0: number; y0: number; dx: number; dy: number; recordedMs: number; segmentStart: number | null; reviewReason: "limit" | "interrupted" | "stopped" | null }`
  - `type RecorderEvent = { type: "press"; at: number; x: number; y: number; pointer: "touch" | "mouse" } | { type: "move"; x: number; y: number } | { type: "release"; at: number } | { type: "browser-cancel"; at: number } | { type: "tick"; at: number } | { type: "hidden"; at: number } | { type: "pause"; at: number } | { type: "resume"; at: number } | { type: "stop"; at: number } | { type: "send"; at: number } | { type: "delete" } | { type: "denied" } | { type: "reset" }`
  - `INITIAL: RecorderState`, `step(state: RecorderState, event: RecorderEvent): RecorderState`, `elapsedMs(state: RecorderState, now: number): number`, `micOn(phase: Phase): boolean` (true only for `holding` and `locked`; `paused` keeps the stream but stops the clock — `micOn("paused") === true`)
- Transition table (the tests pin each row):

| from | event | to |
|---|---|---|
| idle | press | holding |
| holding | move with dx ≤ −96 | cancelled |
| holding | move with dy ≤ −72 | locked |
| holding | release, mouse, before 300 ms | locked |
| holding | release, under 1000 ms | too-short |
| holding | release, otherwise | sending |
| holding, locked, paused | browser-cancel or hidden | review (reason interrupted) |
| holding, locked | tick at ≥ 300 000 ms recorded | review (reason limit) |
| locked | pause → paused; paused | resume → locked |
| locked, paused | stop | review (reason stopped) |
| locked, paused, review | send | sending, or too-short when under 1000 ms |
| locked, paused, review | delete | cancelled |
| any | denied | denied |
| any | reset | idle |

- Produces (`waveform.ts`): `foldPeaks(levels: number[], bars = 64): number[]` — max of each bucket, scaled so the loudest bar is 100, values rounded to integers 0–100, empty input → `bars` zeros; `formatClock(ms: number): string` → `m:ss`.
- Produces (`gestures.ts`): `GESTURES = { holdMs: 450, swipePx: 64 }`, `swipeReply(dx: number, dy: number): boolean` (dx ≥ 64 and |dy| < 32), `isLongPress(ms: number, movedPx: number): boolean` (ms ≥ 450 and moved < 10).

- [ ] **Step 1: Write the failing tests**, one per table row, plus:

```js
test("a scroll that steals the press keeps the recording for review, never sends it, never leaves the mic on", () => {
  let s = step(INITIAL, { type: "press", at: 0, x: 0, y: 0, pointer: "touch" });
  s = step(s, { type: "browser-cancel", at: 4000 });
  assert.equal(s.phase, "review");
  assert.equal(s.reviewReason, "interrupted");
  assert.equal(micOn(s.phase), false);
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
  assert.equal(formatClock(12_400), "0:12");
  assert.equal(formatClock(300_000), "5:00");
});

test("a swipe right replies, a hold opens reactions", () => {
  assert.equal(swipeReply(70, 5), true);
  assert.equal(swipeReply(70, 40), false);
  assert.equal(isLongPress(460, 3), true);
  assert.equal(isLongPress(460, 20), false);
});
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `step` as the table says; time recorded = sum of segments (paused time excluded).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Staff chat: the voice recorder's rules, waveform and gestures, tested"`

---

### Task 7: Photo sizes, name colours and message runs (pure)

**Files:**
- Create: `apps/web/lib/team-chat/shrink-image.ts`, `apps/web/lib/team-chat/name-colour.ts`, `apps/web/lib/team-chat/runs.ts`
- Test: web test file, Task 7 section

**Interfaces:**
- Produces: `fitWithin(width: number, height: number, longest: number): { width: number; height: number }` (never enlarges; rounds); `SHRINK = { longest: 1600, quality: 0.82, previewLongest: 320 }`; `shrinkImage(file: File): Promise<{ blob: Blob; preview: Blob; width: number; height: number } | null>` (canvas; null when the browser cannot decode it; a GIF returns itself as `blob` with a JPEG preview); `nameColourIndex(employeeId: string): number` (0–7, FNV-1a of the id); `interface Run { authorKey: string; start: number; end: number }`; `groupRuns(messages: Array<{ authorEmployeeId: string | null; authorIsAdmin: boolean; createdAt: string; deletedAt: string | null }>, gapMs = 5 * 60_000): boolean[]` → for each message, whether it starts a run (name and tail shown).

- [ ] **Step 1: Write the failing tests**

```js
test("a photo is shrunk to 1600 on its longest side, never enlarged", () => {
  assert.deepEqual(fitWithin(4032, 3024, 1600), { width: 1600, height: 1200 });
  assert.deepEqual(fitWithin(900, 1600, 320), { width: 180, height: 320 });
  assert.deepEqual(fitWithin(800, 600, 1600), { width: 800, height: 600 });
});

test("each colleague keeps one colour, and every colour reads on both bubbles", () => {
  assert.equal(nameColourIndex("aaaaaaaa-0000-0000-0000-000000000001"), nameColourIndex("aaaaaaaa-0000-0000-0000-000000000001"));
  const css = readFileSync(new URL("../app/team-chat/team-chat.css", import.meta.url), "utf8");
  const light = [...css.matchAll(/--tc-name-(\d): (#[0-9A-Fa-f]{6})/g)].slice(0, 8).map((m) => m[2]);
  const dark = [...css.matchAll(/--tc-name-(\d): (#[0-9A-Fa-f]{6})/g)].slice(8, 16).map((m) => m[2]);
  assert.equal(light.length, 8); assert.equal(dark.length, 8);
  for (const c of light) assert.ok(contrast(c, "#FFFEFB") >= 4.5, c);
  for (const c of dark) assert.ok(contrast(c, "#1D1A15") >= 4.5, c);
});

test("a run of messages from one person shows the name once", () => {
  const m = (who, min) => ({ authorEmployeeId: who, authorIsAdmin: false, createdAt: `2026-11-02T10:${String(min).padStart(2, "0")}:00Z`, deletedAt: null });
  assert.deepEqual(groupRuns([m("a", 0), m("a", 1), m("b", 2), m("b", 9)]), [true, false, true, true]);
});
```

(`contrast` is the same helper as `the-dock-icons-are-glass-tiles.test.mjs`. This test reads `team-chat.css`, so it stays red until Task 9 writes the tokens; Steps 4–5 here commit the pure modules with that one test marked `{ todo: "Task 9" }`, and Task 9 removes the `todo`.)

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the three modules.
- [ ] **Step 4: Run** — Expected: PASS except the todo.
- [ ] **Step 5: Commit** — `git commit -m "Staff chat: photo sizes, name colours and message runs"`

---

### Task 8: Emoji data and emoji search

**Files:**
- Create: `scripts/build-emoji-data.mjs`, `apps/web/public/emoji/en.json`, `apps/web/lib/team-chat/emoji-search.ts`
- Test: web test file, Task 8 section

**Interfaces:**
- Produces (`en.json`): `{ "version": "15.0", "groups": [{ "id": "smileys", "label": "Smileys & people", "icon": "😀", "emojis": [{ "e": "😀", "n": "grinning face", "k": ["face", "grin"], "t": 0 }] }] }` — `t: 1` when the emoji takes skin tones. Groups in Unicode order with Unicode's "Smileys & Emotion" and "People & Body" merged as `smileys`; no "Component" group. Only `fully-qualified` entries with version ≤ 15.0, tone variants omitted (built at runtime from `t`).
- Produces (`emoji-search.ts`): `type EmojiData = …the JSON shape…`; `searchEmoji(data: EmojiData, query: string, limit = 48): string[]` (name or keyword starts-with match on any word, case-insensitive, name matches first); `withTone(emoji: string, tone: 0 | 1 | 2 | 3 | 4 | 5): string` (inserts U+1F3FB…U+1F3FF after the first code point; 0 returns it unchanged); `RECENT_KEY = "nexus-emoji-recent"`; `pushRecent(list: string[], emoji: string, max = 24): string[]`.
- The script downloads `https://unicode.org/Public/emoji/15.0/emoji-test.txt` and `https://raw.githubusercontent.com/unicode-org/cldr-json/45.0.0/cldr-json/cldr-annotations-full/annotations/en/annotations.json` into a temp folder, writes `en.json`, and prints the emoji count.

- [ ] **Step 1: Write the failing tests**

```js
const EMOJI = JSON.parse(readFileSync(new URL("../public/emoji/en.json", import.meta.url), "utf8"));
test("the emoji list is Emoji 15.0, with search names", () => {
  assert.equal(EMOJI.version, "15.0");
  const all = EMOJI.groups.flatMap((g) => g.emojis);
  assert.ok(all.length > 1300, `${all.length} emojis`);
  assert.ok(!EMOJI.groups.some((g) => /component/i.test(g.label)));
});
test("searching finds the obvious ones", () => {
  assert.ok(searchEmoji(EMOJI, "heart").includes("❤️"));
  assert.ok(searchEmoji(EMOJI, "thumbs").includes("👍"));
  assert.deepEqual(searchEmoji(EMOJI, "zzzznothing"), []);
});
test("skin tones and recents", () => {
  assert.equal(withTone("👍", 3), "👍🏽");
  assert.deepEqual(pushRecent(["😀", "👍"], "👍"), ["👍", "😀"]);
});
test("the emoji list loads only when the panel opens", () => {
  assert.match(read("app/team-chat/emoji-panel.tsx"), /fetch\("\/emoji\/en\.json"\)/);
}, { todo: "Task 10" });
```

- [ ] **Step 2: Run** — Expected: FAIL (no data file).
- [ ] **Step 3: Run the script** `node scripts/build-emoji-data.mjs` — Expected: prints a count over 1300 and writes `apps/web/public/emoji/en.json`. Implement `emoji-search.ts`.
- [ ] **Step 4: Run** — Expected: PASS (todo excepted).
- [ ] **Step 5: Commit** — `git commit -m "Staff chat: the emoji list and emoji search"`

---

### Task 9: The WhatsApp look — thread, bubbles, header, wallpaper

**Files:**
- Create: `apps/web/app/team-chat/team-chat.css` (replaces `app/deck/team-chat/team-chat.css`, which is deleted; every importer switches)
- Modify: `apps/web/app/team-chat-thread.tsx` (`ThreadMessages`), `apps/web/app/deck/team-chat/page.tsx` (header), `apps/web/app/inbox/team-dock.tsx` (import)
- Create: `apps/web/app/team-chat/file-bubble.tsx` (photo preview, file card; voice delegates to Task 11's `VoiceNote`, a stub that renders the duration until then)
- Test: web test file, Task 9 section; remove Task 7's `todo`

**Interfaces:**
- Consumes: Task 5 (message shape, `seenByAllAt`, `react`), Task 7 (`groupRuns`, `nameColourIndex`).
- Produces: `ThreadMessages` props gain `myKey: string | null` and `unreadAtOpen: number` (the thread summary's `unread` when it was opened); replies, reactions and `seenByAllAt` come through the `thread` prop it already takes. CSS tokens `--tc-name-0`…`--tc-name-7` (light, then Warm Night under the dark selector part 1 uses), `--tc-wallpaper` (inline SVG data URI), classes `.tc-msg.first` (run start, shows tail and name), `.tc-ticks[data-state="sending|sent|seen"]`, `.tc-unread-strip`, `.tc-quote`.

- [ ] **Step 1: Write the failing tests**

```js
test("the thread draws WhatsApp's way: tails on run starts, names in colour, ticks, a day pill and an unread strip", () => {
  const T = read("app/team-chat-thread.tsx");
  assert.match(T, /groupRuns\(/);
  assert.match(T, /--tc-name-\$\{nameColourIndex\(/);
  assert.match(T, /data-state=\{/);
  assert.match(T, /unread message/);
  const CSS = read("app/team-chat/team-chat.css");
  assert.match(CSS, /--tc-wallpaper: url\("data:image\/svg\+xml/);
  assert.match(CSS, /\.tc-msg\.first[^{]*::before/);   // the tail
  assert.doesNotMatch(CSS, /rgba\(0,\s*0,\s*0/);
});
test("the bubbles move only when motion is welcome", () => {
  const CSS = read("app/team-chat/team-chat.css");
  const motion = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: no-preference)"));
  assert.match(motion, /tc-rise/);
  assert.doesNotMatch(CSS.slice(0, CSS.indexOf("@media (prefers-reduced-motion: no-preference)")), /animation:/);
});
test("a quote jumps to the message it quotes", () => {
  assert.match(read("app/team-chat-thread.tsx"), /scrollIntoView\(\{ block: "center"/);
});
```

Keep the existing guards green: "Not sent · Retry" stays in `team-chat-thread.tsx`; the page keeps "Your admin can read team chats." and "Read only — between".

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** spec §1. Ticks: pending → `sending`; mine and (direct: `seenByOther ≥ createdAt`; room: `seenByAllAt ≥ createdAt`) → `seen`; else `sent`. The quote click scrolls to `#tc-m-<id>`, adds `.flash` for 1.2 s; when the id is not loaded, calls `thread.loadEarlier()` up to 5 times, then shows "That message is older than this chat shows." in the thread's error line.
- [ ] **Step 4: Run** web tests + `npx tsc --noEmit -p apps/web` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Staff chat: the WhatsApp look in Cream"`

---

### Task 10: One message box for the page and the dock — text, mentions, emoji, reply strip

**Files:**
- Create: `apps/web/app/team-chat/composer.tsx` (`TeamComposer`), `apps/web/app/team-chat/emoji-panel.tsx`
- Modify: `apps/web/app/deck/team-chat/page.tsx`, `apps/web/app/inbox/team-dock.tsx` (both drop their own form and render `<TeamComposer>`; the page's mention logic moves into it)
- Test: web test file, Task 10 section; remove Task 8's `todo`

**Interfaces:**
- Consumes: Task 5 hook (`send`, `sendFile`, `replyingTo`, `setReplyingTo`, `notifyTyping`, `canPost`), Task 8 (`searchEmoji`, `withTone`, `pushRecent`, `RECENT_KEY`).
- Produces: `TeamComposer({ thread, colleagues, placeholder, compact }: { thread: TeamThreadState; colleagues: TeamColleague[]; placeholder: string; compact?: boolean })`. Renders nothing when `!thread.canPost`. Slots for Task 11 (`<VoiceRecorder>`) and Task 12 (`<AttachButton>`), stubbed here as disabled buttons with the same accessible names ("Record a voice note", "Attach").

- [ ] **Step 1: Write the failing tests**

```js
test("the page and the inbox dock use the one message box", () => {
  assert.match(read("app/deck/team-chat/page.tsx"), /<TeamComposer/);
  assert.match(read("app/inbox/team-dock.tsx"), /<TeamComposer/);
  assert.doesNotMatch(read("app/inbox/team-dock.tsx"), /<textarea/);
});
test("the round button is a mic when empty and send once there is text", () => {
  const C = read("app/team-chat/composer.tsx");
  assert.match(C, /draft\.trim\(\) \? \(/);
  assert.match(C, /aria-label="Send"/);
  assert.match(C, /<VoiceRecorder/);
});
test("a reply shows its quote above the box and can be cleared", () => {
  const C = read("app/team-chat/composer.tsx");
  assert.match(C, /thread\.replyingTo/);
  assert.match(C, /aria-label="Cancel reply"/);
});
test("sending plays the pop", () => {
  assert.match(read("app/team-chat/composer.tsx"), /play\("pop"\)/);
});
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** The emoji panel inserts at the caret, keeps the textarea focused on desktop, records recents with `try/catch` around `localStorage`; ＋ on the reaction bar (Task 13) reuses `EmojiPanel` with an `onPick` prop.
- [ ] **Step 4: Run** web tests + typecheck — Expected: PASS; the existing `staff-talk-to-their-own-team` API tests still pass (`useTeamThread(` in the page, `Read only — between`).
- [ ] **Step 5: Commit** — `git commit -m "Staff chat: one message box with emojis, mentions and replies"`

---

### Task 11: Press-and-hold voice notes, and playing them

**Files:**
- Create: `apps/web/app/team-chat/voice-recorder.tsx`, `apps/web/app/team-chat/voice-note.tsx`
- Modify: `apps/web/app/team-chat/composer.tsx` (real recorder), `apps/web/app/team-chat/file-bubble.tsx` (real player)
- Test: web test file, Task 11 section

**Interfaces:**
- Consumes: Task 6 (`step`, `RECORDER`, `micOn`, `foldPeaks`, `formatClock`), Task 5 (`thread.sendFile`).
- Produces: `VoiceRecorder({ onSend, disabled }: { onSend: (note: { blob: Blob; mime: string; durationMs: number; waveform: number[] }) => void; disabled: boolean })`; `VoiceNote({ file, mine }: { file: TeamChatFile; mine: boolean })`; a module-level `nowPlaying` so starting one note pauses any other and `ended` starts the next voice note in the same thread (found by DOM order, `[data-voice-note]`).

- [ ] **Step 1: Write the failing tests**

```js
test("recording picks a type every phone can play, and the mic is let go on every way out", () => {
  const R = read("app/team-chat/voice-recorder.tsx");
  assert.match(R, /\["audio\/mp4", "audio\/webm;codecs=opus", "audio\/ogg;codecs=opus"\]/);
  assert.match(R, /getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/);
  assert.match(R, /!micOn\(state\.phase\)/);
  assert.match(R, /onPointerCancel/);
  assert.match(R, /visibilitychange/);
  assert.match(R, /Hold to record, release to send/);
  assert.match(R, /‹ Slide to cancel/);
  assert.match(R, /play\("tick"\)/);
  assert.match(R, /play\("whoosh"\)/);
});
test("a voice note is fetched once with credentials and falls back to a download", () => {
  const V = read("app/team-chat/voice-note.tsx");
  assert.match(V, /credentials: "include"/);
  assert.match(V, /URL\.createObjectURL/);
  assert.match(V, /canPlayType\(/);
  assert.match(V, /playbackRate/);
  // The not-yet-played dot is per device, and never breaks without storage.
  assert.match(V, /"nexus-voice-played"/);
  assert.match(V, /try \{[\s\S]{0,200}localStorage/);
});
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** The component holds `RecorderState` in a reducer over `step`; a single effect releases the stream whenever `!micOn(state.phase)` and on unmount (this also covers a thread switch, because the composer re-mounts the recorder with `key={thread id}`); `setPointerCapture` on press; `tick` every 200 ms drives the timer and the 5-minute stop; an `AnalyserNode` samples `getByteTimeDomainData` peaks into an array folded by `foldPeaks` at send; the denied state shows "Nexus can't use your microphone. Allow it in your browser's site settings, then try again.".
- [ ] **Step 4: Run** web tests + typecheck — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Staff chat: press and hold to send a voice note"`

---

### Task 12: Photos and files — pick, preview, send with progress, view

**Files:**
- Create: `apps/web/app/team-chat/attach.tsx` (`AttachButton`, the preview sheet, drag-and-drop and paste on the thread), `apps/web/app/team-chat/photo-viewer.tsx`
- Modify: `apps/web/app/team-chat/composer.tsx`, `apps/web/app/team-chat/file-bubble.tsx`, `apps/web/app/team-chat-thread.tsx` (progress ring and cancel on pending files)
- Test: web test file, Task 12 section

**Interfaces:**
- Consumes: Task 7 (`shrinkImage`, `SHRINK`), Task 5 (`sendFile`, `cancel`, `teamFileUrl`).
- Produces: `AttachButton({ onFiles }: { onFiles: (files: File[]) => void })`; `PhotoViewer({ file, onClose })`.

- [ ] **Step 1: Write the failing tests**

```js
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
  assert.match(read("app/team-chat/attach.tsx"), /16 MB/);
});
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** spec §3 "Photos and files". Photo previews and full photos load through `fetch(teamFileUrl(id, preview), { credentials: "include" })` into object URLs, revoked on unmount.
- [ ] **Step 4: Run** web tests + typecheck — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Staff chat: send photos and files with a preview and progress"`

---

### Task 13: Reactions bar, message menu and swipe to reply

**Files:**
- Create: `apps/web/app/team-chat/reactions.tsx` (chips under the bubble and the "who reacted" list), `apps/web/app/team-chat/message-menu.tsx` (hold/hover bar: 👍 ❤️ 😂 😮 😢 🙏 ＋, Reply, Copy, Remove)
- Modify: `apps/web/app/team-chat-thread.tsx`
- Test: web test file, Task 13 section

**Interfaces:**
- Consumes: Task 6 (`isLongPress`, `swipeReply`, `GESTURES`), Task 5 (`react`, `mineOf`, `setReplyingTo`, `remove`), Task 10 (`EmojiPanel` with `onPick`).
- Produces: `QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"]`.

- [ ] **Step 1: Write the failing tests**

```js
test("press and hold, or hover, opens the reactions; the admin gets none in a direct chat", () => {
  const M = read("app/team-chat/message-menu.tsx");
  assert.match(M, /QUICK_REACTIONS = \["👍", "❤️", "😂", "😮", "😢", "🙏"\]/);
  const T = read("app/team-chat-thread.tsx");
  assert.match(T, /isLongPress\(/);
  assert.match(T, /swipeReply\(/);
  assert.match(T, /thread\.canPost \?/);
});
test("Remove is offered only on your own message", () => {
  assert.match(read("app/team-chat/message-menu.tsx"), /mine && !message\.deletedAt/);
});
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** The open menu dims the thread (`.tc-dim`), lifts the bubble, closes on Escape / outside tap; keyboard: the bubble is focusable and `Enter` opens the menu.
- [ ] **Step 4: Run** the full web suite and typecheck — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Staff chat: react, reply and act on a message the WhatsApp way"`

---

### Task 14: The SQL against a real Postgres

**Files:** none in the repo (a throwaway container).

- [ ] **Step 1:** Start Docker Desktop (`"C:\Program Files\Docker\Docker\Docker Desktop.exe"`) and wait until `docker info` answers. If it cannot start within 3 minutes, write the ledger ruling "SQL not run locally — the VPS schema probe (Deploy step 2) is the first real run" and go to Task 15.
- [ ] **Step 2:** `docker run -d --rm --name nexus-sqlcheck -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:16-alpine`; apply `packages/db/schema.sql` then every file in `packages/db/migrations` in name order with `psql -v ON_ERROR_STOP=1`, then apply `104-team-chat-media.sql` a second time. Expected: no errors (idempotent).
- [ ] **Step 3:** With a small script in the scratchpad that imports `packages/db/src` with `DATABASE_URL` pointing at the container, run once each: `saveTeamFile` + `postTeamMessage` with a fileId; the same clientId again; `teamFileBytes`; `setTeamReaction` twice (replace) and `removeTeamReaction`; `reactionsFor`; `removeTeamMessage` then `teamFileBytes` → null; `seenByAllAt`. Expected: each result matches the Task 1 interfaces.
- [ ] **Step 4:** `docker stop nexus-sqlcheck`. Ledger the result.

---

### Task 15: See it work in the browser

**Files:** outside the repo: `C:\CLAUDE CODE\bacora\.claude\nexus-mock\mock-api.mjs` (team chat endpoints: threads, messages with a file / reply / reactions, multipart send, files, reaction PUT/DELETE).

- [ ] **Step 1:** Add the endpoints to the mock API; start `nexus-mock-api` and `nexus-web-c` from launch.json.
- [ ] **Step 2:** In the preview, open `/deck/team-chat` as a staff session. Check with `read_page` and screenshots: wallpaper, tails, coloured names, ticks, day pill, unread strip; emoji panel search "heart"; reaction by hold (pointer events) and by hover; swipe-to-reply strip; photo preview sheet with a generated PNG; upload progress; file bubble.
- [ ] **Step 3:** Fake microphone: in the page, replace `navigator.mediaDevices.getUserMedia` with a function returning an `OscillatorNode` stream from `AudioContext.createMediaStreamDestination()`; press-and-hold the mic for 3 s and release → a voice note with a waveform appears and plays; slide-left cancel; lock and send; a 0.5 s tap shows "Hold to record, release to send".
- [ ] **Step 4:** Dark mode and a 375 px phone width; reduced motion. Screenshots for the owner.
- [ ] **Step 5:** Stop the preview servers.

## Deploy (after the owner says "Deploy it")

1. Merge to `main`, `git push origin main`.
2. VPS console: `cd /opt/nexus && git pull && ./scripts/schema-drift-check.sh` (expected: 104 shows as missing, nothing else) → `docker compose -f docker-compose.prod.yml exec -T postgres psql -U nexus -d nexus -v ON_ERROR_STOP=1 < packages/db/migrations/104-team-chat-media.sql` → `./scripts/schema-drift-check.sh` (expected: no drift) → `(setsid nohup ./scripts/deploy.sh > /tmp/deploy-<sha>.log 2>&1 &)`.
3. Wait for "PASS - all three running images were built from <sha>".
