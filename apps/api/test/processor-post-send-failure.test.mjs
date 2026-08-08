// Scenario 2: the AI reply itself succeeds and is sent to the customer, but
// a bookkeeping write (insertOutboundMessage) fails right after. Must NOT
// send a second "looping in a specialist" message on top of a reply that
// already went through — just flag the conversation for human handoff.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const calls = { sendWhatsAppText: [], insertOutboundMessage: [], setConversationHandoff: [] };

mock.module("@nexus/db", {
  exports: {
    findOrganizationByPhoneNumberId: async () => ({
      id: "org-1", slug: "zipicka", name: "Zipicka",
      whatsappPhoneNumberId: "000000000000001", whatsappBusinessAccountId: "1", timezone: "Asia/Dubai", createdAt: "now",
    }),
    recordInboundMessage: async () => ({
      conversationId: "conv-1", contactId: "contact-1", messageId: "msg-1",
      isHumanHandoff: false, aiPausedUntil: null,
    }),
    insertOutboundMessage: async (input) => {
      calls.insertOutboundMessage.push(input);
      throw new Error("simulated DB write failure right after a successful send");
    },
    insertEvaluation: async () => {},
    recordConversationMetric: async () => {},
    setConversationHandoff: async (id, val) => { calls.setConversationHandoff.push({ id, val }); },
    findEmployeeForConversation: async () => null, // org-level tenant, no employee assigned
    // @nexus/leads imports getPool statically; a missing export fails at module
    // load, before any try/catch in the processor can intervene.
    getPool: () => ({ query: async () => ({ rows: [] }) }),
  },
});

mock.module("@nexus/agents", {
  exports: {
    routeToEmployeeTwin: async () => ({
      config: { id: "agent-1" },
      respond: async () => ({ text: "Sure — that item is in stock, want me to hold one for you?", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }),
    }),
    loadRecentHistory: async () => [],
  },
});

mock.module("@nexus/governance", {
  exports: {
    evaluateOutgoingMessage: async () => ({ piiFlagged: false, hallucinationRisk: "low" }),
    shouldEscalateReply: (evaluation, slug) =>
      evaluation.piiFlagged ||
      evaluation.hallucinationRisk === "high" ||
      (evaluation.hallucinationRisk === "medium" && (slug === "juris-prime-legal" || slug === "juris-prime")),
  },
});

mock.module(new URL("../src/lib/whatsapp-client.ts", import.meta.url), {
  exports: {
    sendWhatsAppText: async (phoneNumberId, to, body) => { calls.sendWhatsAppText.push({ phoneNumberId, to, body }); },
    sendWhatsAppTemplate: async () => {},
  },
});
mock.module(new URL("../src/lib/pubsub.ts", import.meta.url), {
  exports: { publishInboxEvent: async () => {} },
});

const { processInboundWebhookJob } = await import("../src/queue/processor.ts");

test("a bookkeeping failure after a successful send does not trigger a duplicate customer-facing message", async () => {
  const job = {
    data: {
      receivedAt: new Date().toISOString(),
      phoneNumberId: "000000000000001",
      payload: {
        object: "whatsapp_business_account",
        entry: [{
          id: "entry-1",
          changes: [{
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "1555", phone_number_id: "000000000000001" },
              contacts: [{ profile: { name: "Test User" }, wa_id: "971500000000" }],
              messages: [{ from: "971500000000", id: "wamid.Y", timestamp: "1700000000", type: "text", text: { body: "is this in stock?" } }],
            },
          }],
        }],
      },
    },
  };

  await processInboundWebhookJob(job);

  assert.equal(calls.sendWhatsAppText.length, 1, "expected exactly ONE WhatsApp send — the real reply, no duplicate fallback");
  assert.match(calls.sendWhatsAppText[0].body, /in stock/i, "the one message sent should be the real AI reply, not the fallback");
  assert.equal(calls.setConversationHandoff.length, 1, "should still flag the conversation for human handoff");
  assert.equal(calls.setConversationHandoff[0].val, true);
  console.log("PASS: exactly one message reached the customer (the real reply); no duplicate fallback was sent");
});
