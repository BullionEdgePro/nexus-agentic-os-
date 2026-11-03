// The team chat route with voice notes, photos, files, replies and reactions
// (2 Nov 2026), driven through real requests against an in-memory @nexus/db.
// Spec: docs/superpowers/specs/2026-11-02-staff-chat-whatsapp-design.md §5
//
// The rules that can be wrong here are the route's own: who may send or fetch,
// that a retried upload lands once, what is refused before it is read. The SQL
// behind each fake is tested against a real Postgres separately.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { teamAccess, readerKey, directPair } from "../../../packages/db/src/team-chat.ts";
import { groupReactions, replySnippet } from "../../../packages/db/src/team-chat-media.ts";

const ZIP = "11111111-1111-1111-1111-111111111111";
const SFS = "22222222-2222-2222-2222-222222222222";
const RALPH = "aaaaaaaa-0000-0000-0000-000000000001";
const SHAH = "aaaaaaaa-0000-0000-0000-000000000002";
const AZIZ = "aaaaaaaa-0000-0000-0000-000000000003";
const KESHAV = "bbbbbbbb-0000-0000-0000-000000000001";
const ROOM = "cccccccc-0000-0000-0000-000000000001";
const DIRECT = "cccccccc-0000-0000-0000-000000000002";

const ORGS = [
  { id: ZIP, slug: "zipicka", name: "Zipicka" },
  { id: SFS, slug: "sfs", name: "SFS International" },
];
const person = (id, organizationId, fullName) => ({ id, organizationId, fullName, isActive: true, jobTitle: null, avatarUrl: null });
const EMPLOYEES = [person(RALPH, ZIP, "Ralph"), person(SHAH, ZIP, "Shah"), person(AZIZ, ZIP, "Aziz"), person(KESHAV, SFS, "Keshav")];
const [a, b] = directPair(RALPH, SHAH);
const THREADS = [
  { id: ROOM, organizationId: ZIP, kind: "room", memberA: null, memberB: null },
  { id: DIRECT, organizationId: ZIP, kind: "direct", memberA: a, memberB: b },
];

let messages = [];
let files = [];
let reactions = [];
let published = [];
let seq = 0;
const uuid = () => `dddddddd-0000-0000-0000-${String(++seq).padStart(12, "0")}`;
const now = () => new Date(Date.UTC(2026, 10, 2, 10, 0, seq)).toISOString();
const metaOf = (f) => {
  const { bytes, preview, uploader, ...meta } = f;
  return meta;
};

