// A screen whose sign-in has ended is told so (5 Nov 2026).
//
// The refusal was a bare "Unauthorized", the same word other routes use for
// other things, so a screen could not tell "your sign-in ended" from any other
// 401 -- and an agent's inbox sat on "Live updates paused -- reconnecting"
// for hours (510 refused reconnects and 264 refused polls in one working day).
// The guard now says which it is, and the browser acts only on that: "ended"
// (no sign-in, or one that ran out) or "removed" (the person no longer works
// here; asserted in a-removed-person-is-signed-out-at-once.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXUS_SESSION_SECRET = "probe-session-secret";

const { Hono } = await import("hono");
const { requireAuth } = await import("../src/middleware/require-auth.ts");
const app = new Hono();
app.use("/api/*", requireAuth);
app.get("/api/probe", (c) => c.json({ ok: true }));

test("no sign-in: refused, and told the sign-in has ended", async () => {
  const response = await app.request("/api/probe");
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized", signedOut: "ended" });
});

test("a sign-in that ran out: the same", async () => {
  const { signSession } = await import("../../web/lib/auth.ts");
  const stale = await signSession("agent@localhost.test", { role: "operator" }, { now: Date.now() - 13 * 60 * 60 * 1000 });
  const response = await app.request("/api/probe", { headers: { cookie: `nexus_session=${stale}` } });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).signedOut, "ended");
});
