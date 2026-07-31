// Scenario 3 (regression check): the plain happy path — no failures anywhere
// — must still behave exactly as before the reliability refactor.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const calls = { sendWhatsAppText: [], insertOutboundMessage: [], setConversationHandoff: [], recordConversationMetric: [] };

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
    insertOutboundMessage: async (input) => { calls.insertOutboundMessage.push(input); return { id: "out-1", ...input, status: "sent", createdAt: "now" }; },
    insertEvaluation: async () => {},
    recordConversationMetric: async (input) => { calls.recordConversationMetric.push(input); },
    setConversationHandoff: async (id, val) => { calls.setConversationHandoff.push({ id, val }); },
  },
});

mock.module("@nexus/agents", {
  exports: {
    routeToDomainAgent: async () => ({
      config: { id: "agent-1" },
      respond: async () => ({ text: "Yes, we have that in stock!", toolCalls: [], usage: { inputTokens: 12, outputTokens: 7 } }),
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

test("happy path: no failures anywhere — real reply sent once, no escalation", async () => {
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
              messages: [{ from: "971500000000", id: "wamid.Z", timestamp: "1700000000", type: "text", text: { body: "is this in stock?" } }],
            },
          }],
        }],
      },
    },
  };

  await processInboundWebhookJob(job);

  assert.equal(calls.sendWhatsAppText.length, 1);
  assert.match(calls.sendWhatsAppText[0].body, /in stock/i);
  assert.equal(calls.insertOutboundMessage[0].senderType, "ai_agent");
  assert.equal(calls.insertOutboundMessage[0].senderId, "agent-1");
  assert.equal(calls.setConversationHandoff.length, 0, "no escalation should happen on the happy path");
  assert.equal(calls.recordConversationMetric.length, 1, "exactly one analytics row should be recorded");
  assert.equal(calls.recordConversationMetric[0].resolvedBy, "ai_agent", "AI resolved it, no escalation");
  assert.equal(calls.recordConversationMetric[0].inputTokens, 12, "token usage should be persisted, not discarded");
  assert.equal(calls.recordConversationMetric[0].outputTokens, 7);
  console.log("PASS: happy path unchanged — one real reply sent, no escalation, analytics recorded");
});