mock.module("@nexus/db", {
  exports: {
    // Savepoints are a database matter; the stand-in runs the work as it is.
    isolated: (fn) => fn(),
    teamAccess,
    readerKey,
    directPair,
    replySnippet,
    withTenant: async (_org, fn) => fn(),
    findEmployeeById: async (id) => EMPLOYEES.find((e) => e.id === id) ?? null,
    findOrganizationById: async (id) => ORGS.find((o) => o.id === id) ?? null,
    findOrganizationBySlug: async (slug) => ORGS.find((o) => o.slug === slug) ?? null,
    listOrganizations: async () => ORGS,
    listEmployees: async (org) => EMPLOYEES.filter((e) => e.organizationId === org),
    findThread: async (id) => THREADS.find((t) => t.id === id) ?? null,
    ensureRoom: async (org) => THREADS.find((t) => t.organizationId === org && t.kind === "room"),
    getOrCreateDirect: async () => THREADS[1],
    listThreadSummaries: async () => [],
    teamUnread: async () => ({ unread: 0, mentioned: 0 }),
    listTeamMessages: async (threadId) => messages.filter((m) => m.threadId === threadId),
    postTeamMessage: async (input) => {
      const found = messages.find((m) => m.threadId === input.thread.id && m.clientId === input.clientId);
      if (found) return { message: found, created: false };
      const message = {
        id: uuid(),
        threadId: input.thread.id,
        authorEmployeeId: input.authorEmployeeId,
        authorName: input.authorName,
        authorIsAdmin: input.authorIsAdmin,
        body: input.body,
        clientId: input.clientId,
        mentions: input.mentions,
        sharedConversationId: input.sharedConversationId,
        fileId: input.fileId ?? null,
        replyToId: input.replyToId ?? null,
        createdAt: now(),
        deletedAt: null,
      };
      messages.push(message);
      return { message, created: true };
    },
    markTeamRead: async () => undefined,
    lastReadBy: async () => null,
    removeTeamMessage: async (id, employeeId) => {
      const m = messages.find((x) => x.id === id && x.authorEmployeeId === employeeId && !x.deletedAt);
      if (!m) return null;
      m.deletedAt = now();
      const f = files.find((x) => x.id === m.fileId);
      if (f) Object.assign(f, { bytes: null, preview: null, deletedAt: now() });
      return { ...m, body: "", fileId: null, replyToId: null };
    },
    sharedConversationCards: async () => new Map(),
    conversationViewers: async () => null,
    conversationVisibleTo: () => false,
    findConversationById: async () => null,
    getConversationRouting: async () => null,
    setConversationCollaborators: async () => undefined,
    saveTeamFile: async (input) => {
      const f = {
        id: uuid(),
        threadId: input.thread.id,
        kind: input.kind,
        mime: input.mime,
        name: input.name,
        size: input.bytes.byteLength,
        width: input.width,
        height: input.height,
        durationMs: input.durationMs,
        waveform: input.waveform,
        deletedAt: null,
        uploader: input.uploader,
        bytes: input.bytes,
        preview: input.preview,
      };
      files.push(f);
      return metaOf(f);
    },
    teamFileMeta: async (ids) => new Map(files.filter((f) => ids.includes(f.id)).map((f) => [f.id, metaOf(f)])),
    teamFileBytes: async (id, which) => {
      const f = files.find((x) => x.id === id && !x.deletedAt);
      const data = f?.[which === "preview" ? "preview" : "bytes"];
      return f && data ? { meta: metaOf(f), bytes: data } : null;
    },
    findMessageByClientId: async (threadId, clientId) =>
      messages.find((m) => m.threadId === threadId && m.clientId === clientId) ?? null,
    teamMessagesByIds: async (ids) => new Map(messages.filter((m) => ids.includes(m.id)).map((m) => [m.id, m])),
    setTeamReaction: async (input) => {
      reactions = reactions.filter((r) => !(r.message_id === input.messageId && r.reactor === input.reactor));
      reactions.push({ message_id: input.messageId, emoji: input.emoji, reactor: input.reactor, reactor_name: input.reactorName, created_at: now() });
    },
    removeTeamReaction: async (messageId, reactor) => {
      reactions = reactions.filter((r) => !(r.message_id === messageId && r.reactor === reactor));
    },
    reactionsFor: async (ids) => groupReactions(reactions.filter((r) => ids.includes(r.message_id))),
    seenByAllAt: async (thread) => (thread.kind === "room" ? "2026-11-02T09:00:00.000Z" : null),
  },
});
mock.module("@nexus/employees", { exports: { resolvePresence: () => ({ status: "available" }) } });
mock.module(new URL("../src/lib/team-events.ts", import.meta.url).href, {
  exports: {
    TEAM_EVENTS_CHANNEL: "test",
    publishTeamEvent: async (event) => void published.push(event),
    subscribeToTeamEvents: () => () => undefined,
  },
});
mock.module(new URL("../src/lib/logger.ts", import.meta.url).href, {
  exports: { logger: { warn: () => undefined, info: () => undefined, error: () => undefined, debug: () => undefined } },
});

const { Hono } = await import("hono");
const { teamChatRoute } = await import("../src/routes/team-chat.ts");
const { teamUploadGate } = await import("../src/lib/team-upload.ts");

const RALPH_STAFF = { role: "employee", employeeId: RALPH, organizationId: ZIP };
const AZIZ_STAFF = { role: "employee", employeeId: AZIZ, organizationId: ZIP };
const SFS_STAFF = { role: "employee", employeeId: KESHAV, organizationId: SFS };
const ADMIN = { role: "operator", sub: "admin-1", adminId: "admin-1" };
let scopeNow = RALPH_STAFF;

