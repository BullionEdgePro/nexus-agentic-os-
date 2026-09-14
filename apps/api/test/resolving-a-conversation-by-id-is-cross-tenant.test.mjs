// The lookup that resolves a conversation's tenant must not need one first.
//
// requireConversationScope calls findConversationById to LEARN which business a
// conversation belongs to — it runs before any tenant scope exists, because its
// answer is what the scope will be. The query joins `contacts` (for the wa_id a
// reply is sent to), which is RLS-scoped, so without a cross-tenant wrapper it
// threw "tenant-scoped table touched with no tenant context" under
// DB_TENANT_ASSERT=strict, and the middleware turned that into a 500 on every
// conversation-scoped request a staff member made. The inbox reported "could
// not load conversations" the moment a thread was opened.
//
// This was latent until the businesses had real conversations and staff began
// opening them. It is the same class the whole strict-assert exists to catch, so
// it gets a guard here rather than only in a comment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const DB = read("packages", "db", "src", "conversations.ts");
const ROUTING = read("packages", "db", "src", "routing.ts");

function bodyOf(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`${marker} not found`);
  const after = src.indexOf("\nexport ", start + marker.length);
  return src.slice(start, after === -1 ? undefined : after);
}

test("findConversationById resolves its tenant cross-tenant", () => {
  const fn = bodyOf(DB, "export async function findConversationById");
  // It joins a tenant-scoped table (contacts, for wa_id), so it must widen scope
  // itself — the callers that use it have only an id and no scope yet.
  assert.match(fn, /join contacts/i, "the lookup still joins the RLS-scoped contacts table");
  assert.match(
    fn,
    /withAllTenants\(/,
    "findConversationById must wrap its query in withAllTenants — it is called before a tenant scope exists"
  );
});

test("getConversationRouting resolves the routed tenant cross-tenant", () => {
  // requireConversationScope reads BOTH findConversationById AND
  // getConversationRouting to decide the serving business — and it runs before
  // any tenant context. getConversationRouting selects from the RLS-scoped
  // `conversations` table, so without its own wrapper it threw under
  // DB_TENANT_ASSERT=strict, the middleware's catch turned that into a 403, and
  // every non-operator was denied every conversation (the inbox could not open a
  // thread or send a message). withAllTenants is a no-op inside an existing
  // context, so wrapping never widens the route and worker callers' scope.
  const fn = bodyOf(ROUTING, "export async function getConversationRouting");
  assert.match(fn, /from conversations/i, "it still reads the RLS-scoped conversations table");
  assert.match(
    fn,
    /withAllTenants\(/,
    "getConversationRouting must wrap its query in withAllTenants — the scope check calls it before a tenant scope exists"
  );
});
