// A phone belongs to its person (phone push, 4 Nov 2026; mobile plan Task 10).
//
// Push alerts were half built: the dispatcher decided who to tell and the
// service worker could show an alert, but nothing ever registered a device, so
// every alert went to nobody. These routes let a signed-in person register their
// phone, choose what it hears, send it a test, and remove it -- their own
// devices only, whoever the body claims to be.
//
// Runs through requireAuth and the request middleware as production does,
// against the throwaway Postgres; only the push service itself is stood in.
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const ORG = "9c9c9c9c-0000-4000-8000-000000000001";
const STAFF = "9c9c9c9c-0000-4000-8000-0000000000e1";
const COLLEAGUE = "9c9c9c9c-0000-4000-8000-0000000000e2";
const ADMIN = "9c9c9c9c-0000-4000-8000-0000000000a1";
process.env.NEXUS_SESSION_SECRET = "probe-session-secret";
process.env.VAPID_PUBLIC_KEY = "BProbePublicKey";
process.env.VAPID_PRIVATE_KEY = "probe-private";
process.env.VAPID_SUBJECT = "mailto:probe@localhost.test";

let configured = true;
const sent = [];
mock.module(new URL("../src/lib/web-push.ts", import.meta.url).href, {
  namedExports: {
    pushConfigured: () => configured,
    sendPush: async (sub, payload) => {
      sent.push({ endpoint: sub.endpoint, payload });
      return "ok";
    },
    buildMessagePayload: () => ({ title: "", body: "", tag: "", url: "/" }),
    buildPlatformPayload: () => ({ title: "", body: "", tag: "", url: "/" }),
  },
});

let owner;
let dbTurn;
let lib;
let app;
let tokens;

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
     values ($1, 'push-org', 'Push Org', '9c0901', '8c0901', 'Asia/Dubai')`,
    [ORG]
  );
  await owner.query(
    `insert into employees (id, organization_id, employee_code, full_name, is_active)
     values ($1, $3, 'PSH1', 'Phone Owner', true), ($2, $3, 'PSH2', 'Colleague', true)`,
    [STAFF, COLLEAGUE, ORG]
  );
  await owner.query(`insert into admins (id, email, full_name, password_hash, is_active) values ($1, 'push-admin@localhost.test', 'Push Admin', 'x', true)`, [
    ADMIN,
  ]);
  process.env.DATABASE_URL = APP_URL;
  lib = await import("@nexus/db");
  const { signSession } = await import("../../web/lib/auth.ts");
  const employeeSession = (employeeId) =>
    signSession(`${employeeId}@localhost.test`, { role: "employee", employeeId, organizationId: ORG, organizationSlug: "push-org" });
  tokens = {
    staff: await employeeSession(STAFF),
    colleague: await employeeSession(COLLEAGUE),
    admin: await signSession("push-admin@localhost.test", { role: "operator", adminId: ADMIN }),
  };
  const { Hono } = await import("hono");
  const { requireAuth } = await import("../src/middleware/require-auth.ts");
  const { tenantContext } = await import("../src/middleware/tenant-context.ts");
  const { pushRoute } = await import("../src/routes/push.ts");
  app = new Hono();
  app.use("/api/*", requireAuth);
  app.use("/api/*", tenantContext);
  app.route("/api/me/push", pushRoute);
});

after(async () => {
  if (db.skip) return;
  try {
    await owner.query(`delete from push_subscriptions where subject in ($1, $2, $3)`, [`e:${STAFF}`, `e:${COLLEAGUE}`, `o:${ADMIN}`]);
    await owner.query(`delete from admins where id = $1`, [ADMIN]);
    await owner.query(`delete from employees where organization_id = $1`, [ORG]);
    await owner.query(`delete from organizations where id = $1`, [ORG]);
  } finally {
    if (dbTurn) {
      await dbTurn.query("select pg_advisory_unlock(20261102)");
      dbTurn.release();
    }
    await owner?.end();
    await lib?.getPool().end();
  }
});

const call = async (who, method, path, body) => {
  const response = await app.request(`/api/me/push${path}`, {
    method,
    headers: { cookie: `nexus_session=${tokens[who]}`, "content-type": "application/json", "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};
const device = (n) => ({ endpoint: `https://push.example.test/${n}`, keys: { p256dh: `p256-${n}`, auth: `auth-${n}` } });

