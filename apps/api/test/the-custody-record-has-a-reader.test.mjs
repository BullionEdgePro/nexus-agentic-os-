// A record nothing reads is not a record, it is a table.
//
// Migration 062 started writing every change of hands. Until this endpoint the
// only way to ask "who has had this conversation" was psql — so the feature
// that existed to answer a question in the inbox could only be consulted by
// somebody with a database shell, which is not the person holding the question.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const ROUTE = read("apps", "api", "src", "routes", "conversations.ts");
const COMPONENT = read("apps", "web", "app", "inbox", "conversation-custody.tsx");
const PAGE = read("apps", "web", "app", "inbox", "page.tsx");
const DB = read("packages", "db", "src", "conversations.ts");

test("the history is its own endpoint, not folded into messages", () => {
  // The inbox reloads messages on every conversation switch. This answers a
  // question asked rarely and deliberately, so charging every switch for it
  // would make every customer pay for the rare case.
  assert.match(ROUTE, /conversationsRoute\.get\("\/:id\/custody"/);
  const messages = ROUTE.slice(
    ROUTE.indexOf('conversationsRoute.get("/:id/messages"'),
    ROUTE.indexOf('conversationsRoute.get("/:id/custody"')
  );
  assert.ok(!/listCustody/.test(messages), "the messages endpoint now pays for custody too");
});

test("a missing conversation 404s before the history is read", () => {
  const handler = ROUTE.slice(ROUTE.indexOf('conversationsRoute.get("/:id/custody"'));
  const body = handler.slice(0, handler.indexOf("\n});"));
  assert.ok(
    body.indexOf("Conversation not found") < body.indexOf("listCustody"),
    "an unknown id should 404 rather than return an empty history that reads as a real answer"
  );
});

test("nothing recorded is reported as nothing recorded", () => {
  // THE POINT OF THE WHOLE TABLE, restated in the reader.
  //
  // Migration 062 backfills nothing on purpose. An empty list therefore means
  // either "never changed hands" or "changed hands before anything was
  // recording", and those are opposite news. Drawing an empty timeline would
  // let an absent record answer a question it was never asked — which is the
  // exact defect the table exists to end.
  assert.match(ROUTE, /predatesRecording: events\.length === 0/);
  assert.match(COMPONENT, /state\.predatesRecording \?/);
  assert.match(COMPONENT, /may never have changed hands, or it may have/);
  assert.ok(
    !/No history|Never handed over|The agent has always/i.test(COMPONENT),
    "the empty state is asserting something it cannot know"
  );
});

test("every reason the schema allows has words a person can act on", () => {
  // Printing `stale_release` at somebody makes them translate. The automatic
  // one especially: a reader who does not know the release exists will assume a
  // colleague unticked the box.
  const migration = read(
    "packages",
    "db",
    "migrations",
    "062-a-conversation-changing-hands-is-an-event.sql"
  );
  const allowed = new Set(
    [...migration.matchAll(/'(agent_escalated|human_replied|taken_by_employee|manual_toggle|stale_release)'/g)].map(
      (m) => m[1]
    )
  );
  assert.equal(allowed.size, 5);
  const describe = COMPONENT.slice(COMPONENT.indexOf("function describe("));
  for (const reason of allowed) {
    assert.ok(describe.includes(`case "${reason}"`), `${reason} would print raw`);
  }
  assert.match(describe, /automatically/, "the automatic release must say that it was automatic");
});

test("it is loaded on demand, and reset per conversation", () => {
  // Without the key, opening the history on one customer and switching to
  // another shows the first customer's history under the second one's name.
  assert.match(PAGE, /<ConversationCustody\s+key=\{activeConversation\.id\}/);
  assert.match(COMPONENT, /kind: "closed"/);
  assert.ok(
    !/useEffect/.test(COMPONENT),
    "an effect would fetch on mount, which is every conversation switch"
  );
});

test("the reader states what an empty history does not mean", () => {
  // listCustody carries the warning at the source too, so a second caller
  // cannot read an empty array as 'never held' without having been told.
  const reader = DB.slice(DB.indexOf("export async function listCustody"));
  const doc = DB.slice(0, DB.indexOf("export async function listCustody")).slice(-900);
  assert.match(doc + reader.slice(0, 120), /NOT RECORDED/);
});

test("the history is ordered by insertion, not by timestamp", () => {
  // FOUND BY MEASUREMENT, not by reading. Postgres freezes now() at the start
  // of a transaction, so several custody rows written inside one carry the
  // IDENTICAL created_at and `order by created_at desc` between them is a coin
  // flip. A probe against production toggled, no-op'd and released a
  // conversation in one transaction; the release was written last and came back
  // second.
  //
  // A history in the wrong order is worse than no history: it is a confident
  // wrong answer. This codebase already learned it once -- customer-waiting
  // carries a paragraph headed "THE TIEBREAK IS NOT COSMETIC" about the same
  // defect -- and the lesson did not travel to the next table that needed it.
  const reader = DB.slice(DB.indexOf("export async function listCustody"));
  const query = reader.slice(0, reader.indexOf("[conversationId"));
  assert.match(query, /order by seq desc/);
  assert.ok(
    !/order by created_at/.test(query),
    "a timestamp cannot order rows that share a transaction"
  );

  // And a tiebreak on id would be deterministic and still wrong: uuids are
  // random, so it would give a stable arbitrary order rather than the real one.
  assert.ok(!/order by[^`]*\bid\b/.test(query), "uuid order is arbitrary, not chronological");

  const migration = read(
    "packages",
    "db",
    "migrations",
    "063-an-audit-log-needs-an-order-not-a-timestamp.sql"
  );
  assert.match(migration, /add column if not exists seq bigserial/);
  assert.match(migration, /idx_conversation_custody_seq/);
});
