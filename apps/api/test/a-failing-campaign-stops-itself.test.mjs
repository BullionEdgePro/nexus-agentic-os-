// A failing campaign stops itself, and the limit is the sending number's.
//
// Two gaps found on 22 Oct 2026 while making staff campaigns ready:
//
//   1. Nothing stopped a campaign whose messages were being refused. It ran to
//      the last recipient, and every refusal is a mark against the number's
//      standing with WhatsApp — a staff member's OWN number, which is also how
//      their customers reach them.
//   2. The "how many can this number still reach today" warning read the
//      COMPANY account's number, whatever number the campaign actually went out
//      from — so for a staff member's own number it described a different line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { shouldTrip } from "@nexus/db";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");
const MIGRATION = read("packages", "db", "migrations", "099-a-campaign-can-pause.sql");
const PROCESSOR = read("apps", "api", "src", "queue", "broadcast-processor.ts");
const ROUTE = read("apps", "api", "src", "routes", "my-campaigns.ts");
const BOOK = read("packages", "db", "src", "client-book.ts");

test("fewer than ten attempts never trips, however bad", () => {
  assert.equal(shouldTrip({ sent: 0, failed: 9 }), false);
  assert.equal(shouldTrip({ sent: 4, failed: 5 }), false);
});

test("exactly half failing does not trip", () => {
  assert.equal(shouldTrip({ sent: 5, failed: 5 }), false);
});

test("more than half failing, with ten or more tried, trips", () => {
  assert.equal(shouldTrip({ sent: 4, failed: 6 }), true);
  assert.equal(shouldTrip({ sent: 0, failed: 10 }), true);
});

test("the database accepts 'paused' and keeps every status it had", () => {
  assert.match(MIGRATION, /'paused'/);
  for (const status of ["draft", "scheduled", "sending", "completed", "failed"]) {
    assert.match(MIGRATION, new RegExp(`'${status}'`));
  }
});

test("a paused campaign sends nothing more", () => {
  const before = PROCESSOR.indexOf("broadcastStatus(");
  const send = PROCESSOR.indexOf("sendWhatsAppTemplate(", PROCESSOR.indexOf("export async function"));
  assert.ok(before > 0 && before < send, "the status is read before the send");
  assert.match(PROCESSOR, /=== "paused"/);
});

test("a tripped campaign is paused and says why, and finishing never un-pauses it", () => {
  // The pause itself lives in pauseBroadcastIfFailing (packages/db), shared
  // with the delivery-receipt path since the review; the worker logs the why.
  assert.match(PROCESSOR, /pauseBroadcastIfFailing\(/);
  assert.match(PROCESSOR, /explainSendError\(/);
  assert.match(PROCESSOR, /outcome\.done && \(await broadcastStatus\(broadcastId\)\) === "sending"/);
});

test("the daily limit is read from the number the campaign goes out from", () => {
  assert.match(ROUTE, /readNumberStanding\(fromPhoneNumberId\)/);
  assert.match(ROUTE, /dailyReachUsed\(fromPhoneNumberId\)/);
  assert.match(BOOK, /b\.from_phone_number_id = \$1/);
});

test("today's reach is counted by when the campaign went out — the column that exists", () => {
  // broadcast_recipients has no created_at. dailyReachUsed filtered on it since
  // it was written, so it threw every time and describeDailyCeiling's catch
  // turned that into "no warning": the limit warning could never appear.
  const fn = BOOK.slice(BOOK.indexOf("export async function dailyReachUsed"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.doesNotMatch(body, /r\.created_at/);
  assert.match(body, /b\.created_at >= now\(\) - interval '24 hours'/);
});

test("a number WhatsApp rates RED is refused before anything is queued", () => {
  const send = ROUTE.slice(ROUTE.indexOf('myCampaignsRoute.post("/campaigns", '));
  const body = send.slice(0, send.indexOf("\n});"));
  assert.ok(body.indexOf('=== "RED"') > 0, "RED is checked");
  assert.ok(body.indexOf('=== "RED"') < body.indexOf("createStaffBroadcast("), "before the campaign row exists");
});

const WEBHOOK = read("apps", "api", "src", "queue", "processor.ts");
const BROADCASTS = read("packages", "db", "src", "broadcasts.ts");

test("REVIEW FINDING: the breaker counts refusals Meta reports later, not only at send time", () => {
  // Meta accepts most messages at send time and refuses them afterwards by
  // webhook (131026, 131047, 131049). A breaker that only looked when the send
  // call itself failed never saw them.
  assert.match(PROCESSOR, /pauseBroadcastIfFailing\(broadcastId\)/);
  assert.doesNotMatch(PROCESSOR, /if \(failure && shouldTrip/);
  const at = WEBHOOK.indexOf("recordBroadcastDelivery({");
  assert.ok(at > 0);
  assert.match(WEBHOOK.slice(at, at + 1500), /pauseBroadcastIfFailingByMessage\(/);
});

test("REVIEW FINDING: pausing is conditional, and only while something is left to stop", () => {
  const fn = BROADCASTS.slice(BROADCASTS.indexOf("export async function pauseBroadcastIfFailing("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /outcome\.done/);
  assert.match(body, /where id = \$1 and status = 'sending'/);
});
