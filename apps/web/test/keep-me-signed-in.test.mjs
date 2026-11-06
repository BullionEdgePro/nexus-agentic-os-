/**
 * Keep me signed in (5 Nov 2026). The owner: "if they log in in nexus on their
 * own account save it so if they open again their own account it auto log in".
 *
 * The staff sign-in had a "Keep me signed in" switch, on by default, that was
 * never sent anywhere: every sign-in ended after 12 hours whatever it said. In
 * the live logs that was 510 refused live-feed reconnects and 264 refused
 * polls in one working day -- tabs left open past their 12 hours, showing
 * "Live updates paused -- reconnecting" to agents who read it as WhatsApp
 * disconnecting.
 *
 * Now a kept sign-in lasts 30 days on that device and is renewed while it is
 * used; one not kept still ends after 12 hours, and with the browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import {
  signSession,
  verifySession,
  sessionCookieOptions,
  needsRenewal,
  sessionSecret,
  SESSION_COOKIE,
} from "../lib/auth.ts";
import { middleware } from "../middleware.ts";

const DAY = 24 * 60 * 60 * 1000;
const STAFF = { role: "employee", employeeId: "e1", organizationId: "o1", organizationSlug: "zipicka" };
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("a kept sign-in lasts 30 days", async () => {
  const session = await verifySession(await signSession("agent@zipicka.com", STAFF, { remember: true }));
  assert.equal(session?.kept, true);
  assert.equal(session?.employeeId, "e1");
  assert.ok(session.expiresAt > Date.now() + 29 * DAY, "a kept sign-in must last about 30 days");
});

test("a sign-in not kept still ends after 12 hours", async () => {
  const session = await verifySession(await signSession("agent@zipicka.com", STAFF));
  assert.equal(session?.kept, false);
  assert.ok(session.expiresAt <= Date.now() + 12 * 60 * 60 * 1000 + 1000);
});

test("a kept cookie outlives the browser; one not kept ends with it", () => {
  assert.equal(sessionCookieOptions(true).maxAge, 30 * 24 * 60 * 60);
  assert.equal(sessionCookieOptions(false).maxAge, undefined);
  for (const kept of [true, false]) {
    const options = sessionCookieOptions(kept);
    assert.equal(options.httpOnly, true);
    assert.equal(options.sameSite, "lax");
    assert.equal(options.path, "/");
  }
});

test("a kept sign-in more than a day old is renewed; a fresh or unkept one is not", async () => {
  const now = Date.now();
  const old = await verifySession(await signSession("a@b.co", STAFF, { remember: true, now: now - 2 * DAY }));
  const fresh = await verifySession(await signSession("a@b.co", STAFF, { remember: true }));
  const unkept = await verifySession(await signSession("a@b.co", STAFF, { now: now - 2 * 60 * 60 * 1000 }));
  assert.equal(needsRenewal(old, now), true);
  assert.equal(needsRenewal(fresh, now), false);
  assert.equal(needsRenewal(unkept, now), false);
});

/** A token as signed before 5 Nov 2026: sub, exp and the claims, nothing else. */
async function oldStyleToken(payload) {
  const b64url = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(sessionSecret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${body}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))))}`;
}

test("renewal stops 90 days after the person last typed their code (review, 5 Nov 2026)", async () => {
  // Renewed forever while used, a stolen cookie -- an admin's sees every
  // business -- would never run out. Carried through renewals, the original
  // sign-in time caps it: at most 90 days, then sign in again.
  const now = Date.now();
  const at60 = await verifySession(await signSession("a@b.co", STAFF, { remember: true, now: now - 2 * DAY, since: now - 60 * DAY }));
  assert.equal(needsRenewal(at60, now), true);
  assert.equal(at60.signedInAt, now - 60 * DAY, "the first sign-in time rides along");
  const capped = await verifySession(await signSession("a@b.co", STAFF, { remember: true, since: now - 89 * DAY }));
  assert.ok(capped.expiresAt <= now - 89 * DAY + 90 * DAY + 1000, "a renewal never reaches past 90 days");
  const atItsEnd = await verifySession(
    await signSession("a@b.co", STAFF, { remember: true, now: now - 2 * DAY, since: now - 89 * DAY })
  );
  assert.equal(needsRenewal(atItsEnd, now), false, "nothing left to extend, so no renewal");
  const past90 = await verifySession(
    await signSession("a@b.co", STAFF, { remember: true, now: now - 2 * DAY, since: now - 91 * DAY })
  );
  assert.equal(past90, null, "past 90 days the sign-in has ended");
});

test("the middleware's renewal keeps the first sign-in time", async () => {
  const since = Date.now() - 40 * DAY;
  const token = await signSession("a@b.co", STAFF, { remember: true, now: Date.now() - 3 * DAY, since });
  const response = await middleware(requestFor("/inbox", token));
  const session = await verifySession(response.cookies.get(SESSION_COOKIE).value);
  assert.equal(session.signedInAt, since);
});

test("a sign-in made before this change still works and is simply not renewed", async () => {
  const legacy = await verifySession(await oldStyleToken({ sub: "a@b.co", exp: Date.now() + 60 * 60 * 1000, ...STAFF }));
  assert.ok(legacy, "an unexpired old-style session must still verify");
  assert.equal(legacy.kept, false);
  assert.equal(needsRenewal(legacy, Date.now()), false);
});

function requestFor(path, token) {
  return new NextRequest(`https://nexusagenticos.com${path}`, {
    headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {},
  });
}

