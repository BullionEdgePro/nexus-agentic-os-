// The switchboard, wired into the real processor.
//
// business-router.test.mjs proves the classifier is correct in isolation. This
// proves the pipeline actually USES it — that the routed tenant, not the tenant
// that owns the phone number, selects the agent, the knowledge scope and the
// governance policy. Those three are the whole reason routing exists; a
// classifier nothing calls is decoration.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { classifyIntent } from "../../../packages/agents/src/intent.ts";


// Imported before the mocks are installed, so these are the REAL implementations
// and the scenarios below exercise genuine classification rather than a stub
// agreeing with itself.
import { classifyBusiness, buildTriageMessage, resolveTriageReply } from "@nexus/agents";

const ORGS = {
  "org-zip": { id: "org-zip", slug: "zipicka", name: "Zipicka" },
  "org-legal": { id: "org-legal", slug: "juris-prime-legal", name: "Juris Prime Legal" },
  "org-sfs": { id: "org-sfs", slug: "sfs-international", name: "SFS International" },
};

const BUSINESSES = [
  { id: "org-zip", slug: "zipicka", name: "Zipicka", routingKeywords: ["shop", "product", "beauty", "order"] },
  { id: "org-legal", slug: "juris-prime-legal", name: "Juris Prime Legal", routingKeywords: ["lawyer", "court", "case", "lawsuit"] },
  { id: "org-sfs", slug: "sfs-international", name: "SFS International", routingKeywords: ["property", "rent", "villa"] },
];

const SHARED_NUMBER = "000000000000001";

// Rebuilt before each scenario.
let calls;
let routingState;
let hallucinationRisk;

function reset({ state = null, risk = "low" } = {}) {
  calls = {
    sent: [],
    outbound: [],
    routed: [],
    triagePrompts: 0,
    agentTenants: [],
    respondOrgIds: [],
    governanceSlugs: [],
    handoffs: [],
  };
  routingState = state;
  hallucinationRisk = risk;
}
reset();

const org = (id) => ({
  ...ORGS[id],
  whatsappPhoneNumberId: SHARED_NUMBER,
  whatsappBusinessAccountId: "1",
  timezone: "Asia/Dubai",
  createdAt: "now",
});

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
    // Zipicka owns the number; contacts and conversations stay under it.
    findOrganizationByPhoneNumberId: async () => org("org-zip"),
    findOrganizationById: async (id) => (ORGS[id] ? org(id) : null),
    findSharedNumberBusinesses: async () => BUSINESSES,
    getConversationRouting: async () => routingState,
    setConversationRouting: async (conversationId, organizationId) => {
      calls.routed.push({ conversationId, organizationId });
    },
    recordTriagePrompt: async () => {
      calls.triagePrompts += 1;
    },
    recordInboundMessage: async () => ({
      conversationId: "conv-1",
      contactId: "contact-1",
      messageId: "msg-1",
      isHumanHandoff: false,
      aiPausedUntil: null,
    }),
    insertOutboundMessage: async (input) => {
      calls.outbound.push(input);
      return { id: "out-1", ...input, status: "sent", createdAt: "now" };
    },
    insertEvaluation: async () => {},
    recordConversationMetric: async () => {},
    setConversationHandoff: async (id, val) => calls.handoffs.push({ id, val }),
    findEmployeeForConversation: async () => null,
    getPool: () => ({ query: async () => ({ rows: [] }) }),
  },
});

