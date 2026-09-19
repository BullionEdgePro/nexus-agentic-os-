// Regression test for a real production incident: BullMQ rejects any custom
// jobId containing ":" (it's bull's own Redis-key separator — see the
// comment on INBOUND_WEBHOOK_QUEUE in queue.ts). The webhook handler used to
// build its dedup jobId as `entryId + ":" + messageId`, which silently
// dropped every single inbound WhatsApp message — the queue.add() call threw,
// the webhook still 200'd back to Meta (so Meta never retried), and no
// conversation ever reached the database. This slipped past every other test
// because they call processInboundWebhookJob() directly against an
// already-dequeued job, never exercising the real enqueue path. Only a live
// webhook delivery ever hit it. This test drives the actual POST handler.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const TEST_SECRET = "test-app-secret";
const calls = { add: [] };
const socialCalls = { add: [] };

mock.module(new URL("../src/config/env.ts", import.meta.url), {
  exports: {
    env: {
      nodeEnv: "test",
      apiPort: 8080,
      redisUrl: "redis://localhost:6379",
      webOrigin: "http://localhost:3000",
      metaAppSecret: TEST_SECRET,
      metaWebhookVerifyToken: "verify-token",
      metaAccessToken: "access-token",
      metaGraphApiVersion: "v21.0",
    },
  },
});

mock.module(new URL("../src/queue/queue.ts", import.meta.url), {
  exports: {
    getInboundWebhookQueue: () => ({
      add: async (name, data, opts) => {
        calls.add.push({ name, data, opts });
        return {};
      },
    }),
  },
});

// The FB/IG branch of the same handler enqueues onto a different queue; mock it
// here too, because this is the one file that imports the real POST handler (two
// files mocking it in the shared test process would collide via the ESM cache).
mock.module(new URL("../src/queue/social-inbound-queue.ts", import.meta.url), {
  exports: {
    getSocialInboundQueue: () => ({
      add: async (name, data, opts) => {
        socialCalls.add.push({ name, data, opts });
        return {};
      },
    }),
  },
});

const { whatsappWebhook } = await import("../src/webhook/whatsapp.ts");

test("inbound webhook jobId never contains ':' (BullMQ rejects custom ids with a colon)", async () => {
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "entry-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "1555", phone_number_id: "1283383404852750" },
              contacts: [{ profile: { name: "Test User" }, wa_id: "971500000000" }],
              messages: [
                {
                  from: "971500000000",
                  id: "wamid.TEST123",
                  timestamp: "1700000000",
                  type: "text",
                  text: { body: "hi" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const rawBody = JSON.stringify(payload);
  const signature = "sha256=" + createHmac("sha256", TEST_SECRET).update(rawBody, "utf8").digest("hex");

  const res = await whatsappWebhook.request("/", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signature },
    body: rawBody,
  });

  assert.equal(res.status, 200, "webhook should ack Meta with 200");
  assert.equal(calls.add.length, 1, "should have enqueued exactly one job");

  const jobId = calls.add[0].opts.jobId;
  assert.ok(jobId, "jobId should be set");
  assert.ok(!jobId.includes(":"), `jobId must not contain ':' (BullMQ rejects it) — got "${jobId}"`);
  assert.equal(jobId, "entry-1-wamid.TEST123");
  console.log("PASS: webhook jobId is BullMQ-safe (no colon) —", jobId);
});

// ONE APP, ONE WEBHOOK, THREE OBJECTS.
//
// The same URL and app secret deliver WhatsApp, Facebook Page ("page") and
// Instagram ("instagram") messages. A Page delivery carries `entry[].messaging`,
// not `entry[].changes`, so the WhatsApp router reads no phone_number_id and
// would silently drop it. These prove the handler branches: Page/IG go to the
// social queue with a BullMQ-safe jobId, WhatsApp stays on its own queue.
function signedPost(payload) {
  const rawBody = JSON.stringify(payload);
  const signature = "sha256=" + createHmac("sha256", TEST_SECRET).update(rawBody, "utf8").digest("hex");
  return whatsappWebhook.request("/", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signature },
    body: rawBody,
  });
}

test("a Facebook Page delivery is enqueued on the social queue, not the WhatsApp one", async () => {
  calls.add.length = 0;
  socialCalls.add.length = 0;
  const res = await signedPost({
    object: "page",
    entry: [
      { id: "PAGE_42", messaging: [{ sender: { id: "PSID_1" }, recipient: { id: "PAGE_42" }, message: { mid: "m_xyz", text: "hi" } }] },
    ],
  });
  assert.equal(res.status, 200, "must ack Meta with 200");
  assert.equal(socialCalls.add.length, 1, "should enqueue exactly one social job");
  assert.equal(calls.add.length, 0, "must NOT touch the WhatsApp queue");
  const jobId = socialCalls.add[0].opts.jobId;
  assert.ok(!jobId.includes(":"), `jobId must be BullMQ-safe — got "${jobId}"`);
  assert.equal(jobId, "PAGE_42-m_xyz");
  assert.equal(socialCalls.add[0].data.payload.object, "page", "the raw payload is carried for the processor to re-parse");
});

test("an Instagram delivery routes to the social queue the same way", async () => {
  calls.add.length = 0;
  socialCalls.add.length = 0;
  const res = await signedPost({
    object: "instagram",
    entry: [{ id: "IG_9", messaging: [{ sender: { id: "IGSID_1" }, recipient: { id: "IG_9" }, message: { mid: "ig_m", text: "yo" } }] }],
  });
  assert.equal(res.status, 200);
  assert.equal(socialCalls.add.length, 1);
  assert.equal(calls.add.length, 0);
});

test("a WhatsApp delivery is unaffected by the social branch", async () => {
  calls.add.length = 0;
  socialCalls.add.length = 0;
  const res = await signedPost({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "entry-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "1555", phone_number_id: "PNID_1" },
              contacts: [{ profile: { name: "T" }, wa_id: "971500000000" }],
              messages: [{ from: "971500000000", id: "wamid.B", timestamp: "1700000000", type: "text", text: { body: "hi" } }],
            },
          },
        ],
      },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(calls.add.length, 1, "WhatsApp still routes to its own queue");
  assert.equal(socialCalls.add.length, 0, "the social branch must not swallow WhatsApp");
});

test("an unsigned social delivery is refused before any queue", async () => {
  calls.add.length = 0;
  socialCalls.add.length = 0;
  const res = await whatsappWebhook.request("/", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=deadbeef" },
    body: JSON.stringify({ object: "page", entry: [] }),
  });
  assert.equal(res.status, 401, "a bad signature must be refused");
  assert.equal(socialCalls.add.length, 0);
});
