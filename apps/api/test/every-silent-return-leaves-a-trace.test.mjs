// A message that gets no reply must leave something behind, every time.
//
// This defect has now been found twice in two hours, in two adjacent branches:
//
//   the conversation is in human handover   logger.debug, no metric row
//   the employee's twin stands down          logger.debug, no metric row
//
// Both are CORRECT decisions — a person has the conversation and an agent
// replying over the top of them is worse than silence. What made them defects
// is that neither left a trace: debug sits below the level the containers log
// at, the job completes cleanly so the queue shows nothing, and with no metric
// row the message is absent from every denominator.
//
// The cost is measured, not theoretical. On 2026-08-19 a live message took the
// first branch and, with full database access, "skipped on purpose" was
// indistinguishable from "the reply path is broken" for seven minutes. The
// owner could not have told them apart at all.
//
// Fixing it twice is not fixing it. This test asserts the PROPERTY: every early
// return in the inbound reply path either sends something, or says so at a
// level somebody reads and records what happened. An exception is allowed, but
// it has to be declared with a reason — see SILENT_RETURN_OK below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PROCESSOR = readFileSync(
  join(here, "..", "..", "..", "apps", "api", "src", "queue", "processor.ts"),
  "utf8"
);

/**
 * A return may be silent only if it says why, in these words.
 *
 * Deliberately a marker rather than a list of line numbers here: a list drifts
 * the first time the file is edited and then quietly stops covering anything,
 * which is the failure mode of every hand-maintained list this codebase has
 * already been bitten by. The marker travels with the code it excuses.
 */
const SILENT_RETURN_OK = "SILENT-RETURN-OK:";

/** How far back to look for the evidence a return is accounted for. */
const WINDOW = 22;

/**
 * The region where the property actually holds.
 *
 * Not the whole file, and the boundary is the point of the rule rather than a
 * convenience. A metric row needs an organisation AND a conversation, so:
 *
 *   BEFORE the conversation is resolved there is nothing to record against.
 *   `processSingleTextMessage` returns early when no organisation maps to the
 *   inbound number, and a delivery-status webhook returns earlier still. Both
 *   log at warn, both are right, and demanding a metric row from either would
 *   be demanding a row with no tenant to attach it to.
 *
 *   AFTER `processSingleTextMessage` ends, a return belongs to a helper. When
 *   `flagHandoffBestEffort` gives up, the reply carries on — that return did
 *   not end a customer's message, so it owes nothing.
 *
 * The first version of this scan covered the file and reported all three as
 * offenders. A check that flags correct code is one people switch off, so the
 * boundary is drawn where the obligation genuinely begins: the line that puts a
 * conversation id in scope, to the end of the function that owns it.
 */
function replyPathLines() {
  const lines = PROCESSOR.split("\n");
  const start = lines.findIndex((l) => l.includes("const { conversationId, contactId, messageId"));
  assert.ok(start > -1, "the conversation destructuring moved — re-anchor this scan");
  const end = lines.findIndex((l, i) => i > start && /^async function /.test(l));
  assert.ok(end > start, "processSingleTextMessage no longer ends where expected");
  return { lines, start, end };
}

