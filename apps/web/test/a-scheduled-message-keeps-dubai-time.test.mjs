/**
 * A scheduled message keeps the business's time, and a failed one says so
 * (audit, 4 Nov 2026).
 *
 * The time typed was read in the device's zone (new Date(when).toISOString())
 * and shown in it too, so someone managing from abroad who picked 9:00 sent at
 * 9:00 their time -- and the list said 9:00, so it could not be seen. Bookings
 * and follow-ups already use the business's zone. And a send that failed (a
 * disconnected mailbox, a switched-off line, a Meta error) was marked failed and
 * then simply vanished from the list, exactly as if it had gone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PANEL = readFileSync(new URL("../app/inbox/scheduled-messages.tsx", import.meta.url), "utf8");
const ROUTE = readFileSync(new URL("../../api/src/routes/conversations.ts", import.meta.url), "utf8");

test("the time typed is the business's wall clock, and is shown in it", () => {
  assert.doesNotMatch(PANEL, /new Date\(when\)\.toISOString\(\)/);
  assert.match(PANEL, /wallClockToInstant\(date, time, timeZone\)/);
  assert.match(PANEL, /describeInstant\(m\.sendAt, timeZone\)/);
});

test("a failed send stays on the list with its reason", () => {
  assert.match(PANEL, /failed\.map\(/);
  assert.match(PANEL, /Not sent/);
  const list = ROUTE.slice(ROUTE.indexOf('conversationsRoute.get("/:id/scheduled"'), ROUTE.indexOf('conversationsRoute.post("/:id/scheduled"'));
  assert.match(list, /listRecentlyFailedScheduledMessages\(/);
  assert.match(list, /timeZone/);
});
