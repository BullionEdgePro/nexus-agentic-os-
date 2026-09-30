// Staff calling a customer: one tap dials from their own phone, and the call
// log opens already timing it, so every call ends up on the record. Nexus does
// not carry the audio (no telephony provider; WhatsApp Calling needs the number
// at 2,000 contacts a day, it was 250 on 2026-09-30). Pinned as text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8").replace(/\r\n/g, "\n");
const INBOX = read("apps", "web", "app", "inbox", "page.tsx");
const PANEL = read("apps", "web", "app", "inbox", "details-panel.tsx");
const LOG = read("apps", "web", "app", "inbox", "call-log.tsx");

test("a WhatsApp chat's header dials the customer and opens the Calls tab", () => {
  const at = INBOX.indexOf('<header className="ibx-thread-head">');
  const end = INBOX.indexOf("</header>", at);
  assert.ok(at > -1 && end > at, "the thread header moved - re-anchor this test");
  const head = INBOX.slice(at, end);
  assert.match(head, /activeConversation\.channel === "whatsapp" && activeConversation\.contactWaId/);
  assert.match(head, /href=\{`tel:\+\$\{activeConversation\.contactWaId\}`\}/);
  assert.match(head, /setDialled\(\{ conversationId: activeConversation\.id, at: Date\.now\(\) \}\);\s+openPanel\("calls"\);/);
  // Channels with no number keep a plain "Log a call".
  assert.match(head, /title="Log a call"/);
});

test("the dialled call reaches only the chat it was made from", () => {
  assert.match(INBOX, /callStartedAt=\{dialled\?\.conversationId === activeConversation\.id \? dialled\.at : null\}/);
  assert.match(PANEL, /phone=\{details\.channel === "whatsapp" \? details\.contactWaId : null\}/);
  assert.match(PANEL, /startedAt=\{callStartedAt\}/);
});

test("the log opens as an outbound call and fills the length on return", () => {
  const beginAt = LOG.indexOf("function beginCall(");
  assert.ok(beginAt > -1, "beginCall is gone");
  const begin = LOG.slice(beginAt);
  assert.match(begin.slice(0, 400), /setOpen\(true\);\s+setDirection\("outbound"\);/);
  // Coming back to the tab after the call fills minutes from the timer, at least 1...
  assert.match(LOG, /window\.addEventListener\("focus", fill\);/);
  assert.match(LOG, /document\.visibilityState === "visible"/);
  assert.match(LOG, /Math\.max\(1, Math\.round\(\(t - callStart\) \/ 60000\)\)/);
  // ...but never over a length the person typed themselves.
  assert.match(LOG, /if \(!minutesTouched\.current\) setMinutes\(/);
  assert.match(LOG, /minutesTouched\.current = true;/);
  // And the timer is dropped when the chat changes.
  // The effect that runs per chat ends at "}, [load]);".
  const resetEnd = LOG.indexOf("}, [load]);");
  assert.ok(resetEnd > -1, "the per-chat reset moved");
  assert.match(LOG.slice(Math.max(0, resetEnd - 300), resetEnd), /setCallStart\(null\);/);
});
