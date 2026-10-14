// Business HQ answers admins and nobody else (spec §3, §5, §8). Pinned as text:
// the route guards, what a response may contain, where the admin's identity
// comes from, and what the vault refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8").replace(/\r\n/g, "\n");
const ROUTE = read("src", "routes", "hq.ts");
const INDEX = read("src", "index.ts");

test("every /api/hq route is behind the admin-only guard, mounted before the route", () => {
  const guardAll = INDEX.indexOf('app.use("/api/hq/*", operatorOnly);');
  const guardRoot = INDEX.indexOf('app.use("/api/hq", operatorOnly);');
  const mount = INDEX.indexOf('app.route("/api/hq", hqRoute);');
  assert.ok(guardAll > -1 && guardRoot > -1 && mount > -1, "both guards and the mount exist");
  assert.ok(guardAll < mount && guardRoot < mount, "the guards come first");
});

test("no response carries a sealed password, and the vault list is the public shape", () => {
  assert.ok(!ROUTE.includes("secret_enc"), "the route never names the sealed column");
  const responses = ROUTE.match(/c\.json\([\s\S]*?\);/g) ?? [];
  assert.ok(responses.length > 20, "the responses were found");
  for (const r of responses) assert.ok(!/secretSealed|sealVaultSecret/.test(r), `a response carries a sealed value: ${r.slice(0, 80)}`);
  assert.match(ROUTE, /listVaultEntries\(/);
  assert.ok(!ROUTE.includes("getVaultSecretSealed"), "only the reveal service reads the sealed value");
});

test("the admin is the session's, never the request's", () => {
  assert.match(ROUTE, /scope\.adminId/);
  assert.ok(!/body\.adminId|body\.admin_id/.test(ROUTE));
  assert.match(ROUTE, /Sign in with your own admin account to use the vault\./);
});

test("a reveal records where it came from", () => {
  assert.match(ROUTE, /x-forwarded-for/);
  assert.match(ROUTE, /user-agent/);
  assert.match(ROUTE, /revealVaultSecret\(/);
});

test("card numbers are refused in plain words", () => {
  assert.match(ROUTE, /looksLikeCardNumber\(/);
  assert.match(ROUTE, /"Card numbers do not belong here — use a payment manager\."/);
});

test("a password is only written while unlocked, and only with the vault key", () => {
  assert.match(ROUTE, /vaultUnlockedFor\(/);
  assert.match(ROUTE, /vaultConfigured\(\)/);
  assert.match(ROUTE, /sealVaultSecret\(/);
});

test("the review sandbox is not a business here, and connected pages fill the social tab", () => {
  assert.match(ROUTE, /slug !== "review-demo"/);
  assert.match(ROUTE, /source: "connected"/);
  assert.match(ROUTE, /provider === "facebook"|"facebook", "instagram"/);
});

test("Check now says plainly when it is too soon", () => {
  assert.match(ROUTE, /enqueueHqCheckNow\(/);
  assert.match(ROUTE, /"Checked less than 5 minutes ago\."/);
});

test("a locked vault and a wrong password never answer 401, which the web reads as a lapsed session", () => {
  assert.ok(!/, 401\)/.test(ROUTE), "no 401 anywhere in Business HQ");
  assert.match(ROUTE, /\{ error: "Unlock again" \}, 423/);
  assert.match(ROUTE, /\{ error: "That password is not right\." \}, 403/);
});

// FINAL REVIEW, Important 3 and 4: a stored javascript: link became a clickable
// href beside an unlocked vault; keywords skipped the card check.
test("links must be http or https, and keywords are card-checked too", () => {
  assert.match(ROUTE, /safeHttpUrl\(/);
  assert.match(ROUTE, /"Links must start with http:\/\/ or https:\/\/\."/);
  const kw = ROUTE.slice(ROUTE.indexOf("async function saveKeyword("), ROUTE.indexOf("hqRoute.delete(\"/:slug/keywords/:id\""));
  assert.match(kw, /hasCard\(/);
});