const app = new Hono();
app.use("*", async (c, next) => {
  c.set("scope", scopeNow);
  await next();
});
app.route("/", teamChatRoute);

beforeEach(() => {
  messages = [];
  files = [];
  reactions = [];
  published = [];
  scopeNow = RALPH_STAFF;
});

// ---- bytes and requests -------------------------------------------------------

const pad = (...b) => new Uint8Array([...b, ...new Array(64).fill(0)]);
const m4a = () => new File([pad(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20)], "voice.m4a", { type: "audio/mp4" });
const jpeg = () => new File([pad(0xff, 0xd8, 0xff, 0xe0)], "photo.jpg", { type: "image/jpeg" });
const pdf = (name = "price-list.pdf") => new File([new TextEncoder().encode("%PDF-1.7 a document")], name, { type: "application/pdf" });
const wave = new Array(64).fill(40);

async function send(threadId, fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const encoded = new Response(form);
  const body = await encoded.arrayBuffer();
  return app.request(`/threads/${threadId}/messages`, {
    method: "POST",
    body,
    headers: { "content-type": encoded.headers.get("content-type"), "content-length": String(body.byteLength) },
  });
}

const rawSend = (threadId, { headers }) =>
  app.request(`/threads/${threadId}/messages`, {
    method: "POST",
    body: new Uint8Array(10),
    headers: { "content-type": "multipart/form-data; boundary=x", ...headers },
  });

const sendJson = (threadId, input) =>
  app.request(`/threads/${threadId}/messages`, {
    method: "POST",
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
  });

function seedMessage(threadId, body, { file = null, author = SHAH } = {}) {
  const message = {
    id: uuid(),
    threadId,
    authorEmployeeId: author,
    authorName: EMPLOYEES.find((e) => e.id === author).fullName,
    authorIsAdmin: false,
    body,
    clientId: `seed-${seq}`,
    mentions: [],
    sharedConversationId: null,
    fileId: file?.id ?? null,
    replyToId: null,
    createdAt: now(),
    deletedAt: null,
  };
  messages.push(message);
  return message;
}

function seedFile(threadId, kind) {
  const f = {
    id: uuid(), threadId, kind, mime: kind === "voice" ? "audio/mp4" : "image/jpeg", name: kind === "voice" ? "voice.m4a" : "photo.jpg",
    size: 68, width: null, height: null, durationMs: kind === "voice" ? 4200 : null, waveform: kind === "voice" ? wave : null,
    deletedAt: null, uploader: SHAH, bytes: kind === "voice" ? pad(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70) : pad(0xff, 0xd8, 0xff), preview: null,
  };
  files.push(f);
  return f;
}

const react = (threadId, messageId, emoji) =>
  app.request(`/threads/${threadId}/messages/${messageId}/reaction`, {
    method: "PUT",
    body: JSON.stringify({ emoji }),
    headers: { "content-type": "application/json" },
  });

// ---- Task 3: sending a voice note, photo or file -------------------------------

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

test("an upload over 17 MB is refused whether its size is declared or only counted", async () => {
  assert.equal((await rawSend(ROOM, { headers: { "content-length": String(17 * 1024 * 1024 + 1) } })).status, 413);
  // No length sent (a proxy may forward it chunked): the bytes are counted as
  // they arrive. Up to 30 MB in 1 MB chunks, pulled only as the reader asks for them.
  let sent = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (sent >= 30) return controller.close();
      sent += 1;
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
  });
  const res = await app.request(`/threads/${ROOM}/messages`, {
    method: "POST",
    body: stream,
    duplex: "half",
    headers: { "content-type": "multipart/form-data; boundary=x" },
  });
  assert.ok(sent <= 20, `reading stopped near 17 MB instead of taking all 30 (read ${sent})`);
  assert.equal(res.status, 413);
  assert.equal(files.length, 0);
});

test("an upload that arrives without a length is still accepted when it is small", async () => {
  const form = new FormData();
  form.append("clientId", "nolen1");
  form.append("kind", "file");
  form.append("file", pdf());
  const encoded = new Response(form);
  const res = await app.request(`/threads/${ROOM}/messages`, {
    method: "POST",
    body: encoded.body,
    duplex: "half",
    headers: { "content-type": encoded.headers.get("content-type") },
  });
  assert.equal(res.status, 201);
  assert.equal(files.length, 1);
});

