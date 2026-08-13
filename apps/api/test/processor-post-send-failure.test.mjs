// Scenario 2: the AI reply itself succeeds and is sent to the customer, but
// a bookkeeping write (insertOutboundMessage) fails right after. Must NOT
// send a second "looping in a specialist" message on top of a reply that
// already went through — just flag the conversation for human handoff.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const calls = { sendWhatsAppText: [], insertOutboundMessage: [], setConversationHandoff: [] };

mock.module(new URL("../src/services/availability.ts", import.meta.url), {
  namedExports: {
    // Mirrors the hasActiveEmployees stub above: these tests were written
    // for a business that HAS somebody available, and the escalation path
    // now asks a presence-aware question instead of a rota one.
    hasStaffOnShift: async () => true,
  },
});

mock.module("@nexus/db", {
  exports: {
    // Returns TRUE, preserving what these fixtures were written to test.
    // Escalation now only pauses the agent when somebody can take over, and
    // these cases all assert the staffed behaviour. Flipping this to false
    // would silently change what they cover rather than extending it — the
    // empty-rota branch is covered by escalation-needs-a-destination.test.mjs.
    hasActiveEmployees: async () => true,
    // Needed by src/services/availability.ts, which the processor now imports.
    // These mocks stub @nexus/db by enumeration, so a missing export is a
    // module-load failure rather than a wrong answer.
    listEmployees: async () => [],
    withTenant: async (_org, fn) => fn(),

    // Added when follow-ups joined the reply path. These fixtures have no
    // outstanding promises, so the honest stub is an empty list — a mock that
    // invented one would exercise a branch these assertions never check, and
    // quietly change what the agent was asked.
    listOpenTasksForContact: async () => [],

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
    // Memory is an enhancement on the reply path; these tests are about the
    // reply itself. Returning "no memory" is the honest default — a mock that
    // supplied one would test a code path the assertions do not check.
    recallContact: async () => null,
    describeOpenFollowUps: () => null,
    rememberContact: async () => ({ written: false }),
    routeToEmployeeTwin: async () => ({
      config: { id: "agent-1" },
      respond: async () => ({ text: "Sure — that item is in stock, want me to hold one for you?", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }),
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
