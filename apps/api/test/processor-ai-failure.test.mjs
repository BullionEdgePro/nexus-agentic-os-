// Live behavioral test: does processInboundWebhookJob actually recover when
// the AI agent throws (simulating an Anthropic outage/bad key/rate limit)?
// Mocks every external dependency so this runs with zero real infra.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const calls = { sendWhatsAppText: [], insertOutboundMessage: [], setConversationHandoff: [], publishInboxEvent: [] };

mock.module("@nexus/db", {
  exports: {
    // The processor runs inside an explicit cross-tenant context, because a
    // WhatsApp message identifies its tenant only by phone number id. These
    // just run the body: what is under test is the reply pipeline, not the
    // database scoping, and swallowing the callback would silently skip it.
    withAllTenants: async (_reason, fn) => fn(),
    withTenant: async (_organizationId, fn) => fn(),
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
    recordConversationMetric: async () => {},
    setConversationHandoff: async (id, val) => { calls.setConversationHandoff.push({ id, val }); },
    findEmployeeForConversation: async () => null, // org-level tenant, no employee assigned
    // @nexus/leads imports getPool statically; a missing export fails at module
    // load, before any try/catch in the processor can intervene.
    getPool: () => ({ query: async () => ({ rows: [] }) }),
    // Switchboard. An empty business list means this number is NOT shared, so
    // routing short-circuits and these scenarios exercise the same path they
    // did before the switchboard existed. The rest are here because the
    // processor imports them statically — a missing export is a module-load
    // failure, which no try/catch inside the processor can catch.
    findOrganizationById: async () => null,
    findSharedNumberBusinesses: async () => [],
    getConversationRouting: async () => null,
    setConversationRouting: async () => {},
    recordTriagePrompt: async () => {},
  },
});

mock.module("@nexus/agents", {
  exports: {
    routeToEmployeeTwin: async () => ({
      config: { id: "agent-1" },
      respond: async () => { throw new Error("simulated Anthropic outage (401 invalid api key)"); },
    }),
    loadRecentHistory: async () => [],
    classifyBusiness: () => ({ kind: 'unknown' }),
    buildTriageMessage: () => 'which business?',
    resolveTriageReply: () => null,
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
  exports: { publishInboxEvent: async (event) => { calls.publishInboxEvent.push(event); } },
});

const { processInboundWebhookJob } = await import("../src/queue/processor.ts");

test("AI agent failure still delivers a fallback reply and escalates to human handoff", async () => {
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
              messages: [{ from: "971500000000", id: "wamid.X", timestamp: "1700000000", type: "text", text: { body: "hi" } }],
            },
          }],
        }],
      },
    },
  };

  await processInboundWebhookJob(job);

  assert.equal(calls.sendWhatsAppText.length, 1, "expected exactly one WhatsApp send (the fallback)");
  assert.match(calls.sendWhatsAppText[0].body, /looping in a specialist/i, "should send the fallback reply text");
  assert.equal(calls.insertOutboundMessage.length, 1, "fallback message should be recorded");
  assert.equal(calls.insertOutboundMessage[0].senderType, "system");
  assert.equal(calls.setConversationHandoff.length, 1, "should flag the conversation for human handoff");
  assert.equal(calls.setConversationHandoff[0].val, true);
  console.log("PASS: customer received exactly one fallback message and conversation was escalated");
});
