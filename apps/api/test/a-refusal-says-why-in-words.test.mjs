// A refusal says why, in words.
//
// A campaign recipient that fails stores Meta's raw error body in
// broadcast_recipients.delivery_error — a JSON blob with a numeric code. Shown
// to a staff member as-is it says nothing they can act on, and the five codes
// below are the ones a staff campaign actually meets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { explainSendError } from "../src/lib/send-errors.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const BOOK = readFileSync(join(root, "packages", "db", "src", "client-book.ts"), "utf8");
const ROUTE = readFileSync(join(root, "apps", "api", "src", "routes", "my-campaigns.ts"), "utf8");

const meta = (code) =>
  `WhatsApp template send failed (400): {"error":{"message":"(#${code}) something","type":"OAuthException","code":${code},"fbtrace_id":"x"}}`;

test("not on WhatsApp", () => {
  assert.equal(explainSendError(meta(131026)), "This person is not on WhatsApp.");
});

test("outside the 24-hour window", () => {
  assert.equal(
    explainSendError(meta(131047)),
    "More than 24 hours since they last wrote — only an approved message can reach them."
  );
});

test("marketing held back by WhatsApp", () => {
  assert.equal(
    explainSendError(meta(131049)),
    "WhatsApp held this marketing message back to protect the person's inbox. Try again in a few days."
  );
});

test("message not approved on this number", () => {
  assert.equal(explainSendError(meta(132001)), "That message is not approved on this number.");
});

test("too many messages to one person", () => {
  assert.equal(explainSendError(meta(131056)), "Too many messages to this person in a short time.");
});

test("anything else is shown as it came, trimmed to 200 characters", () => {
  const raw = "x".repeat(300);
  assert.equal(explainSendError(raw), "x".repeat(200));
  assert.equal(explainSendError("  socket hang up  "), "socket hang up");
});

test("a code inside some other number is not mistaken for one", () => {
  // A phone number or trace id that happens to contain 131026 is not the error code.
  assert.equal(explainSendError('{"error":{"code":100,"message":"bad param 971310260000"}}').includes("not on WhatsApp"), false);
});

test("the campaign list reports delivered and the top failure reasons, explained", () => {
  assert.match(BOOK, /delivered: number;/);
  assert.match(BOOK, /topFailures: Array<\{ reason: string; count: number \}>/);
  assert.match(ROUTE, /explainSendError\(/);
});
