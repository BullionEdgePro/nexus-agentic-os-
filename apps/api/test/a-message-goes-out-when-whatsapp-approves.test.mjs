// An admin's own message goes out when WhatsApp approves it (3 Nov 2026).
//
// A message for customers who have not written in 24 hours must be an approved
// template, and Meta takes minutes to a day to approve one. Until now the admin
// wrote it, sent it for approval, came back later, picked it and sent it --
// nothing on the server acted on an approval. A campaign can now wait as
// `scheduled` for its message: released to send when the template is approved
// (after each template sync, and on "Check again"), failed when it is rejected,
// and never sent by a job while it still waits.
// Takes its turn at the shared test database; the send queue and Meta are stood in.
// Spec: docs/superpowers/specs/2026-11-03-bulk-own-message-design.md
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const ORG = "93939393-0000-4000-8000-000000000001";
const NUMBER = "960001";
const CONTACTS = [
  { id: "93939393-0000-4000-8000-0000000000a1", waId: "971596000101", name: "Sara Khan" },
  { id: "93939393-0000-4000-8000-0000000000a2", waId: "971596000102", name: "Omar" },
];

let owner;
let dbTurn;
let control;
const queued = [];
/** Set to make the queue refuse some jobs, as Redis going away half-way would. */
let failAdd = null;
/** What the number's readiness check answers; null is "ready to send". */
let refusal = null;

// The send queue lives in Redis, which a test database run has none of.
mock.module(new URL("../src/queue/broadcast-queue.ts", import.meta.url).href, {
  namedExports: {
    BROADCAST_SEND_QUEUE: "whatsapp-broadcast-send",
    getBroadcastSendQueue: () => ({
      add: async (_name, data) => {
        if (failAdd?.(data)) throw new Error("Redis is not answering");
        queued.push(data);
      },
    }),
  },
});
// The readiness check asks Meta about the number.
mock.module(new URL("../src/lib/sending-refusal.ts", import.meta.url).href, {
  namedExports: { sendingRefusal: async () => refusal },
});
mock.module(new URL("../src/queue/email-broadcast-queue.ts", import.meta.url).href, {
  namedExports: {
    EMAIL_BROADCAST_QUEUE: "email-broadcast-send",
    getEmailBroadcastQueue: () => ({ addBulk: async () => undefined }),
  },
});

const template = async (name, status) =>
  (
    await owner.query(
      `insert into message_templates (organization_id, meta_template_name, language, status, is_approved, body_param_count)
       values ($1, $2, 'en', $3, $4, 1) returning id`,
      [ORG, name, status, status === "APPROVED"]
    )
  ).rows[0].id;

const waitingCampaign = async (templateId) => {
  const id = (
    await owner.query(
      `insert into broadcasts (organization_id, template_id, status, from_phone_number_id, audience_filter)
       values ($1, $2, 'scheduled', $3, '{"scope":"admin-bulk"}') returning id`,
      [ORG, templateId, NUMBER]
    )
  ).rows[0].id;
  for (const contact of CONTACTS) {
    await owner.query(`insert into broadcast_recipients (broadcast_id, contact_id, status) values ($1, $2, 'pending')`, [id, contact.id]);
  }
  return id;
};
const statusOf = async (id) => (await owner.query(`select status from broadcasts where id = $1`, [id])).rows[0].status;
const approvedCampaign = async (name) => {
  const id = await template(name, "PENDING");
  const campaign = await waitingCampaign(id);
  await owner.query(`update message_templates set status = 'APPROVED', is_approved = true where id = $1`, [id]);
  return campaign;
};
const jobsFor = (campaign) => queued.filter((job) => job.broadcastId === campaign);

