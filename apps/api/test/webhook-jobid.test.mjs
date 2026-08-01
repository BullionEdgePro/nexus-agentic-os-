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
