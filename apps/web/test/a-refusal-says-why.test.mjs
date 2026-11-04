/**
 * A refusal says why (audit, 4 Nov 2026).
 *
 * When Meta refused a reply on the spot (Instagram or Messenger outside their
 * window, a blocked number), the API answered with its sentence and Meta's own
 * reason nested inside as JSON. The reader's pattern stopped at the first
 * escaped quote, matched nothing, and the person read "The platform had a
 * problem with that" -- for a refusal that had a reason, in words, one level in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readableError } from "../lib/api.ts";

const fromApi = (status, error) => new Error(`API ${status} on /api/conversations/c1/messages: ${JSON.stringify({ error })}`);

test("Meta's reason inside the API's sentence is what the person reads", () => {
  const nested = `Instagram send failed (400): ${JSON.stringify({
    error: { message: "(#10) This message is sent outside of allowed window.", type: "OAuthException", code: 10 },
  })}`;
  const said = readableError(fromApi(502, nested));
  assert.match(said, /outside of allowed window/);
  assert.match(said, /^Instagram send failed/);
  assert.doesNotMatch(said, /\{/, "raw JSON reached the person");
});

test("a plain sentence from the API still comes through as it was written", () => {
  assert.equal(readableError(fromApi(409, "WhatsApp only delivers a reply within 24 hours.")), "WhatsApp only delivers a reply within 24 hours.");
});
