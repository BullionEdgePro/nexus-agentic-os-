// Regression tests for a real production exposure: /api/* accepted every
// request with no authentication. CORS was the only thing in front of it, and
// CORS is a browser convention — an anonymous curl returned HTTP 200 with
// customer WhatsApp numbers and message bodies for every tenant.
//
// These test the credential logic directly (pure crypto + cookie parsing),
// so they need no server, no database, and no network.
import { test } from "node:test";
import assert from "node:assert/strict";

const SECRET = "test-session-secret";

const { verifySessionToken, readCookie } = await import("../src/lib/session.ts");

// Mirror of apps/web/lib/auth.ts signSession — deliberately reimplemented here
// rather than imported, so this test would catch the two halves drifting apart.
function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return Buffer.from(s, "binary").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signSession(sub, { expiresInMs = 60_000, secret = SECRET } = {}) {
  const enc = new TextEncoder();
  const body = b64url(enc.encode(JSON.stringify({ sub, exp: Date.now() + expiresInMs })));
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

test("a validly signed, unexpired session is accepted", async () => {
  const token = await signSession("operator@example.com");
  const session = await verifySessionToken(token, SECRET);
  assert.equal(session?.sub, "operator@example.com");
});

test("no token is rejected — this is the exact hole that was open in production", async () => {
  assert.equal(await verifySessionToken(undefined, SECRET), null);
  assert.equal(await verifySessionToken("", SECRET), null);
});

test("a token signed with a different secret is rejected", async () => {
  const forged = await signSession("attacker@evil.com", { secret: "not-the-real-secret" });
  assert.equal(await verifySessionToken(forged, SECRET), null);
});

test("a tampered payload is rejected even though the signature is well-formed", async () => {
  // Swapping the body while keeping a valid-looking signature must fail HMAC.
  const token = await signSession("operator@example.com");
  const [, sig] = token.split(".");
  const forgedBody = b64url(new TextEncoder().encode(JSON.stringify({ sub: "admin", exp: Date.now() + 60_000 })));
  assert.equal(await verifySessionToken(`${forgedBody}.${sig}`, SECRET), null);
});

test("an expired session is rejected", async () => {
  const token = await signSession("operator@example.com", { expiresInMs: -1000 });
  assert.equal(await verifySessionToken(token, SECRET), null);
});

test("malformed tokens are rejected without throwing", async () => {
  for (const bad of ["garbage", "a.b.c", ".", "....", "notbase64!.notbase64!"]) {
    assert.equal(await verifySessionToken(bad, SECRET), null, `"${bad}" must not authenticate`);
  }
});

test("a session with no subject is rejected", async () => {
  const enc = new TextEncoder();
  const body = b64url(enc.encode(JSON.stringify({ exp: Date.now() + 60_000 })));
  const key = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  assert.equal(await verifySessionToken(`${body}.${b64url(sig)}`, SECRET), null);
});

// ============================================================
// Cookie parsing
// ============================================================

test("the session cookie is found among other cookies", () => {
  assert.equal(readCookie("a=1; nexus_session=abc.def; b=2", "nexus_session"), "abc.def");
  assert.equal(readCookie("nexus_session=only", "nexus_session"), "only");
});

test("cookie parsing does not match a prefix of another cookie name", () => {
  // "other_nexus_session" must not satisfy a lookup for "nexus_session".
  assert.equal(readCookie("other_nexus_session=nope", "nexus_session"), undefined);
});

test("a missing or empty cookie header yields undefined, not a crash", () => {
  assert.equal(readCookie(undefined, "nexus_session"), undefined);
  assert.equal(readCookie("", "nexus_session"), undefined);
  console.log("PASS: API session auth fails closed on every malformed, forged, and absent credential");
});