test("an upload is read in full before the database context opens, so a slow phone never holds a connection", async () => {
  const seen = [];
  const gated = new Hono();
  gated.use("*", async (c, next) => {
    c.set("scope", scopeNow);
    await next();
  });
  gated.use("/api/team-chat/*", teamUploadGate);
  // Stands in for the tenant context: by the time it runs, the body must already be read.
  gated.use("/api/*", async (c, next) => {
    seen.push(c.get("teamUpload")?.ok === true);
    await next();
  });
  gated.route("/api/team-chat", teamChatRoute);
  const form = new FormData();
  form.append("clientId", "gate1");
  form.append("kind", "file");
  form.append("file", pdf());
  const encoded = new Response(form);
  const body = await encoded.arrayBuffer();
  const res = await gated.request(`/api/team-chat/threads/${ROOM}/messages`, {
    method: "POST",
    body,
    headers: { "content-type": encoded.headers.get("content-type"), "content-length": String(body.byteLength) },
  });
  assert.equal(res.status, 201);
  assert.deepEqual(seen, [true]);
});

test("another business, or the admin in a direct chat, cannot send a file", async () => {
  scopeNow = SFS_STAFF;
  assert.equal((await send(ROOM, { clientId: "x1", kind: "file", file: pdf() })).status, 404);
  scopeNow = ADMIN;
  assert.equal((await send(DIRECT, { clientId: "x2", kind: "file", file: pdf() })).status, 404);
  assert.equal(files.length, 0);
});

test("a reply must quote a message of the same thread, and comes back with its snippet", async () => {
  const other = seedMessage(DIRECT, "elsewhere");
  assert.equal((await sendJson(ROOM, { clientId: "r1", body: "yes", replyTo: other.id })).status, 400);
  const here = seedMessage(ROOM, "Customer from Dubai wants a callback");
  const res = await sendJson(ROOM, { clientId: "r2", body: "On it", replyTo: here.id });
  assert.equal(res.status, 201);
  assert.deepEqual((await res.json()).message.replyTo, {
    id: here.id,
    authorName: "Shah",
    snippet: "Customer from Dubai wants a callback",
    removed: false,
  });
});

test("a file name with a path keeps only its last part", async () => {
  const res = await send(ROOM, { clientId: "n1", kind: "file", file: pdf("../../etc/passwd") });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).message.file.name, "passwd");
});

test("a picture sent as a voice note is refused and nothing is stored", async () => {
  const res = await send(ROOM, { clientId: "v9", kind: "voice", file: jpeg(), durationMs: "4200", waveform: JSON.stringify(wave) });
  assert.equal(res.status, 400);
  assert.equal(files.length, 0);
  assert.equal(messages.length, 0);
});


// ---- Task 4: fetching files, reactions, reads, removal ---------------------------

test("only people who can read the chat can fetch its file, and the admin can listen to a direct chat", async () => {
  const f = seedFile(DIRECT, "voice");
  scopeNow = AZIZ_STAFF; // same business, not in this direct chat
  assert.equal((await app.request(`/threads/${DIRECT}/files/${f.id}`)).status, 404);
  // Naming a thread they CAN read does not reach a file of another thread.
  assert.equal((await app.request(`/threads/${ROOM}/files/${f.id}`)).status, 404);
  scopeNow = SFS_STAFF;
  assert.equal((await app.request(`/threads/${DIRECT}/files/${f.id}`)).status, 404);
  scopeNow = ADMIN;
  const res = await app.request(`/threads/${DIRECT}/files/${f.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "audio/mp4");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("content-security-policy"), "sandbox");
  assert.equal((await res.arrayBuffer()).byteLength, f.bytes.byteLength);
});

test("a photo's preview is fetched on its own path, and a file with none is not found", async () => {
  const f = seedFile(ROOM, "photo");
  assert.equal((await app.request(`/threads/${ROOM}/files/${f.id}/preview`)).status, 404);
  f.preview = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const preview = await app.request(`/threads/${ROOM}/files/${f.id}/preview`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-type"), "image/jpeg");
  assert.equal((await app.request(`/threads/${ROOM}/files/not-a-uuid`)).status, 404);
});

test("a removed message's file is gone", async () => {
  const m = seedMessage(ROOM, "", { file: seedFile(ROOM, "photo"), author: RALPH });
  scopeNow = RALPH_STAFF;
  assert.equal((await app.request(`/messages/${m.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await app.request(`/threads/${ROOM}/files/${m.fileId}`)).status, 404);
});