test("opening a screen renews a kept sign-in for another 30 days", async () => {
  const token = await signSession("a@b.co", STAFF, { remember: true, now: Date.now() - 3 * DAY });
  const response = await middleware(requestFor("/inbox", token));
  const renewed = response.cookies.get(SESSION_COOKIE);
  assert.ok(renewed?.value && renewed.value !== token, "the cookie must be re-issued");
  const session = await verifySession(renewed.value);
  assert.equal(session?.kept, true);
  assert.equal(session?.employeeId, "e1", "renewal must keep the same person and business");
  assert.equal(session?.organizationSlug, "zipicka");
  assert.ok(session.expiresAt > Date.now() + 29 * DAY);
  assert.equal(renewed.maxAge, 30 * 24 * 60 * 60);
});

test("a fresh sign-in is left alone", async () => {
  const token = await signSession("a@b.co", STAFF, { remember: true });
  const response = await middleware(requestFor("/deck", token));
  assert.equal(response.cookies.get(SESSION_COOKIE), undefined);
});

test("signed out, a screen sends you to sign in and remembers where you were", async () => {
  const response = await middleware(requestFor("/inbox?org=zipicka"));
  const location = new URL(response.headers.get("location"));
  assert.equal(location.pathname, "/");
  assert.equal(location.hash, "#signin");
  assert.equal(location.searchParams.get("next"), "/inbox?org=zipicka");
});

test("both sign-in forms send the switch, and the server reads it", () => {
  const landing = read("../app/landing.tsx");
  const submit = landing.slice(landing.indexOf("async function onSubmit"), landing.indexOf("async function onSubmit") + 2400);
  assert.match(submit, /remember/, "the staff form must send Keep me signed in");
  const admin = read("../app/admin/page.tsx");
  assert.match(admin, /remember/, "the admin form must offer Keep me signed in too");
  assert.match(admin, /Keep me signed in/);
  const route = read("../app/api/auth/login/route.ts");
  assert.match(route, /body\.remember/);
  assert.match(route, /sessionCookieOptions\(/);
});

test("the browser may save the access code, so a new device fills it in", () => {
  const landing = read("../app/landing.tsx");
  const field = landing.slice(landing.indexOf('id="pass"') - 40, landing.indexOf('id="pass"') + 500);
  assert.match(field, /autoComplete="current-password"/);
});
