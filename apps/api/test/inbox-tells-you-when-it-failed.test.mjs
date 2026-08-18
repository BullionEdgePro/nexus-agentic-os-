// The inbox swallowed both of its failures.
//
// Found by continuing the deck sweep onto the other surface a person actually
// uses. Two of them, and each is worse than the deck equivalents because this is
// where a human takes over from the agent.
//
// A FAILED LOAD LOOKED LIKE A QUIET DAY. `loadConversations` had try/finally and
// no catch, so a failed request rejected into an effect nobody listened to and
// the list stayed empty — rendering "No conversations yet for this business" on
// the one page somebody opens to find out whether a customer is waiting. That is
// the operator sweep going silent, in the surface a person reads.
//
// A FAILED SEND SAID NOTHING. The spinner stopped, the draft stayed in the box,
// and there was no way to tell that from a send that worked. Meta refusing a
// message outside the 24-hour session window is the common case, and it happens
// exactly when somebody is replying to a customer who has been waiting — where
// believing it went is worst.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const STORE = read("apps", "web", "lib", "store.ts");
const PAGE = read("apps", "web", "app", "inbox", "page.tsx");
const visible = (t) =>
  t.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, " ");

test("both loads record why they failed instead of rejecting into nothing", () => {
  for (const fn of ["loadConversations", "loadMessages"]) {
    const body = STORE.slice(STORE.indexOf(`${fn}: async`), STORE.indexOf(`${fn}: async`) + 1200);
    assert.match(body, /catch \(err\) \{/, `${fn} still has no catch`);
    assert.match(body, /set\(\{ loadError:/, `${fn} does not record the failure`);
  }
  assert.match(STORE, /loadError: string;/);
});

test("the list is left alone rather than emptied", () => {
  // Clearing it would produce "No conversations yet" by a different route,
  // which is the sentence this whole fix exists to stop appearing.
  const body = STORE.slice(STORE.indexOf("loadConversations: async"));
  const upToCatchEnd = body.slice(0, body.indexOf("finally"));
  assert.ok(
    !/set\(\{[^}]*conversations: \[\]/.test(upToCatchEnd),
    "the catch must not empty the conversation list"
  );
});

test("a failed load is not rendered as an empty inbox", () => {
  const shown = visible(PAGE);
  assert.match(shown, /\) : loadError \? \(/);
  assert.match(shown, /Could not load conversations\./);

  // And it says so in terms of what it means, not just that something broke.
  assert.match(shown, /This is not the same as having none/);

  // The empty state still exists for the case that genuinely is empty.
  assert.match(shown, /No conversations yet for this business\./);
});

test("a failed send is told to the person who typed it", () => {
  assert.match(STORE, /set\(\{ sendError:/);
  assert.match(visible(PAGE), /Not sent\./);
  assert.match(visible(PAGE), /still in the box/);

  // The draft is never cleared on failure — it is the only copy of what they
  // wrote. `setDraft("")` must stay after the await, inside the try.
  const handler = PAGE.slice(PAGE.indexOf("async function handleSend"), PAGE.indexOf("return ("));
  // Non-greedy across the nested call: the argument is `draft.trim()`, so a
  // `[^)]*` stops at the inner bracket and never reaches the semicolon.
  assert.match(handler, /await sendMessage\([\s\S]*?\);\s*\n\s*setDraft\(""\);/);
});

test("the failed send does not become an unhandled rejection", () => {
  // The store rethrows so callers can react; the page catches so the browser
  // does not log an uncaught error for something already shown on screen.
  assert.match(STORE, /set\(\{ sendError:[\s\S]{0,120}?\}\);\s*\n\s*throw err;/);
  const handler = PAGE.slice(PAGE.indexOf("async function handleSend"), PAGE.indexOf("return ("));
  assert.match(handler, /\} catch \{/);
});
