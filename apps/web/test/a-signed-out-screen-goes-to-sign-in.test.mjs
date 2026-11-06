/**
 * A screen whose sign-in has ended goes to sign in, and back (5 Nov 2026).
 *
 * Agents reported WhatsApp "always disconnecting". In the live logs, one day
 * held 510 refused live-feed reconnects and 264 refused unread-count polls:
 * tabs whose 12-hour sign-in had run out, retrying for hours. Their inbox
 * showed "Live updates paused -- reconnecting" and stopped showing customers'
 * messages, and nothing told them to sign in again.
 *
 * Now the API's refusal says the sign-in ended (or the person was removed), and
 * the screen takes them to sign in -- through sign-out, so a removed person's
 * still-signed cookie is cleared -- and back to where they were.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

// A browser tab on the inbox, recording where it is sent.
const sent = [];
globalThis.window = {
  location: {
    pathname: "/inbox",
    search: "?org=zipicka",
    assign: (to) => sent.push(to),
  },
  sessionStorage: { getItem: () => null },
};
const answers = [];
globalThis.fetch = async (url) => {
  answers.push(String(url));
  const next = replies.shift() ?? { status: 200, body: { ok: true } };
  return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
};
const replies = [];

const { getTeamUnread, sessionEnded, confirmStillSignedIn } = await import("../lib/api.ts");

test("only the guard's own refusal reads as a sign-in that ended", () => {
  assert.equal(sessionEnded(401, JSON.stringify({ error: "Unauthorized", signedOut: "ended" })), "ended");
  assert.equal(sessionEnded(401, JSON.stringify({ error: "Gone", signedOut: "removed" })), "removed");
  assert.equal(sessionEnded(401, JSON.stringify({ error: "Sign in to track what you have read." })), null);
  assert.equal(sessionEnded(403, JSON.stringify({ signedOut: "ended" })), null);
  assert.equal(sessionEnded(401, "not json"), null);
});

test("a refused poll sends the tab to sign in once, by way of sign-out, remembering the screen", async () => {
  replies.push({ status: 401, body: { error: "Unauthorized", signedOut: "ended" } });
  replies.push({ status: 401, body: { error: "Unauthorized", signedOut: "ended" } });
  await assert.rejects(getTeamUnread());
  await assert.rejects(getTeamUnread());
  assert.equal(sent.length, 1, "two refusals must not send the tab twice");
  const to = new URL(sent[0], "https://nexusagenticos.com");
  assert.equal(to.pathname, "/api/auth/logout");
  assert.equal(to.searchParams.get("next"), "/inbox?org=zipicka");
  assert.equal(to.searchParams.get("signed-out"), "ended");
});

test("a dropped live feed asks whether the sign-in still holds -- at most every 30 seconds", async () => {
  answers.length = 0;
  await confirmStillSignedIn();
  await confirmStillSignedIn();
  assert.equal(answers.filter((u) => u.endsWith("/api/me")).length, 1);
});

test("every live feed asks when it drops", () => {
  for (const hook of ["../lib/use-inbox-socket.ts", "../lib/use-team-socket.ts", "../app/assignment-alerts.tsx"]) {
    const source = read(hook);
    const onClose = source.slice(source.indexOf("onclose"), source.indexOf("onclose") + 600);
    assert.match(onClose, /confirmStillSignedIn\(\)/, `${hook} must check the sign-in when its feed drops`);
  }
});

test("sign-out passes the screen and the reason on to the sign-in -- only the console's own screens", async () => {
  const { GET } = await import("../app/api/auth/logout/route.ts");
  const kept = await GET(new NextRequest("https://nexusagenticos.com/api/auth/logout?next=%2Finbox%3Forg%3Dzipicka&signed-out=removed"));
  const location = kept.headers.get("location");
  assert.ok(location.startsWith("/?"), "the Location stays relative (see the route's own note)");
  const where = new URL(location, "https://nexusagenticos.com");
  assert.equal(where.searchParams.get("next"), "/inbox?org=zipicka");
  assert.equal(where.searchParams.get("signed-out"), "removed");
  assert.equal(where.hash, "#signin");

  const evil = await GET(new NextRequest("https://nexusagenticos.com/api/auth/logout?next=https%3A%2F%2Fevil.example&signed-out=ended"));
  assert.equal(new URL(evil.headers.get("location"), "https://x.test").searchParams.get("next"), null);

  const plain = await GET(new NextRequest("https://nexusagenticos.com/api/auth/logout"));
  assert.equal(plain.headers.get("location"), "/#signin", "an ordinary sign-out lands where it always did");
});

test("the sign-in page says why, and returns to the screen", () => {
  const landing = read("../app/landing.tsx");
  assert.match(landing, /signedOutReason\(window\.location\.search\)/);
  const submit = landing.slice(landing.indexOf("async function onSubmit"), landing.indexOf("async function onSubmit") + 2600);
  assert.match(submit, /returnPath\(search\)/);
});

test("signing in leaves no signed-out note in the address (review, 5 Nov 2026)", () => {
  // Left there, a staff member signing in on `/` kept "?signed-out=ended" in
  // their address, and the next time that tab's sign-in ended, the guard
  // against sending a tab twice read it and sent them nowhere.
  const landing = read("../app/landing.tsx");
  const submit = landing.slice(landing.indexOf("async function onSubmit"), landing.indexOf("async function onSubmit") + 2600);
  assert.match(submit, /if \(signedOutReason\(search\) \|\| returnPath\(search\)\) \{\s*window\.location\.replace\(returnPath\(search\) \?\? "\/"\);/);
});

test("an admin whose sign-in ended goes back too, by the admin sign-in", () => {
  // The staff form refuses admin credentials, so its link to the admin sign-in
  // carries where they were, and the admin sign-in honours it.
  const landing = read("../app/landing.tsx");
  assert.match(landing, /<a href=\{`\/admin\$\{adminQuery\}`\}>Administrator sign-in<\/a>/);
  const admin = read("../app/admin/page.tsx");
  assert.match(admin, /const next = returnPath\(window\.location\.search\);/);
  assert.match(admin, /window\.location\.replace\(next\)/);
});

test("a tab that stayed (a Leave-site prompt cancelled) may be sent again later", async () => {
  sent.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 0));
  const { readFileSync: r } = await import("node:fs");
  const api = r(new URL("../lib/api.ts", import.meta.url), "utf8");
  const leave = api.slice(api.indexOf("function leaveForSignIn"), api.indexOf("function leaveForSignIn") + 900);
  assert.match(leave, /setTimeout\(\(\) => \{\s*leaving = false;\s*\}, 10_000\)/);
});
