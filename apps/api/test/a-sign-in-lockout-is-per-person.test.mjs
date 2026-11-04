// A sign-in lockout is per person, not per platform (audit, 4 Nov 2026).
//
// Every sign-in reaches the API from the web container, server to server and
// back through Caddy -- so X-Forwarded-For was the server's own address for
// everyone. Ten wrong codes from anyone locked every admin and staff member out
// for fifteen minutes (and they were told their correct code "doesn't match"),
// while any real sign-in cleared the count an attacker was using. The web now
// passes the browser's address, signed with the secret both sides already
// share; the API keys the lockout on it, and ignores it when the signature does
// not check, so it cannot be forged from outside.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const SECRET = "probe-session-secret";
process.env.NEXUS_SESSION_SECRET = SECRET;
const { clientKey } = await import("../src/lib/login-throttle.ts");

const headers = (values) => ({ get: (name) => values[name.toLowerCase()] ?? null });
const sign = (ip) => createHmac("sha256", SECRET).update(`nexus-client-address:${ip}`).digest("hex");

test("a signed browser address from the web is the key", () => {
  const key = clientKey(
    headers({ "x-forwarded-for": "10.0.0.5", "x-nexus-client-address": "86.98.1.2", "x-nexus-client-signature": sign("86.98.1.2") })
  );
  assert.equal(key, "86.98.1.2");
});

test("a forged or unsigned address is ignored", () => {
  assert.equal(
    clientKey(headers({ "x-forwarded-for": "203.0.113.9", "x-nexus-client-address": "1.1.1.1", "x-nexus-client-signature": sign("2.2.2.2") })),
    "203.0.113.9"
  );
  assert.equal(clientKey(headers({ "x-forwarded-for": "203.0.113.9", "x-nexus-client-address": "1.1.1.1" })), "203.0.113.9");
  assert.equal(clientKey(headers({})), "internal");
});

test("the web signs the browser's address on both sign-in calls, and says so when it is locked out", () => {
  const route = readFileSync(new URL("../../web/app/api/auth/login/route.ts", import.meta.url), "utf8");
  const helper = readFileSync(new URL("../../web/lib/client-address.ts", import.meta.url), "utf8");
  assert.match(helper, /nexus-client-address:\$\{address\}/);
  assert.equal(route.match(/\.\.\.\(await clientAddressHeaders\(req\)\)/g)?.length, 2, "both the admin and the staff call carry it");
  assert.match(route, /response\.status === 429/);
  assert.match(route, /Too many sign-in attempts/);
});
