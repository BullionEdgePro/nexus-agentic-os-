/**
 * Bulk messaging's message writer runs on a stronger model than the platform's
 * short summarise-this jobs (30 Oct 2026). `completeText` lets that one caller
 * choose its model, effort, refusal fallback and timeout; every other caller
 * sends exactly what it sent before.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");
const SRC = read("packages", "agents", "src", "anthropic-text.ts");

test("one caller can choose its model, effort and fallback", () => {
  assert.match(SRC, /model: input\.model \?\? TEXT_MODEL/);
  assert.match(SRC, /output_config: \{ effort: input\.effort \}/);
  assert.match(SRC, /fallbacks: "default"/);
  assert.match(SRC, /"anthropic-beta": "server-side-fallback-2026-07-01"/);
  assert.match(SRC, /timeout: input\.timeoutMs/);
  assert.doesNotMatch(SRC, /temperature/);
});

test("a writer call gives up once at its timeout instead of retrying, and other calls are unchanged", async () => {
  // The SDK retries a timed-out request (maxRetries defaults to 2), so a 45 s
  // limit could become ~137 s and three billed calls behind a 60 s proxy.
  const calls = [];
  mock.module("@anthropic-ai/sdk", {
    defaultExport: class FakeAnthropic {
      constructor() {
        this.messages = {
          create: async (params, options) => {
            calls.push({ params, options });
            return { content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Hi {name}" }] };
          },
        };
      }
    },
  });
  process.env.ANTHROPIC_API_KEY ||= "test-key";
  const { completeText } = await import("../../../packages/agents/src/anthropic-text.ts");

  const writer = await completeText({ prompt: "p", model: "claude-opus-5-5", effort: "low", fallback: true, timeoutMs: 45_000, maxTokens: 4000 });
  assert.equal(writer, "Hi {name}");
  assert.deepEqual(calls[0].options, { headers: { "anthropic-beta": "server-side-fallback-2026-07-01" }, timeout: 45_000, maxRetries: 0 });
  assert.equal(calls[0].params.model, "claude-opus-5-5");
  assert.deepEqual(calls[0].params.output_config, { effort: "low" });
  assert.equal(calls[0].params.fallbacks, "default");

  assert.equal(await completeText({ prompt: "q" }), "Hi {name}");
  assert.deepEqual(calls[1].options, {});
  assert.equal(calls[1].params.output_config, undefined);
  assert.equal(calls[1].params.fallbacks, undefined);
});
