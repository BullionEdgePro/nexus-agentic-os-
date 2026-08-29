// Scenario 3 (regression check): the plain happy path — no failures anywhere
// — must still behave exactly as before the reliability refactor.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { classifyIntent } from "../../../packages/agents/src/intent.ts";


const calls = { sendWhatsAppText: [], insertOutboundMessage: [], setConversationHandoff: [], recordConversationMetric: [] };

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
    // Opt-out writer. Never reached while looksLikeAnOptOut returns false, but
    // the import must resolve.
    optOutOfReengagement: async () => true,

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
    recordConversationMetric: async (input) => { calls.recordConversationMetric.push(input); },
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
    // Opt-out. Enumerated like the rest: the processor imports these, so an
    // omission is a module-load failure rather than a wrong answer. No fixture
    // in these files sends "stop", so returning false is both accurate and the
    // path they were written for.
    looksLikeAnOptOut: () => false,
    optOutConfirmation: () => "",

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
      respond: async () => ({ text: "Yes, we have that in stock!", toolCalls: [], usage: { inputTokens: 12, outputTokens: 7 } }),
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
