// The "unsubscribe by email" link is honoured (audit, 4 Nov 2026).
//
// Every campaign email offers List-Unsubscribe: <mailto:…?subject=unsubscribe>.
// A mail client that uses it sends an email whose SUBJECT is "unsubscribe" and
// whose body is empty or boilerplate — and the sweep read only the body, so the
// person who asked kept receiving campaign emails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SYNC = readFileSync(new URL("../src/services/email-sync.ts", import.meta.url), "utf8");

test("an email whose subject is 'unsubscribe' opts the sender out", () => {
  const sweep = SYNC.slice(SYNC.indexOf('// "Unsubscribe" or "stop" in reply to a campaign email'));
  assert.match(sweep.slice(0, 900), /asksToUnsubscribe\(m\.subject\)/);
  assert.match(SYNC, /function asksToUnsubscribe\(subject: string \| null \| undefined\): boolean/);
});