function silentReturns() {
  const { lines, start, end } = replyPathLines();
  const found = [];

  for (let i = start; i < end; i++) {
    if (!/^\s*return;\s*$/.test(lines[i])) continue;
    const window = lines.slice(Math.max(0, i - WINDOW), i).join("\n");

    // Declared exceptions are fine — that is the whole point of the marker.
    if (window.includes(SILENT_RETURN_OK)) continue;

    // A return that follows a send is not silent: the customer got something.
    const replied = /send(WhatsAppText|Fallback|TriagePrompt)|sendFallbackBestEffort/.test(window);
    if (replied) continue;

    // Otherwise it must be visible AND counted. `debug` does not count: the
    // containers do not log at that level, so it is indistinguishable from
    // nothing at exactly the moment somebody needs it.
    const visible = /logger\.(info|warn|error)\(/.test(window);
    const recorded = /recordMetricBestEffort\(/.test(window);

    if (!visible || !recorded) {
      found.push({
        line: i + 1,
        visible,
        recorded,
        context: lines[i - 1].trim().slice(0, 60),
      });
    }
  }
  return found;
}

test("no early return in the reply path is silent", () => {
  const offenders = silentReturns();
  const describe = offenders
    .map(
      (o) =>
        `  processor.ts:${o.line} — ${o.visible ? "" : "not logged above debug"}` +
        `${!o.visible && !o.recorded ? " and " : ""}${o.recorded ? "" : "no metric row"}` +
        `  (${o.context})`
    )
    .join("\n");

  assert.equal(
    offenders.length,
    0,
    `a message can get no reply here and leave nothing behind:\n${describe}\n\n` +
      `Either reply, or log at info and call recordMetricBestEffort — or, if the ` +
      `return genuinely accounts for nothing, mark it "${SILENT_RETURN_OK} <reason>".`
  );
});

test("the checker can actually fail", () => {
  // A check that cannot fail is worse than no check. The scan is re-run against
  // the same file with the two fixes textually undone, and must find them.
  const broken = PROCESSOR.replace(/logger\.info\(/g, "logger.debug(").replace(
    /await recordMetricBestEffort\(\{/g,
    "// removed for the negative case ({"
  );
  const lines = broken.split("\n");
  const start = lines.findIndex((l) => l.includes("const { conversationId, contactId, messageId"));
  const end = lines.findIndex((l, i) => i > start && /^async function /.test(l));
  let offenders = 0;
  for (let i = start; i < end; i++) {
    if (!/^\s*return;\s*$/.test(lines[i])) continue;
    const window = lines.slice(Math.max(0, i - WINDOW), i).join("\n");
    if (window.includes(SILENT_RETURN_OK)) continue;
    if (/send(WhatsAppText|Fallback|TriagePrompt)|sendFallbackBestEffort/.test(window)) continue;
    if (!/logger\.(info|warn|error)\(/.test(window) || !/recordMetricBestEffort\(/.test(window)) {
      offenders++;
    }
  }
  assert.ok(offenders > 0, "the scan passes even on a file with the fixes removed");
});

test("every declared exception states its reason", () => {
  // The marker is not a way to switch the check off. Each has to carry an
  // argument somebody can disagree with.
  //
  // This asserted there was EXACTLY ONE, which was true when written and is a
  // count rather than a property -- the shape this suite has spent the week
  // unpicking. A second silent return was added deliberately on 2026-08-24 and
  // this went red for a change that was neither wrong nor careless. What the
  // tripwire is for is that a marker cannot be added without a reason, so that
  // is what it checks now, of each one, with a floor so a split finding nothing
  // still fails.
  const markers = PROCESSOR.split(SILENT_RETURN_OK);
  const declared = markers.length - 1;
  assert.ok(declared >= 1, "no silent return is declared — has the marker been renamed?");

  for (let i = 1; i <= declared; i++) {
    const reason = markers[i].split(String.fromCharCode(10))[0].trim();
    assert.ok(reason.length > 12, `a marker states no reason, got: "${reason}"`);
  }

  // The two that exist, by what they claim rather than by how many there are.
  assert.ok(PROCESSOR.includes("a webhook retry of a message already accounted for"));
  assert.ok(PROCESSOR.includes("the row conflicted and could not then be found"));
  // And the first reason must be true: a null messageId has exactly one cause.
  assert.ok(PROCESSOR.includes("on conflict (wa_message_id) do nothing"));
});

test("both branches that were found still record what they did", () => {
  // The specific two, by name, so a future edit that reverts one is caught with
  // a message that says which rather than only that something regressed.
  assert.match(PROCESSOR, /Agent stood down — a person has this conversation/);
  assert.match(PROCESSOR, /Twin stood down — the employee is handling this conversation/);
  assert.equal(
    (PROCESSOR.match(/replyOutcome: "skipped_handover" as const/g) ?? []).length,
    2,
    "both stand-down branches must record the outcome"
  );
});