test("the page learns whether alerts are on and the key a phone subscribes with", db, async () => {
  const { status, body } = await call("staff", "GET", "");
  assert.equal(status, 200);
  assert.equal(body.configured, true);
  assert.equal(body.publicKey, "BProbePublicKey");
  assert.deepEqual(body.devices, []);
});

test("a phone is registered to the person signed in, whoever the body names", db, async () => {
  const { status, body } = await call("staff", "POST", "", { ...device(1), label: "iPhone", subject: `e:${COLLEAGUE}`, employeeId: COLLEAGUE });
  assert.equal(status, 200);
  assert.equal(body.device.subject, `e:${STAFF}`);
  assert.equal(body.device.organizationId, ORG);
  assert.equal(body.device.label, "iPhone");
  assert.equal(body.device.mode, "mine");
  assert.equal(body.device.previews, false, "message text stays off until the person turns it on");
  const mine = await call("staff", "GET", "");
  assert.equal(mine.body.devices.length, 1);
  assert.equal(mine.body.devices[0].endpoint, undefined, "the push address is not sent back to the page");
  assert.equal((await call("colleague", "GET", "")).body.devices.length, 0, "a colleague sees none of it");
});

test("a registration with no address or keys is refused", db, async () => {
  assert.equal((await call("staff", "POST", "", { endpoint: "https://push.example.test/x" })).status, 400);
  assert.equal((await call("staff", "POST", "", { ...device(2), endpoint: "not-a-url" })).status, 400);
});

test("only its person changes, tests or removes a phone", db, async () => {
  const id = (await call("staff", "GET", "")).body.devices[0].id;
  assert.equal((await call("colleague", "PATCH", `/${id}`, { previews: true })).status, 404);
  assert.equal((await call("colleague", "POST", `/${id}/test`)).status, 404);
  assert.equal((await call("colleague", "DELETE", `/${id}`)).status, 404);
  const changed = await call("staff", "PATCH", `/${id}`, { previews: true, mode: "paused" });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.device.previews, true);
  assert.equal(changed.body.device.mode, "paused");
});

test("a choice that is not one is refused, and 'every new chat' is the admins' alone", db, async () => {
  const id = (await call("staff", "GET", "")).body.devices[0].id;
  assert.equal((await call("staff", "PATCH", `/${id}`, { mode: "loud" })).status, 400);
  const staffAll = await call("staff", "PATCH", `/${id}`, { mode: "all" });
  assert.equal(staffAll.status, 400, "a staff member cannot open unassigned chats, so cannot ask to hear them");
  await call("admin", "POST", "", { ...device(3), label: "This computer" });
  const adminId = (await call("admin", "GET", "")).body.devices[0].id;
  const adminAll = await call("admin", "PATCH", `/${adminId}`, { mode: "all" });
  assert.equal(adminAll.status, 200);
  assert.equal(adminAll.body.device.mode, "all");
});

test("a test alert goes to that phone only, and says so when the server has no keys", db, async () => {
  const id = (await call("staff", "GET", "")).body.devices[0].id;
  sent.length = 0;
  const ok = await call("staff", "POST", `/${id}/test`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.outcome, "ok");
  assert.deepEqual(sent.map((s) => s.endpoint), ["https://push.example.test/1"]);
  configured = false;
  try {
    const off = await call("staff", "POST", `/${id}/test`);
    assert.equal(off.status, 503);
    assert.equal(off.body.error, "Notifications aren't enabled on this server yet.");
  } finally {
    configured = true;
  }
});

test("removing a phone stops it", db, async () => {
  const id = (await call("staff", "GET", "")).body.devices[0].id;
  assert.equal((await call("staff", "DELETE", `/${id}`)).status, 200);
  assert.equal((await call("staff", "GET", "")).body.devices.length, 0);
});

test("the route sits before /api/me, so /api/me does not swallow it", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const push = index.indexOf('app.route("/api/me/push", pushRoute);');
  assert.ok(push > 0, "the route is mounted");
  assert.ok(push < index.indexOf('app.route("/api/me", meRoute);'), "before /api/me");
});
