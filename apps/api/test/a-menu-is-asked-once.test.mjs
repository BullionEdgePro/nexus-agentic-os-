// Two first messages seconds apart (a photo then a voice note, or "Hi" then the
// question) each got the full "which business?" menu — the owner's own test on
// 2026-09-30 received it twice, six seconds apart — and each repeat burned one
// of the customer's three triage attempts. Pinned as text, like the pipeline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PROC = readFileSync(join(here, "..", "src", "queue", "processor.ts"), "utf8").replace(/\r\n/g, "\n");
const resolver = PROC.slice(PROC.indexOf("async function resolveServingOrganization("));
const body = resolver.slice(0, resolver.indexOf("\n}\n"));

test("a menu sent in the last five minutes is not sent again", () => {
  assert.match(PROC, /const TRIAGE_REPEAT_WINDOW_MS = 5 \* 60 \* 1000;/);
  const guard = body.indexOf("Date.now() - promptedAt < TRIAGE_REPEAT_WINDOW_MS");
  const ask = body.lastIndexOf("await askWhichBusiness(ctx, asked);");
  assert.ok(guard > -1 && ask > guard, "the repeat check must come before the menu is sent");
  // Holding back still says so, at a level the containers actually log.
  assert.match(body.slice(guard, ask), /logger\.info\(/);
  assert.match(body.slice(guard, ask), /return \{ kind: "asked" \};/);
});

test("the message is still read for a business before anything is held back", () => {
  // A clear keyword in the second message must still route it.
  const classify = body.indexOf("const outcome = classifyBusiness(ctx.text, businesses);");
  const guard = body.indexOf("Date.now() - promptedAt < TRIAGE_REPEAT_WINDOW_MS");
  assert.ok(classify > -1 && classify < guard);
  // And an answer to the menu ("4") is still taken as the choice.
  assert.ok(body.indexOf("resolveTriageReply(ctx.text, businesses)") < guard);
});

test("a held-back repeat does not use up a triage attempt", () => {
  // Attempts are counted when a menu is actually sent (recordTriagePrompt inside
  // askWhichBusiness), and the held-back path returns before that.
  const guardBlock = body.slice(body.indexOf("Date.now() - promptedAt"), body.lastIndexOf("await askWhichBusiness"));
  assert.ok(!/recordTriagePrompt|triageAttempts\s*\+/.test(guardBlock));
});
