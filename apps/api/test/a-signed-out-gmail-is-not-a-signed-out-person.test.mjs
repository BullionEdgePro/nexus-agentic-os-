// A Gmail that Google signed out is not a person who is signed out of Nexus.
//
// FOUND ON 12 OCT 2026 IN A STAFF ACCOUNT: Connections showed "Your session
// expired. Sign in again." on a session that was plainly working — every other
// card on the page had loaded. The page's own Gmail read was answering 401
// because Google had revoked the mailbox's refresh token, and the web client
// reads ANY 401 as its own session lapsing (apps/web/lib/api.ts, readableError).
// So the person was told to sign in again, which fixes nothing, and the real
// sentence — "Google has signed this connection out … Connect it again." — was
// thrown away. A third party's sign-out is a conflict with that connection's
// state (409), never 401.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SYNC = readFileSync(join(here, "..", "src", "services", "email-sync.ts"), "utf8").replace(/\r\n/g, "\n");

function gmailToken() {
  const at = SYNC.indexOf("export async function gmailToken(");
  assert.ok(at > -1, "gmailToken is exported");
  return SYNC.slice(at, SYNC.indexOf("\n}\n", at));
}

test("a Gmail sign-in Google revoked or let lapse never answers 401", () => {
  const body = gmailToken();
  assert.ok(!/status: 401/.test(body), "401 is Nexus's own session; the web client turns it into 'sign in again'");
  assert.ok(!/\| 401\b/.test(body), "the declared status type no longer includes 401");
});

test("it answers 409, so the person reads why and what to do", () => {
  const body = gmailToken();
  assert.match(body, /Google has signed this connection out[^"]*Connect it again\./);
  assert.ok((body.match(/status: 409/g) ?? []).length >= 2, "both the lapsed and the revoked sign-in answer 409");
});
