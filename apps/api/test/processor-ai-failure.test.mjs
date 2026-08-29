// Live behavioral test: does processInboundWebhookJob actually recover when
// the AI agent throws (simulating an Anthropic outage/bad key/rate limit)?
// Mocks every external dependency so this runs with zero real infra.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { classifyIntent } from "../../../packages/agents/src/intent.ts";


const calls = { sendWhatsAppText: [], insertOutboundMessage: [], setConversationHandoff: [], publishInboxEvent: [], recordConversationMetric: [] };

mock.module(new URL("../src/queue/conversation-lock.ts", import.meta.url), {
  namedExports: {
    // Runs the body straight through. The real lock reaches Redis, and ioredis
    // is configured with maxRetriesPerRequest: null — required by BullMQ so a
    // Redis outage cannot kill the worker — which means a call in a test
    // environment with no Redis RETRIES FOREVER. It does not fail, it hangs,
    // and the whole suite hangs with it. Found exactly that way.
    //
    // These tests are about what the reply path decides, not about who is
    // allowed to decide it at the same time. The lock has its own test.
    withConversationLock: async (_phoneNumberId, _contactWaId, fn) => fn(),
    ConversationBusyError: class ConversationBusyError extends Error {},
  },
});

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
    // Referral attribution (migration 074). Enumerated like everything else
    // here: the processor imports these, so omitting them is a module-load
    // failure rather than a wrong answer.
    //
    // No fixture in this file carries a `#via-` tag, so resolveReferrer returns
    // before either is called. They answer "nobody, nothing changed" so that a
    // fixture which DOES grow a tag takes the unattributed path rather than
    // inventing a colleague.
    findEmployeeByCode: async () => null,
    attributeConversation: async () => ({ recorded: false, claimed: false, conflictWith: null }),

    // Added when delivery receipts landed (migration 048). These mocks stub
    // @nexus/db by ENUMERATION, so an export the processor imports and this
    // object omits is a module-load failure rather than a wrong answer — which
    // is how it should be, and is why this line exists rather than a spread.
    //
    // Returns false: none of these fixtures involves a status webhook, and
    // "nothing moved" is the honest answer for a receipt that never arrived.
    recordDeliveryStatus: async () => false,
    // Added with migration 051. Every delivery receipt is now tried against
    // broadcast_recipients as well as messages, because a wamid belongs to one
    // table or the other and the handler cannot tell which without asking.
    // These mocks stub @nexus/db by ENUMERATION, so a missing export is a
    // module-load failure rather than a wrong answer.
    recordBroadcastDelivery: async () => false,
    // Returns TRUE, preserving what these fixtures were written to test.
    // Escalation now only pauses the agent when somebody can take over, and
    // these cases all assert the staffed behaviour. Flipping this to false
    // would silently change what they cover rather than extending it — the
    // empty-rota branch is covered by escalation-needs-a-destination.test.mjs.
    hasActiveEmployees: async () => true,
    // No prior campaign, which is every case these tests cover: they exercise
    // the reply path, not the switchboard's campaign-reply shortcut. Returning
    // null keeps routing exactly as it was before that shortcut existed.
    //
    // These mocks stub @nexus/db by ENUMERATION, so a new import in the
    // processor is a module-load failure here rather than a wrong answer —
    // which is how this stub came to be added at all.
    findRecentBroadcastSender: async () => null,
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

    // No business has written its own wording, which is the state every
    // business is actually in — so these tests exercise the platform defaults,
    // which is what they were written to assert. A test that returned a phrase
    // here would be asserting the override rather than the fallback.
    getActivePhrase: async () => null,

    // Widens the owner-scoped transaction to a business on the same number.
    // Running the body is the honest stub: what is under test is the reply
    // pipeline, not the scoping, and swallowing the callback would skip it.
    withServingTenant: async (_organizationId, fn) => fn(),

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
    // A first delivery: replayOf is null and wasAccountedFor is never reached.
    // Both are listed because the processor imports them, and this mock is the
    // declaration of everything it may use.
    wasAccountedFor: async () => true,
    recordInboundMessage: async () => ({
      conversationId: "conv-1", contactId: "contact-1", messageId: "msg-1",
      isHumanHandoff: false, aiPausedUntil: null,
    }),
    insertOutboundMessage: async (input) => { calls.insertOutboundMessage.push(input); return { id: "out-1", ...input, status: "sent", createdAt: "now" }; },
    insertEvaluation: async () => {},
    // RECORDED now, not swallowed. A model that throws used to jump past the
    // metric write entirely, so a failed reply left no row and the conversation
    // vanished from every denominator computed from that table — which is how
    // an AI resolution rate of 100% survived four fallback messages. Captured
    // here so the assertions below can read what was actually written.
    recordConversationMetric: async (input) => {
      calls.recordConversationMetric.push(input);
    },
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
    // Referral handover. Enumerated like the rest: the processor imports these
    // three, so an omission is a module-load failure rather than a wrong
    // answer. No fixture here carries a `#via-` tag, so findStaffTag returning
    // null is both accurate and the path these tests were written for.
    findStaffTag: () => null,
    personalHandoffLink: () => null,
    describeReferringColleague: () => "",

    // The REAL classifier, imported by path so it bypasses this very mock.
    // Stubbing it would have these tests assert against a classification no
    // customer message ever produces, and would hide the case that matters:
    // the reply path writing a NULL intent, which F5 cannot see.
    classifyIntent,
    // Memory is an enhancement on the reply path; these tests are about the
    // reply itself. Returning "no memory" is the honest default — a mock that
    // supplied one would test a code path the assertions do not check.
    recallContact: async () => null,
    describeOpenFollowUps: () => null,
    // The reply path asks this when nobody is on the rota. These fixtures mock
    // hasStaffOnShift to true, so it is never called — the stub exists because
    // this mock replaces the whole module and a missing name is an import
    // failure, not a quiet undefined.
    describeNobodyToEscalateTo: () => "",
    // These fixtures have no appointments, so the honest stub is "no note". A
    // mock that invented one would exercise a branch these assertions never
    // check and quietly change what the agent was asked.
    upcomingBookingsNote: async () => null,
    // No active procedure, which is the state every business is in today
    // and will be in for weeks: F10 needs 5 well-handled conversations of
    // one kind before it proposes anything, and a person must then switch
    // it on. A mock that supplied one would change what the agent was
    // asked in tests whose assertions are about the reply path itself —
    // the applied-procedure path is covered in procedural-memory.test.mjs.
    recallProcedure: async () => null,
    rememberContact: async () => ({ written: false }),
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

  // THE FAILURE IS NOW ON THE RECORD, which is the whole of migration 049.
  // This assertion would have failed for the entire life of the platform up to
  // 2026-08-17: the metric write sits near the end of the `try`, so a model
  // that threw jumped past it and this conversation left no row at all. Four
  // real fallbacks on 2026-08-01 are absent from the table for that reason,
  // which is how an AI resolution rate of 100% survived them.
  assert.equal(calls.recordConversationMetric.length, 1, "a failed reply must still be counted");
  const metric = calls.recordConversationMetric[0];

  // The customer got a worse answer, not no answer. Those are different rows.
  assert.equal(metric.replyOutcome, "fallback");

  // Not 'ai_agent'. A fallback is the agent saying it cannot answer, and
  // filing it as an AI resolution is the same lie the missing row told.
  assert.equal(metric.resolvedBy, "unresolved");

  // Zero is the true value here: the model produced nothing.
  assert.equal(metric.inputTokens, 0);
  assert.equal(metric.outputTokens, 0);

  // Still classified, from the text alone. Intent coverage feeds F5, F10 and
  // F11, so an outage used to quietly starve the three features that grow with
  // it — every failed reply contributed nothing.
  assert.ok(metric.intent, "a failed reply should still contribute its intent");

  console.log("PASS: customer received exactly one fallback message, escalated, and the failure was RECORDED");
});
