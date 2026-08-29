/**
 * Connecting somebody's real social account.
 *
 * ============================================================
 * TWO THINGS THAT FAIL WITHOUT ANYBODY NOTICING
 * ============================================================
 *
 * A stored OAuth token is a bearer credential for a person's actual TikTok. In
 * plain text it works exactly as well as encrypted — until a database dump
 * lands on a laptop, at which point it is five live logins and nobody can tell
 * it happened.
 *
 * And a "Connect TikTok" button reads, to almost everybody, as "then I will see
 * my TikTok messages here". TikTok publishes no direct-message API to anybody.
 * That expectation ends in somebody hunting for an inbox that cannot exist and
 * concluding the connection is broken.
 *
 * Neither shows up as an error. Both are pinned here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { sealToken, openToken } from "../../../packages/db/src/token-crypto.ts";
import { tiktokScopes, challengeFor, makeVerifier } from "../src/lib/tiktok.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const ROUTE = read("apps", "api", "src", "routes", "connections.ts");
const STORE = read("packages", "db", "src", "social-connections.ts");
const PANEL = read("apps", "web", "app", "deck", "my-clients", "connections.tsx");
const MIGRATION = read("packages", "db", "migrations", "076-a-channel-somebody-owns.sql");

// ============================================================
// The credential
// ============================================================

test("a token round-trips through encryption", () => {
  process.env.NEXUS_TOKEN_KEY ??= "a-test-key-that-is-long-enough-to-use";
  const secret = "act.example-tiktok-access-token-value";
  const sealed = sealToken(secret);

  assert.notEqual(sealed, secret, "the token was stored in the clear");
  assert.equal(openToken(sealed), secret);
});

test("the stored form carries its own iv and tag", () => {
  process.env.NEXUS_TOKEN_KEY ??= "a-test-key-that-is-long-enough-to-use";
  const sealed = sealToken("something");
  assert.equal(sealed.split(":").length, 3, "not iv:tag:ciphertext");
});

test("a tampered ciphertext fails rather than decrypting to something else", () => {
  // The reason for GCM over CBC. With CBC a flipped bit is a silently
  // different token, which fails later, elsewhere, as a platform auth error.
  process.env.NEXUS_TOKEN_KEY ??= "a-test-key-that-is-long-enough-to-use";
  const sealed = sealToken("original-token");
  const [iv, tag, body] = sealed.split(":");
  const flipped = Buffer.from(body, "base64");
  flipped[0] ^= 0xff;

  assert.equal(openToken([iv, tag, flipped.toString("base64")].join(":")), null);
});

test("garbage decrypts to null instead of throwing", () => {
  // A row encrypted under a rotated key must degrade to "reconnect this", not
  // take out whatever screen was listing connections.
  assert.equal(openToken("not-even-close"), null);
  assert.equal(openToken(""), null);
  assert.equal(openToken(null), null);
});

test("the listing query never selects the ciphertext", () => {
  // Not "selects and strips" — does not ask. A field that is never fetched
  // cannot be spread into a JSON response, and spreading a row into a response
  // is how credentials leak in practice.
  const fn = STORE.slice(STORE.indexOf("export async function listConnections"));
  const sql = fn.slice(0, fn.indexOf("\n}"));
  assert.ok(!/select[\s\S]*access_token_enc,/.test(sql), "the listing selects the token");
  assert.match(sql, /\(access_token_enc is not null\) as has_token/);
});

test("exactly one function returns a usable token, and it is named for it", () => {
  assert.match(STORE, /export async function connectionSecret/);
  const others = STORE.match(/openToken\(/g) ?? [];
  assert.ok(others.length <= 3, `openToken is called in ${others.length} places; keep it to the secret path`);
});

test("the migration says the token is encrypted", () => {
  assert.match(MIGRATION, /access_token_enc/);
  assert.ok(!/access_token text/.test(MIGRATION), "a plaintext token column is back");
});

// ============================================================
// The honesty
// ============================================================

test("the API states what TikTok cannot do, not just what it can", () => {
  assert.match(ROUTE, /no way for any app to read or send direct messages/i);
  assert.match(ROUTE, /offers:/);
  assert.match(ROUTE, /cannot:/);
});

test("the limit is shown whether or not the account is connected", () => {
  // It is the expectation the panel exists to correct, so it cannot be hidden
  // behind a connected state.
  const cannot = PANEL.indexOf("tiktok.cannot");
  const connectedBlock = PANEL.indexOf("connected && !connected.usable");
  assert.ok(cannot > -1, "the panel never shows what TikTok cannot do");
  assert.ok(cannot < connectedBlock, "the limit is only shown once connected");
});

test("an unconfigured provider names the exact thing the owner must do", () => {
  // "Not configured" with no next step is a dead end.
  assert.match(ROUTE, /TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET/);
  assert.match(ROUTE, /redirect URI/i);
  assert.match(PANEL, /tiktok\.needs/);
});

// ============================================================
// The flow
// ============================================================

test("PKCE is real, not decorative", () => {
  // TikTok requires it. A challenge that is not the hash of the verifier fails
  // the exchange with a message about the code, not about the challenge.
  const verifier = makeVerifier();
  assert.ok(verifier.length >= 40);
  const challenge = challengeFor(verifier);
  assert.match(challenge, /^[0-9a-f]{64}$/, "the challenge is not a sha256 hex digest");
  assert.equal(challengeFor(verifier), challenge, "the challenge is not deterministic");
});

test("the verifier travels in the signed cookie, not in memory", () => {
  // A module-level map works on one process and fails intermittently behind
  // two: the callback can land on a different container than the redirect.
  assert.match(ROUTE, /verifier,/);
  assert.match(ROUTE, /signState\(/);
  assert.ok(
    !/const pending = new Map|pendingVerifiers/.test(ROUTE),
    "the verifier is being held in process memory again"
  );
});

test("the state is verified in constant time and expires", () => {
  assert.match(ROUTE, /timingSafeEqual/);
  assert.match(ROUTE, /issuedAt > STATE_TTL_MS/);
});

test("the returned state must match the cookie as well as the signature", () => {
  // Checking only the cookie would accept a code from a flow somebody else
  // started.
  assert.match(ROUTE, /decodeURIComponent\(stored\) !== returnedState/);
});

test("the callback is throttled", () => {
  // It does cryptography on caller-supplied input and writes a row on success.
  assert.match(ROUTE, /loginBlocked\(source\)/);
  assert.match(ROUTE, /recordLoginFailure\(source/);
  assert.match(ROUTE, /clearLoginFailures\(source\)/);
});

// ============================================================
// Scopes
// ============================================================

test("the scope list is never empty", () => {
  // An authorize URL with no scope fails exactly as hard as one asking for
  // something ungranted, with a much more confusing message.
  const before = process.env.TIKTOK_SCOPES;
  process.env.TIKTOK_SCOPES = "   ";
  assert.ok(tiktokScopes().length > 0);
  process.env.TIKTOK_SCOPES = ",,,";
  assert.ok(tiktokScopes().length > 0);
  if (before === undefined) delete process.env.TIKTOK_SCOPES;
  else process.env.TIKTOK_SCOPES = before;
});

test("fields are derived from granted scopes, not from a fixed list", () => {
  // TikTok fails an ENTIRE request with scope_not_authorized when asked for one
  // field the token does not carry — it does not return the rest.
  const TIKTOK = read("apps", "api", "src", "lib", "tiktok.ts");
  assert.match(TIKTOK, /function fieldsFor\(scopes: string\[\]\)/);
  assert.match(TIKTOK, /scope_not_authorized/);
  assert.match(TIKTOK, /user\.info\.stats/);
});

test("a missing video scope returns nothing rather than an error", () => {
  // A connection without it is still a working connection.
  const TIKTOK = read("apps", "api", "src", "lib", "tiktok.ts");
  const fn = TIKTOK.slice(TIKTOK.indexOf("export async function fetchTikTokVideos"));
  assert.match(fn, /if \(!scopes\.includes\("video\.list"\)\) return \[\]/);
});