/** Run send jobs as the worker would, with Meta stood in; returns who was messaged. */
const runJobs = async (jobs) => {
  const { processBroadcastSendJob } = await import("../src/queue/broadcast-processor.ts");
  const sentTo = [];
  const realFetch = globalThis.fetch;
  const realToken = process.env.META_ACCESS_TOKEN;
  process.env.META_ACCESS_TOKEN = "probe-token-never-sent"; // fetch is replaced below
  globalThis.fetch = async (_url, init) => {
    sentTo.push(JSON.parse(init.body).to);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.gwa.${Date.now()}.${sentTo.length}` }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    for (const data of jobs) await processBroadcastSendJob({ data, opts: { attempts: 3 }, attemptsMade: 0 });
  } finally {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.META_ACCESS_TOKEN;
    else process.env.META_ACCESS_TOKEN = realToken;
  }
  return sentTo;
};

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone, is_number_owner)
     values ($1, 'gwa-org', 'Probe Shop', $2, '860001', 'Asia/Dubai', true)`,
    [ORG, NUMBER]
  );
  for (const contact of CONTACTS) {
    await owner.query(`insert into contacts (id, organization_id, wa_id, channel, display_name) values ($1, $2, $3, 'whatsapp', $4)`, [
      contact.id,
      ORG,
      contact.waId,
      contact.name,
    ]);
  }
  process.env.DATABASE_URL = APP_URL;
  control = await import("../src/services/campaign-control.ts");
});

after(async () => {
  if (db.skip) return;
  try {
    await owner.query(`delete from broadcast_recipients where broadcast_id in (select id from broadcasts where organization_id = $1)`, [ORG]);
    await owner.query(`delete from broadcasts where organization_id = $1`, [ORG]);
    await owner.query(`delete from message_templates where organization_id = $1`, [ORG]);
    await owner.query(`delete from organizations where id = $1`, [ORG]);
  } finally {
    if (dbTurn) {
      await dbTurn.query("select pg_advisory_unlock(20261102)");
      dbTurn.release();
    }
    await owner?.end();
    const lib = await import("@nexus/db").catch(() => null);
    if (lib) await lib.getPool().end();
  }
});

test("a campaign waits while WhatsApp is still reviewing its message", db, async () => {
  const pendingTemplate = await template("bulk_zp_probe_wait", "PENDING");
  const campaign = await waitingCampaign(pendingTemplate);
  queued.length = 0;
  await control.releaseApprovedCampaigns(ORG);
  assert.equal(await statusOf(campaign), "scheduled");
  assert.equal(queued.length, 0, "a message went out before WhatsApp approved it");
  await owner.query(`delete from broadcast_recipients where broadcast_id = $1`, [campaign]);
  await owner.query(`delete from broadcasts where id = $1`, [campaign]);
});

test("approved, it goes to every chosen customer once, even when released twice", db, async () => {
  const approved = await template("bulk_zp_probe_go", "PENDING");
  const campaign = await waitingCampaign(approved);
  await owner.query(`update message_templates set status = 'APPROVED', is_approved = true where id = $1`, [approved]);
  queued.length = 0;
  const result = await control.releaseApprovedCampaigns(ORG);
  assert.equal(await statusOf(campaign), "sending");
  assert.equal(queued.length, 2, "not every chosen customer was queued");
  // Check again tells the admin it is going, and to how many.
  assert.deepEqual(
    result.released.find((released) => released.broadcastId === campaign),
    { broadcastId: campaign, templateId: approved, recipients: 2 }
  );
  const sara = queued.find((job) => job.contactWaId === "971596000101");
  assert.deepEqual(
    { phoneNumberId: sara.phoneNumberId, templateName: sara.templateName, templateLanguage: sara.templateLanguage, templateParams: sara.templateParams },
    { phoneNumberId: NUMBER, templateName: "bulk_zp_probe_go", templateLanguage: "en", templateParams: ["Sara"] }
  );
  await control.releaseApprovedCampaigns(ORG);
  assert.equal(queued.length, 2, "a second release sent the message again");
});

test("rejected, the campaign fails instead of waiting for ever", db, async () => {
  const rejected = await template("bulk_zp_probe_no", "REJECTED");
  const campaign = await waitingCampaign(rejected);
  queued.length = 0;
  await control.releaseApprovedCampaigns(ORG);
  assert.equal(await statusOf(campaign), "failed");
  assert.equal(queued.length, 0);
});

