// An agent that cannot answer hands over; it never goes quiet (audit, 4 Nov 2026).
//
// Three ways the AI reply path left a customer alone:
// - the model came back with no text (an empty end_turn after tools, a
//   refusal): `if (!result.text) return;` sent nothing, recorded nothing, and
//   the silent-return gate missed it;
// - it ran out of tool rounds and sent "a human will follow up shortly" as an
//   ordinary reply -- no handover, nobody told, and possibly after a booking
//   had just been made;
// - a hung call to the model had the SDK's ten-minute timeout and two retries,
//   while the customer's lock lasts 90 seconds.
// The first two now fail into the path that sends the fallback and hands over
// only when someone can take it; the third is bounded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const PROCESSOR = read("../src/queue/processor.ts");
const AGENT = read("../../../packages/agents/src/domain-agent.ts");
const CHECKER = read("../../../packages/governance/src/hallucination.ts");

test("an empty reply from the model is a failure, not a silent return", () => {
  assert.doesNotMatch(PROCESSOR, /if \(!result\.text\) return;/);
  assert.match(PROCESSOR, /if \(!result\.text\?\.trim\(\)\) throw new Error\("The model returned no reply text/);
});

test("running out of tool rounds is a failure too, so a person is actually brought in", () => {
  assert.doesNotMatch(AGENT, /a human will follow up shortly/);
  assert.match(AGENT, /throw new Error\(\s*`The agent used all \$\{MAX_TOOL_ITERATIONS\} tool rounds/);
});

test("a call to the model has a limit that fits inside the customer's lock", () => {
  for (const source of [AGENT, CHECKER]) {
    assert.match(source, /new Anthropic\(\{ apiKey: process\.env\.ANTHROPIC_API_KEY, timeout: 30_000, maxRetries: 1 \}\)/);
  }
});
