// The switchboard, wired into the real processor.
//
// business-router.test.mjs proves the classifier is correct in isolation. This
// proves the pipeline actually USES it — that the routed tenant, not the tenant
// that owns the phone number, selects the agent, the knowledge scope and the
// governance policy. Those three are the whole reason routing exists; a
// classifier nothing calls is decoration.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

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

mock.module("@nexus/db", {
  exports: {
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