test("a send job for a campaign still waiting sends nothing and is tried again", db, async () => {
  const { processBroadcastSendJob } = await import("../src/queue/broadcast-processor.ts");
  const waiting = await template("bulk_zp_probe_job", "PENDING");
  const campaign = await waitingCampaign(waiting);
  const recipient = (await owner.query(`select id from broadcast_recipients where broadcast_id = $1 limit 1`, [campaign])).rows[0].id;
  const sends = [];
  const realFetch = globalThis.fetch;
  const realToken = process.env.META_ACCESS_TOKEN;
  process.env.META_ACCESS_TOKEN = "probe-token-never-sent"; // fetch is replaced below
  globalThis.fetch = async (url) => {
    sends.push(String(url));
    return new Response(JSON.stringify({ messages: [{ id: "wamid.gwa" }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  let outcome;
  try {
    outcome = await processBroadcastSendJob({
      data: {
        broadcastId: campaign,
        recipientId: recipient,
        contactWaId: CONTACTS[0].waId,
        phoneNumberId: NUMBER,
        templateName: "bulk_zp_probe_job",
        templateLanguage: "en",
        templateParams: ["Sara"],
      },
      opts: { attempts: 3 },
      attemptsMade: 0,
    }).then(() => "finished", (err) => err.message);
  } finally {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.META_ACCESS_TOKEN;
    else process.env.META_ACCESS_TOKEN = realToken;
  }
  assert.deepEqual(sends, [], "a customer was messaged while the campaign was still waiting for approval");
  assert.match(outcome, /waiting for WhatsApp/);
});

test("an approval is acted on after every template sync and on Check again", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const read = (...p) => readFileSync(join(root, ...p), "utf8");
  const sync = read("apps", "api", "src", "services", "template-sync.ts");
  const syncAll = sync.slice(sync.indexOf("export async function syncAllTemplates"));
  assert.match(syncAll.slice(0, syncAll.indexOf("\n}\n") + 3), /releaseApprovedCampaigns\(organization\.id\)/);
  const routes = read("apps", "api", "src", "routes", "admin-bulk-templates.ts");
  const refresh = routes.slice(routes.indexOf("/templates/refresh"));
  assert.match(refresh, /releaseApprovedCampaigns\(organization\.id\)/);
  // Last before the answer (review, 3 Nov 2026): the jobs it queues wait for
  // the request to commit, so nothing slow may run between the two -- WhatsApp's
  // review reasons took long enough for the jobs to use up their tries.
  const release = refresh.indexOf("releaseApprovedCampaigns(");
  for (const slow of ["readTemplateReviews(", "listBroadcastTemplates(", "templatesFor("]) {
    assert.ok(refresh.indexOf(slow) > -1 && refresh.indexOf(slow) < release, `${slow} runs after the release`);
  }
  assert.match(refresh, /released: release\?\.released \?\? \[\], held: release\?\.held \?\? \[\]/);
});

test("someone who replied STOP while it waited is not messaged when it goes out", db, async () => {
  const campaign = await approvedCampaign("bulk_zp_probe_stop");
  await owner.query(`update contacts set reengagement_opted_out = true where id = $1`, [CONTACTS[1].id]);
  try {
    queued.length = 0;
    await control.releaseApprovedCampaigns(ORG);
    const sentTo = await runJobs(jobsFor(campaign));
    assert.deepEqual(sentTo, [CONTACTS[0].waId], "a customer who asked not to be messaged was messaged");
    const omar = (
      await owner.query(`select status, delivery_error from broadcast_recipients where broadcast_id = $1 and contact_id = $2`, [
        campaign,
        CONTACTS[1].id,
      ])
    ).rows[0];
    assert.equal(omar.status, "failed");
    assert.match(omar.delivery_error, /asked not to be messaged/i);
    // Settled, not left pending: the campaign still finishes.
    assert.equal(await statusOf(campaign), "completed");
  } finally {
    await owner.query(`update contacts set reengagement_opted_out = false where id = $1`, [CONTACTS[1].id]);
  }
});

test("a release the queue half-refused waits again, and the retry messages each customer once", db, async () => {
  const campaign = await approvedCampaign("bulk_zp_probe_half");
  queued.length = 0;
  failAdd = (job) => job.contactWaId === CONTACTS[1].waId;
  try {
    await control.releaseApprovedCampaigns(ORG);
  } finally {
    failAdd = null;
  }
  assert.equal(await statusOf(campaign), "scheduled", "a campaign half-queued was left Sending with customers never queued");
  await control.releaseApprovedCampaigns(ORG);
  assert.equal(await statusOf(campaign), "sending");
  // Sara was queued by both releases; she is still messaged once.
  const sentTo = await runJobs(jobsFor(campaign));
  assert.deepEqual(sentTo.sort(), CONTACTS.map((contact) => contact.waId).sort());
});

test("a send job for someone already messaged sends nothing", db, async () => {
  const campaign = await approvedCampaign("bulk_zp_probe_twice");
  queued.length = 0;
  await control.releaseApprovedCampaigns(ORG);
  const jobs = jobsFor(campaign);
  assert.equal((await runJobs(jobs)).length, 2);
  assert.deepEqual(await runJobs(jobs), [], "a job run a second time messaged the customer again");
});

test("a number WhatsApp is blocking holds the campaign, with the reason, until it can send", db, async () => {
  const campaign = await approvedCampaign("bulk_zp_probe_held");
  queued.length = 0;
  refusal = "WhatsApp is blocking this number: probe";
  let result;
  try {
    result = await control.releaseApprovedCampaigns(ORG);
  } finally {
    refusal = null;
  }
  assert.equal(await statusOf(campaign), "scheduled");
  assert.equal(jobsFor(campaign).length, 0, "a campaign went out from a number WhatsApp is blocking");
  assert.equal(result.held.find((held) => held.broadcastId === campaign)?.reason, "WhatsApp is blocking this number: probe");
  await control.releaseApprovedCampaigns(ORG);
  assert.equal(await statusOf(campaign), "sending");
  assert.equal(jobsFor(campaign).length, 2);
});

test("a customer's first blank is their first name, on every send", async () => {
  const { staffTemplateParams } = await import("../src/routes/my-campaigns.ts");
  assert.deepEqual(staffTemplateParams(2, "  Sara   Khan "), ["Sara", "-"]);
  assert.deepEqual(staffTemplateParams(1, null), ["there"]);
});

test("the customers ticked on the page wait for the message, and nothing goes out yet", db, async () => {
  const fresh = await template("bulk_zp_probe_new", "PENDING");
  queued.length = 0;
  const waiting = await control.createWaitingCampaign({
    organizationId: ORG,
    templateId: fresh,
    fromPhoneNumberId: NUMBER,
    numberOwnerEmployeeId: null,
    sentBy: "Probe Admin",
    contactIds: CONTACTS.map((contact) => contact.id),
  });
  assert.equal(waiting?.recipients, 2);
  assert.equal(await statusOf(waiting.broadcastId), "scheduled");
  const pending = await owner.query(`select count(*)::int as n from broadcast_recipients where broadcast_id = $1 and status = 'pending'`, [
    waiting.broadcastId,
  ]);
  assert.equal(pending.rows[0].n, 2);
  assert.equal(queued.length, 0, "a message went out before WhatsApp approved it");
});

test("the new-message route checks the number first, then makes the ticked customers wait", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const routes = readFileSync(join(root, "apps", "api", "src", "routes", "admin-bulk-templates.ts"), "utf8");
  const create = routes.slice(routes.indexOf('"/:slug/number/:phoneNumberId/templates"'), routes.indexOf("/templates/refresh"));
  assert.ok(create.indexOf("sendingRefusal(") > -1 && create.indexOf("sendingRefusal(") < create.indexOf("createMetaTemplate("), "the number is not checked before anything is created");
  assert.match(create, /createWaitingCampaign\(/);
  assert.match(create, /return c\.json\(\{ name, status: created\.status \?\? "PENDING", waiting \}\)/);
});