test("one reaction per person: another emoji replaces it, removing takes it off, and everyone hears", async () => {
  const m = seedMessage(ROOM, "hello");
  scopeNow = RALPH_STAFF;
  assert.equal((await react(ROOM, m.id, "👍")).status, 200);
  const after = await (await react(ROOM, m.id, "❤️")).json();
  assert.deepEqual(after.reactions, [{ emoji: "❤️", by: [{ key: RALPH, name: "Ralph" }] }]);
  const cleared = await app.request(`/threads/${ROOM}/messages/${m.id}/reaction`, { method: "DELETE" });
  assert.deepEqual((await cleared.json()).reactions, []);
  assert.equal(reactions.length, 0);
  const events = published.filter((e) => e.type === "team_reaction");
  assert.equal(events.length, 3);
  assert.equal(events[0].messageId, m.id);
  assert.equal(events[0].threadId, ROOM);
});

test("a reaction that is not an emoji is refused and nothing is published", async () => {
  const m = seedMessage(ROOM, "hello");
  for (const emoji of ["<script>", "nice one", ""]) assert.equal((await react(ROOM, m.id, emoji)).status, 400);
  assert.equal(reactions.length, 0);
  assert.equal(published.length, 0);
});

test("the admin cannot react in a direct chat, and nobody can react to another business's message", async () => {
  scopeNow = ADMIN;
  assert.equal((await react(DIRECT, seedMessage(DIRECT, "hi").id, "👍")).status, 404);
  scopeNow = SFS_STAFF;
  assert.equal((await react(ROOM, seedMessage(ROOM, "hi").id, "👍")).status, 404);
  // A message of another thread cannot be reached through a thread you can read.
  scopeNow = AZIZ_STAFF;
  assert.equal((await react(ROOM, seedMessage(DIRECT, "private").id, "👍")).status, 404);
  assert.equal(reactions.length, 0);
});

test("each screen is told its own reaction key", async () => {
  scopeNow = ADMIN;
  assert.equal((await (await app.request("/threads?business=zipicka")).json()).me.key, "admin:admin-1");
  scopeNow = RALPH_STAFF;
  assert.equal((await (await app.request("/threads")).json()).me.key, RALPH);
});

test("a room reports when everyone has seen it, and a read in a room says so live", async () => {
  const page = await (await app.request(`/threads/${ROOM}/messages`)).json();
  assert.equal(page.seenByAllAt, "2026-11-02T09:00:00.000Z");
  await app.request(`/threads/${ROOM}/read`, { method: "POST" });
  const read = published.find((e) => e.type === "team_read");
  assert.equal(read.seenByAllAt, "2026-11-02T09:00:00.000Z");
});

test("a page of messages carries each file, quote and reaction", async () => {
  const photo = seedFile(ROOM, "photo");
  const original = seedMessage(ROOM, "", { file: photo });
  const reply = seedMessage(ROOM, "nice");
  reply.replyToId = original.id;
  reactions.push({ message_id: reply.id, emoji: "👍", reactor: SHAH, reactor_name: "Shah", created_at: now() });
  const page = await (await app.request(`/threads/${ROOM}/messages`)).json();
  const [first, second] = page.messages;
  assert.equal(first.file.kind, "photo");
  assert.equal(first.file.bytes, undefined);
  assert.deepEqual(second.replyTo, { id: original.id, authorName: "Shah", snippet: "📷 Photo", removed: false });
  assert.deepEqual(second.reactions, [{ emoji: "👍", by: [{ key: SHAH, name: "Shah" }] }]);
});