mock.module("@nexus/agents", {
  exports: {
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
    classifyBusiness,
    buildTriageMessage,
    resolveTriageReply,
    routeToEmployeeTwin: async (tenant) => {
      calls.agentTenants.push(tenant.slug);
      return {
        config: { id: "agent-1" },
        respond: async (event) => {
          calls.respondOrgIds.push(event.organizationId);
          return { text: "Here is an answer.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };
    },
    loadRecentHistory: async () => [],
  },
});

mock.module("@nexus/governance", {
  exports: {
    evaluateOutgoingMessage: async () => ({ piiFlagged: false, hallucinationRisk }),
    // Mirrors the real policy: the law firm escalates at medium risk, retail does not.
    shouldEscalateReply: (evaluation, slug) => {
      calls.governanceSlugs.push(slug);
      return (
        evaluation.piiFlagged ||
        evaluation.hallucinationRisk === "high" ||
        (evaluation.hallucinationRisk === "medium" &&
          (slug === "juris-prime-legal" || slug === "juris-prime"))
      );
    },
  },
});

mock.module(new URL("../src/lib/whatsapp-client.ts", import.meta.url), {
  exports: {
    sendWhatsAppText: async (phoneNumberId, to, body) => calls.sent.push({ to, body }),
    sendWhatsAppTemplate: async () => {},
  },
});
mock.module(new URL("../src/lib/pubsub.ts", import.meta.url), {
  exports: { publishInboxEvent: async () => {} },
});

const { processInboundWebhookJob } = await import("../src/queue/processor.ts");

function inbound(body) {
  return {
    data: {
      receivedAt: new Date().toISOString(),
      phoneNumberId: SHARED_NUMBER,
      payload: {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "entry-1",
            changes: [
              {
                field: "messages",
                value: {
                  messaging_product: "whatsapp",
                  metadata: { display_phone_number: "+971500000000", phone_number_id: SHARED_NUMBER },
                  contacts: [{ wa_id: "971500000002", profile: { name: "Customer" } }],
                  messages: [
                    {
                      from: "971500000002",
                      id: "wamid.TEST",
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: "text",
                      text: { body },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    },
  };
}

// ============================================================

test("a clear enquiry is answered by the routed business, not the number's owner", async () => {
  reset();
  await processInboundWebhookJob(inbound("I need a lawyer for a court case"));

  assert.deepEqual(calls.routed, [{ conversationId: "conv-1", organizationId: "org-legal" }]);
  assert.deepEqual(calls.agentTenants, ["juris-prime-legal"], "the law firm's agent must be loaded");
  assert.deepEqual(calls.respondOrgIds, ["org-legal"], "knowledge must be scoped to the law firm");
  assert.equal(calls.sent.length, 1, "one reply, no triage question");
});

test("routing selects the governance policy — the same reply escalates for the law firm and not for retail", async () => {
  // This is the failure the whole switchboard exists to prevent: a legal
  // question answered under retail thresholds. Both runs are identical except
  // for which business the message routes to.
  reset({ risk: "medium" });
  await processInboundWebhookJob(inbound("I need a lawyer for a court case"));

  assert.deepEqual(calls.governanceSlugs, ["juris-prime-legal"]);
  assert.equal(calls.handoffs.length, 1, "medium risk under the law firm must escalate");
  assert.match(calls.sent[0].body, /looping in a specialist/);

  reset({ risk: "medium" });
  await processInboundWebhookJob(inbound("do you have this beauty product in stock"));

  assert.deepEqual(calls.governanceSlugs, ["zipicka"]);
  assert.equal(calls.handoffs.length, 0, "the same risk under retail must not escalate");
  assert.equal(calls.sent[0].body, "Here is an answer.");
  console.log("PASS: the routed tenant, not the number owner, selects the governance policy");
});

test("an undecidable message asks which business instead of guessing", async () => {
  reset();
  await processInboundWebhookJob(inbound("hello"));

  assert.equal(calls.routed.length, 0, "must not guess a business");
  assert.equal(calls.agentTenants.length, 0, "no agent may run before the tenant is known");
  assert.equal(calls.triagePrompts, 1);
  for (const b of BUSINESSES) assert.ok(calls.sent[0].body.includes(b.name), `${b.name} must be offered`);
});

test("an ambiguous message asks rather than picking the stronger match", async () => {
  reset();
  // "property" (real estate) and "lawyer" (legal) — one keyword each.
  await processInboundWebhookJob(inbound("I need a lawyer about a property"));

  assert.equal(calls.routed.length, 0);
  assert.equal(calls.triagePrompts, 1);
});

test("a bare number only counts as an answer once the menu has been sent", async () => {
  // Unprompted: "2" is not a selection, because the customer never saw a list.
  reset();
  await processInboundWebhookJob(inbound("2"));
  assert.equal(calls.routed.length, 0, "an unprompted ordinal must not select a business");
  assert.equal(calls.triagePrompts, 1);

  // Prompted: the same text now resolves against the menu we actually sent.
  reset({ state: { routedOrganizationId: null, triagePromptedAt: "2026-08-08T00:00:00Z", triageAttempts: 1 } });
  await processInboundWebhookJob(inbound("2"));
  assert.deepEqual(calls.routed, [{ conversationId: "conv-1", organizationId: "org-legal" }]);
  assert.deepEqual(calls.agentTenants, ["juris-prime-legal"]);
});

test("routing is sticky — a later off-topic word does not move a live conversation", async () => {
  reset({ state: { routedOrganizationId: "org-legal", triagePromptedAt: null, triageAttempts: 0 } });
  // Mentions a villa, which classifies to real estate. It must not re-route.
  await processInboundWebhookJob(inbound("the dispute is about a villa"));

  assert.equal(calls.routed.length, 0, "an already-routed conversation must not be re-classified");
  assert.deepEqual(calls.agentTenants, ["juris-prime-legal"]);
});

test("triage gives up after a bounded number of attempts and fetches a human", async () => {
  reset({ state: { routedOrganizationId: null, triagePromptedAt: "2026-08-08T00:00:00Z", triageAttempts: 3 } });
  await processInboundWebhookJob(inbound("???"));

  assert.equal(calls.triagePrompts, 0, "must stop re-sending the menu");
  assert.equal(calls.handoffs.length, 1, "a human takes over instead");
  assert.match(calls.sent[0].body, /looping in a specialist/);
});
