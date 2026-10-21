// A mailbox that refuses its password is not a crash.
//
// FOUND 21 OCT 2026. A business mailbox's IMAP login failed intermittently, and
// imapflow emitted an `error` event that nothing listened for. Node made it an
// uncaught exception and the worker process died — every queue, WhatsApp
// replies included, stopped until Docker restarted it (three times in one day).
// The sweep already catches the rejected connect() per mailbox; the event only
// needed somewhere to land.
import { test } from "node:test";
import assert from "node:assert/strict";
import { imapClient } from "../src/lib/imap-email.ts";

test("an IMAP client has an error listener before it connects", () => {
  const client = imapClient("info@example.com", "wrong");
  assert.ok(client.listenerCount("error") > 0, "an unheard 'error' event kills the process");
});

test("an emitted error does not throw out of the client", () => {
  const client = imapClient("info@example.com", "wrong");
  assert.doesNotThrow(() => client.emit("error", Object.assign(new Error("Connection not available"), { authenticationFailed: true })));
});

test("a login to nowhere rejects for its caller instead of crashing", async () => {
  process.env.IMAP_HOST = "127.0.0.1";
  process.env.IMAP_PORT = "1";
  try {
    const { verifyImapLogin } = await import("../src/lib/imap-email.ts");
    await assert.rejects(verifyImapLogin("info@example.com", "wrong"));
  } finally {
    delete process.env.IMAP_HOST;
    delete process.env.IMAP_PORT;
  }
});
