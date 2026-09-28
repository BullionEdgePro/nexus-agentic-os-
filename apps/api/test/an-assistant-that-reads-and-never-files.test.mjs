// AI chat summary and plain-language follow-ups (DoubleTick's "AI chat summary"
// and "AI Reminders").
//
// The two rules that make them safe to have: neither WRITES anything on the
// model's say-so — a summary is returned, never stored; a reminder is read back
// and filed only through the ordinary create route once a person confirms — and
// a time said in words is the BUSINESS's wall clock, not the server's UTC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { zonedLocalToUtc, localStamp } from "../src/lib/zoned-time.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const TASKS = read("apps", "api", "src", "routes", "tasks.ts");
const CONVS = read("apps", "api", "src", "routes", "conversations.ts");
const PANE = read("apps", "web", "app", "inbox", "conversation-tasks.tsx");
const PANEL = read("apps", "web", "app", "inbox", "details-panel.tsx");

const handler = (src, start, end) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start) + 1));

test("3pm in Dubai is 11:00 UTC, not 15:00", () => {
  assert.equal(zonedLocalToUtc("2026-10-01T15:00", "Asia/Dubai")?.toISOString(), "2026-10-01T11:00:00.000Z");
  assert.equal(zonedLocalToUtc("2026-10-01T09:00", "UTC")?.toISOString(), "2026-10-01T09:00:00.000Z");
});

test("a time around a DST change lands on the right side of it", () => {
  // 09:00 in London the day after the clocks go back (BST -> GMT) is 09:00 UTC;
  // the day before, it is 08:00 UTC.
  assert.equal(zonedLocalToUtc("2026-10-26T09:00", "Europe/London")?.toISOString(), "2026-10-26T09:00:00.000Z");
  assert.equal(zonedLocalToUtc("2026-10-24T09:00", "Europe/London")?.toISOString(), "2026-10-24T08:00:00.000Z");
});

test("anything that is not a real local date-time is refused, not guessed", () => {
  assert.equal(zonedLocalToUtc("2026-02-31T10:00", "Asia/Dubai"), null);
  assert.equal(zonedLocalToUtc("tomorrow at 3", "Asia/Dubai"), null);
  assert.equal(zonedLocalToUtc("2026-10-01 15:00", "Asia/Dubai"), null);
  assert.equal(localStamp(new Date("2026-10-01T11:00:00Z"), "Asia/Dubai"), "2026-10-01T15:00");
});

test("understanding a reminder never creates one", () => {
  const understand = handler(TASKS, 'conversationTasksRoute.post("/:id/tasks/understand"', 'conversationTasksRoute.post("/:id/tasks", ');
  assert.ok(understand.length > 400, "the understand handler is gone");
  assert.ok(!/createTask\(/.test(understand), "the understand route files a task on the model's say-so");
  assert.match(understand, /zonedLocalToUtc\(parsed\.due, timeZone\)/);
  // A past or malformed time is dropped and SAID, not filed.
  assert.match(understand, /dateDropped/);
  assert.match(understand, /routedOrganizationId \?\? conversation\.organizationId/);
});

test("the pane files a reminder only through the ordinary route, after a confirm", () => {
  assert.match(PANE, /understandFollowUp\(conversationId, spoken\.trim\(\)\)/);
  const confirm = PANE.slice(PANE.indexOf("async function confirmUnderstood"));
  assert.match(confirm.slice(0, 600), /createConversationTask\(conversationId, \{ title: understood\.title, dueAt: understood\.dueAt \}\)/);
  const understand = PANE.slice(PANE.indexOf("async function understand("), PANE.indexOf("async function confirmUnderstood"));
  assert.ok(!/createConversationTask/.test(understand), "reading a reminder saves it");
});

test("a summary is returned, never stored, and told not to invent", () => {
  const summary = handler(CONVS, 'conversationsRoute.post("/:id/summary"', "conversationsRoute.get(");
  assert.ok(summary.length > 400, "the summary route is gone");
  assert.ok(!/insert|update|createNote|addConversationNote|updateContactDetails/i.test(summary.replace(/\/\*[\s\S]*?\*\//g, "")));
  assert.match(summary, /Never add facts, prices, dates or promises/);
  assert.match(PANEL, /summarizeConversation\(conversationId\)/);
});
