// The Property Finder client (7 Nov 2026): the only code that knows Property
// Finder's addresses. The key is checked by asking for a client-credentials
// token; the four listing calls exist with their final shape but are not built
// until Property Finder's listing format is known. The key and secret never
// come back in a message, even when Property Finder repeats them.
//
// Spec: docs/superpowers/specs/2026-11-07-property-finder-connection-design.md §1, §4
import { test } from "node:test";
import assert from "node:assert/strict";
import { makePfClient, PF_ENDPOINTS } from "../src/lib/property-finder.ts";

const CREDS = { key: "KEY1", secret: "s3cr3t", environment: "live" };

/** A fetch that records its calls and answers with the given status and body. */
function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    if (status instanceof Error) throw status;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fn, calls };
}

test("the key is checked with a client-credentials token request", async () => {
  const f = fakeFetch(200, { access_token: "t", expires_in: 1800 });
  const answer = await makePfClient(f.fn).checkKey(CREDS);
  assert.deepEqual(answer, { ok: true });
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, PF_ENDPOINTS.live.token);
  assert.equal(url, "https://auth.propertyfinder.com/auth/oauth/v1/token");
  assert.equal(init.method, "POST");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("authorization"), `Basic ${Buffer.from("KEY1:s3cr3t").toString("base64")}`);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(init.body, JSON.stringify({ scope: "openid", grant_type: "client_credentials" }));
  assert.ok(init.signal, "every request has a timeout");
});

test("a sandbox key is checked at the sandbox address", async () => {
  const f = fakeFetch(200, { access_token: "t" });
  await makePfClient(f.fn).checkKey({ ...CREDS, environment: "sandbox" });
  assert.equal(f.calls[0].url, PF_ENDPOINTS.sandbox.token);
});

test("401 and 403 are key-refused", async () => {
  for (const status of [401, 403]) {
    const answer = await makePfClient(fakeFetch(status, { message: "invalid client" }).fn).checkKey(CREDS);
    assert.deepEqual(answer, { ok: false, kind: "key-refused", message: "invalid client" }, String(status));
  }
});

test("400 is refused, in Property Finder's own words", async () => {
  const answer = await makePfClient(fakeFetch(400, { error: "invalid_scope", error_description: "scope not allowed" }).fn).checkKey(CREDS);
  assert.deepEqual(answer, { ok: false, kind: "refused", message: "scope not allowed" });
});

test("500 and a failed connection are unreachable", async () => {
  const a = await makePfClient(fakeFetch(503, "upstream down").fn).checkKey(CREDS);
  assert.deepEqual(a, { ok: false, kind: "unreachable", message: "HTTP 503" });
  const b = await makePfClient(fakeFetch(new TypeError("fetch failed")).fn).checkKey(CREDS);
  assert.deepEqual(b, { ok: false, kind: "unreachable", message: "fetch failed" });
});

test("an answer without a token is unreachable", async () => {
  const answer = await makePfClient(fakeFetch(200, { hello: "there" }).fn).checkKey(CREDS);
  assert.deepEqual(answer, { ok: false, kind: "unreachable", message: "Property Finder answered without a token" });
});

test("the secret never appears in a message, even when Property Finder echoes it", async () => {
  const echo = fakeFetch(400, { message: `bad secret s3cr3t for key KEY1 ${"x".repeat(400)}` });
  const answer = await makePfClient(echo.fn).checkKey(CREDS);
  assert.equal(answer.ok, false);
  assert.match(answer.message, /•••/);
  assert.doesNotMatch(answer.message, /s3cr3t/);
  assert.doesNotMatch(answer.message, /KEY1/);
  assert.ok(answer.message.length <= 300, `message is ${answer.message.length} characters`);
  const thrown = await makePfClient(fakeFetch(new Error("connect to s3cr3t failed")).fn).checkKey(CREDS);
  assert.doesNotMatch(thrown.message, /s3cr3t/);
});

test("the listing calls are not built yet, and never reach the network", async () => {
  const f = fakeFetch(200, {});
  const client = makePfClient(f.fn);
  const listing = { reference: "u1" };
  const notBuilt = { ok: false, kind: "unreachable", message: "Property Finder's listing calls are not built yet." };
  assert.deepEqual(await client.createListing(CREDS, listing), notBuilt);
  assert.deepEqual(await client.updateListing(CREDS, "PF-1", listing), notBuilt);
  assert.deepEqual(await client.publishListing(CREDS, "PF-1"), notBuilt);
  assert.deepEqual(await client.unpublishListing(CREDS, "PF-1"), notBuilt);
  assert.equal(f.calls.length, 0);
});
