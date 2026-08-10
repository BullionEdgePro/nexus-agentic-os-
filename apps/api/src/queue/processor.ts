import type { Job } from "bullmq";
import type {
  ConversationMetricInput,
  InboundWebhookJob,
  MessageDto,
  Organization,
  WhatsAppTextMessage,
  WhatsAppWebhookEntry,
} from "@nexus/shared";
import type { Employee } from "@nexus/shared";
import {
  findOrganizationByPhoneNumberId,
  findOrganizationById,
  findEmployeeForConversation,
  findSharedNumberBusinesses,
  getConversationRouting,
  setConversationRouting,
  recordTriagePrompt,
  recordInboundMessage,
  insertOutboundMessage,
  insertEvaluation,
  recordConversationMetric,
  setConversationHandoff,
  withTenant,
} from "@nexus/db";
import type { SharedNumberBusiness } from "@nexus/db";
import {
  routeToEmployeeTwin,
  loadRecentHistory,
  classifyBusiness,
  buildTriageMessage,
  resolveTriageReply,
} from "@nexus/agents";
import { resolvePresence, containsDigitalSignature } from "@nexus/employees";
import { scoreLead, recordLeadAssessment, countPriorInbound } from "@nexus/leads";
import { evaluateOutgoingMessage, shouldEscalateReply } from "@nexus/governance";
import { sendWhatsAppText } from "../lib/whatsapp-client.js";
import { publishInboxEvent } from "../lib/pubsub.js";
import { logger } from "../lib/logger.js";

const FALLBACK_REPLY =
  "Thanks for your message — I want to make sure you get an accurate answer, so I'm looping in a specialist from our team. They'll follow up shortly.";

// How many times a customer may be handed the triage menu before a human takes
// over. Bounded because the failure mode is a loop: if someone's messages never
// classify and never answer the menu, re-asking forever is worse than silence.
const MAX_TRIAGE_ATTEMPTS = 3;

// Map the tool the agent chose to a coarse intent label for analytics. A tool
// call is a strong, free, deterministic intent signal — no extra LLM call.
// A reply with no tool use is treated as a general inquiry (intent = null).
const TOOL_INTENT: Record<string, string> = {
  check_inventory: "inventory_inquiry",
  book_appointment: "appointment_booking",
  search_knowledge: "knowledge_lookup",
};

function deriveIntent(toolCalls: Array<{ name: string }>): string | null {
  for (const call of toolCalls) {
    const intent = TOOL_INTENT[call.name];
    if (intent) return intent;
  }
  return null;
}

// Time from the customer's message to our reply, in ms. Guards against clock
// skew / malformed timestamps and caps at 24h so a stray value can't overflow
// the metrics int column or pollute the analytics.
function firstResponseMsFrom(inboundTimestamp: string): number | null {
  const inboundMs = Number(inboundTimestamp) * 1000;
  if (!Number.isFinite(inboundMs) || inboundMs <= 0) return null;
  const elapsed = Date.now() - inboundMs;
  if (elapsed < 0 || elapsed > 86_400_000) return null;
  return Math.round(elapsed);
}

// Analytics must never take down the reply pipeline: record metrics
// best-effort and swallow any failure with a log.
async function recordMetricBestEffort(input: ConversationMetricInput): Promise<void> {
  try {
    await recordConversationMetric(input);
  } catch (err) {
    logger.error(
      { conversationId: input.conversationId, err },
      "Failed to record conversation metric (non-fatal analytics write)"
    );
  }
}

export async function processInboundWebhookJob(job: Job<InboundWebhookJob>): Promise<void> {
  const { payload, phoneNumberId } = job.data;

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      const messages = change.value.messages ?? [];
      for (const message of messages) {
        if (message.type !== "text" || !message.text) continue;
        // Isolated per message: one bad message in a multi-message webhook
        // payload must not force BullMQ to retry the whole batch, re-doing
        // work for siblings that already succeeded.
        await processSingleTextMessage(phoneNumberId, message, change);
      }
    }
  }
}

async function processSingleTextMessage(
  phoneNumberId: string,
  message: WhatsAppTextMessage,
  change: WhatsAppWebhookEntry["changes"][number]
): Promise<void> {
  const text = message.text;
  if (!text) return; // caller already filters for this, but keep the function safe standalone

  const contactName = change.value.contacts?.find((c) => c.wa_id === message.from)?.profile.name;

  // Resolved outside any tenant context, and correctly so: `organizations` is
  // the tenant registry, not tenant data. Scoping this lookup would be circular
  // — it is the query that decides which tenant we are.
  const organization = await findOrganizationByPhoneNumberId(phoneNumberId);
  if (!organization) {
    logger.warn({ phoneNumberId }, "No organization mapped to inbound phone_number_id");
    return;
  }

  // From here the tenant is known, so everything below runs scoped to it rather
  // than platform-wide. Wrapping the whole job cross-tenant would have been
  // simpler and would have defeated the point: the message pipeline is the
  // largest body of tenant-scoped code in the system, and it is exactly where a
  // forgotten WHERE clause would leak one business's customer into another's.
  return withTenant(organization.id, async () => {

  // Deliberately NOT inside the try/catch below: a failure here means an
  // infrastructure problem (DB down), not an AI/agent problem. Let it
  // propagate so BullMQ retries the whole job — safe to redo thanks to the
  // wa_message_id unique constraint (recordInboundMessage is a no-op on
  // replay once the message is already stored).
  const inboundResult = await recordInboundMessage({
    organizationId: organization.id,
    contactWaId: message.from,
    contactName,
    waMessageId: message.id,
    body: text.body,
    rawPayload: message,
  });
  const { conversationId, contactId, messageId, isHumanHandoff, aiPausedUntil } = inboundResult;

  if (!messageId) {
    // Meta redelivered a message we already processed — skip the agent call.
    return;
  }

  const inboundDto: MessageDto = {
    id: messageId,
    conversationId,
    direction: "inbound",
    senderType: "contact",
    body: text.body,
    status: "delivered",
    createdAt: new Date().toISOString(),
  };
  await publishInboxEvent({
    type: "message",
    organizationId: organization.id,
    organizationSlug: organization.slug,
    conversationId,
    message: inboundDto,
  });

  // Lead scoring. Best-effort and fire-and-forget for the same reason analytics
  // is: a scoring failure must never be able to stop a customer getting a
  // reply. Runs for every inbound message including ones the AI will not
  // answer, because a message arriving during human handoff is exactly the kind
  // a human needs prioritized.
  await scoreLeadBestEffort({
    organizationId: organization.id,
    contactId,
    conversationId,
    messageId,
    text: text.body,
  });

  const aiPaused = Boolean(aiPausedUntil && new Date(aiPausedUntil).getTime() > Date.now());
  if (isHumanHandoff || aiPaused) {
    logger.debug(
      { conversationId, isHumanHandoff, aiPaused },
      "Skipping AI agent — conversation is in human handoff"
    );
    return;
  }

  // Switchboard. On a dedicated number this resolves to the owning tenant
  // immediately and costs one indexed query; on a shared number it decides
  // which business the enquiry is for, or asks.
  //
  // Deliberately placed before the agent is loaded and before governance is
  // evaluated, because the routed tenant selects BOTH — answering first and
  // attributing afterwards would mean the number owner's policy had already
  // approved the reply.
  const decision = await resolveServingOrganization({
    phoneNumberId,
    conversationId,
    contactId,
    contactWaId: message.from,
    owner: organization,
    text: text.body,
  });
  if (decision.kind === "asked") return; // triage question sent; wait for the answer
  const serving = decision.organization;

  // Employee Agent Layer. Resolved best-effort on purpose: a tenant that has
  // not onboarded employees resolves to null and takes exactly the original
  // org-level path, and a failure looking employees up must degrade to that
  // same path rather than break a reply flow that worked before this layer
  // existed.
  const employee = await resolveAssignedEmployee(conversationId);
  const presence = employee ? resolvePresence(employee) : null;

  if (employee && presence && !presence.shouldTwinRespond) {
    // The human owns this conversation right now (they are online and opted
    // into human_first, or their twin is switched off). This is a deliberate,
    // recorded handoff rather than silence — the deck shows it as human-owned.
    logger.debug(
      { conversationId, employeeId: employee.id, presence: presence.status },
      "Employee is handling this conversation — twin standing down"
    );
    await flagHandoffBestEffort(organization, conversationId);
    return;
  }

  const agent = await routeToEmployeeTwin(serving, employee);
  if (!agent) {
    logger.warn({ organizationId: serving.id }, "No active agent configured for organization");
    return;
  }

  // Everything below is "generate and deliver an AI reply" — a failure
  // anywhere in this sequence (Anthropic API down/rate-limited/bad key,
  // WhatsApp send failure, a DB write failing right after a successful
  // send) must never leave the customer with silence, and must never
  // re-throw in a way that makes BullMQ retry this block — a retry would
  // re-run a non-deterministic LLM call and could send a second, different
  // reply to the same inbound message.
  let sentToCustomer = false;
  try {
    const history = await loadRecentHistory(conversationId);
    const result = await agent.respond(
      {
        // The routed tenant, not the number owner: this scopes knowledge
        // retrieval, so passing the owner here would let a shared number answer
        // a legal question out of the retail knowledge base.
        organizationId: serving.id,
        contactWaId: message.from,
        contactName,
        messageId: message.id,
        text: text.body,
        timestamp: message.timestamp,
      },
      history
    );

    if (!result.text) return;

    const evaluation = await evaluateOutgoingMessage({
      draftReply: result.text,
      conversationHistory: history.map((turn) => `${turn.role}: ${turn.content}`).join("\n"),
    });

    // Deterministic backstop for the twin's identity rules: the prompt forbids
    // reproducing the employee's digital signature, but a prompt is guidance,
    // not a guarantee. Signing machine-generated text with a person's
    // attestation is a misrepresentation we refuse to send, so it escalates
    // to that human exactly like a governance failure would.
    const signatureLeak = employee ? containsDigitalSignature(result.text, employee) : false;
    if (signatureLeak) {
      logger.error(
        { conversationId, employeeId: employee?.id },
        "Twin reply reproduced the employee's digital signature — blocked and escalated"
      );
    }

    // Governance is the routed tenant's, not the number owner's — this is the
    // whole reason routing happens before the reply is composed. `juris-prime-legal`
    // escalates at medium hallucination risk and `zipicka` does not; using the
    // owner's slug here would silently apply retail thresholds to legal answers.
    const shouldEscalate = shouldEscalateReply(evaluation, serving.slug) || signatureLeak;
    const finalText = shouldEscalate ? FALLBACK_REPLY : result.text;

    await sendWhatsAppText(phoneNumberId, message.from, finalText);
    sentToCustomer = true;

    const outboundDto = await insertOutboundMessage({
      organizationId: organization.id,
      conversationId,
      contactId,
      senderType: shouldEscalate ? "system" : "ai_agent",
      senderId: shouldEscalate ? undefined : agent.config.id,
      body: finalText,
      employeeId: employee?.id ?? null,
    });

    await insertEvaluation(organization.id, outboundDto.id, evaluation);

    await publishInboxEvent({
      type: "message",
      organizationId: organization.id,
      organizationSlug: organization.slug,
      conversationId,
      message: outboundDto,
    });

    if (shouldEscalate) {
      await setConversationHandoff(conversationId, true);
      await publishInboxEvent({
        type: "handoff_changed",
        organizationId: organization.id,
        organizationSlug: organization.slug,
        conversationId,
        isHumanHandoff: true,
      });
      logger.warn(
        { conversationId, evaluation },
        "AI reply blocked by governance evaluation, escalated to human handoff"
      );
    }

    // Analytics: token spend, who owns the resolution now, the classified
    // intent, and time-to-first-response. Best-effort — see recordMetricBestEffort.
    await recordMetricBestEffort({
      organizationId: organization.id,
      conversationId,
      intent: deriveIntent(result.toolCalls),
      resolvedBy: shouldEscalate ? "human_agent" : "ai_agent",
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      firstResponseMs: firstResponseMsFrom(message.timestamp),
    });
  } catch (err) {
    logger.error({ conversationId, sentToCustomer, err }, "AI reply pipeline failed");

    if (sentToCustomer) {
      // The customer already received a real reply — the failure was in
      // bookkeeping afterward (DB write, evaluation log). Don't send a
      // second, confusing "looping in a specialist" message on top of a
      // reply that already went through; just make sure a human is aware.
      await flagHandoffBestEffort(organization, conversationId);
    } else {
      await sendFallbackBestEffort(organization, phoneNumberId, message.from, conversationId, contactId);
    }
  }
  });
}

/**
 * Which business this message is for.
 *
 * `asked` means a triage question went out and nothing further should happen
 * for this message — the customer's answer arrives as the next inbound message
 * and is resolved against the menu we just sent.
 */
type ServingDecision =
  | { kind: "serve"; organization: Organization }
  | { kind: "asked" };

/**
 * Decide which tenant answers, on a number that may be shared.
 *
 * The important property is that this degrades to the pre-switchboard
 * behaviour in every failure case. A dedicated number, a lookup failure, a
 * routed tenant that has since been deactivated — all of them resolve to the
 * number's owner and take exactly the path that existed before routing did.
 * A customer never goes silent because triage could not make up its mind.
 *
 * Note the asymmetry in what "safe" means here. Refusing to route costs a
 * question; routing wrongly puts an enquiry in front of an agent operating
 * under a different business's governance policy. That is why an ambiguous
 * message asks rather than picking the most likely candidate.
 */
async function resolveServingOrganization(ctx: {
  phoneNumberId: string;
  conversationId: string;
  contactId: string;
  contactWaId: string;
  owner: Organization;
  text: string;
}): Promise<ServingDecision> {
  let businesses: SharedNumberBusiness[];
  try {
    businesses = await findSharedNumberBusinesses(ctx.phoneNumberId);
  } catch (err) {
    logger.error(
      { conversationId: ctx.conversationId, err },
      "Shared-number lookup failed — serving the number's owner"
    );
    return { kind: "serve", organization: ctx.owner };
  }

  // Fewer than two tenants on this number means there is nothing to triage:
  // the number identifies the business on its own, as it always did.
  if (businesses.length < 2) return { kind: "serve", organization: ctx.owner };

  let state = null;
  try {
    state = await getConversationRouting(ctx.conversationId);
  } catch (err) {
    logger.error({ conversationId: ctx.conversationId, err }, "Routing state read failed");
  }

  // Already triaged. Routing is sticky: re-classifying every message would let
  // one off-topic word move a live conversation, and its governance, mid-thread.
  if (state?.routedOrganizationId) {
    const routed = await findOrganizationById(state.routedOrganizationId).catch(() => null);
    if (routed) return { kind: "serve", organization: routed };
    logger.warn(
      { conversationId: ctx.conversationId, routedOrganizationId: state.routedOrganizationId },
      "Conversation was routed to an organization that is no longer active — re-triaging"
    );
  }

  // A bare "2" is only read as an answer if a menu was genuinely sent. Without
  // this check, a first message of "2" would select the second business —
  // and its governance — from a menu the customer never saw.
  if (state?.triagePromptedAt) {
    const picked = resolveTriageReply(ctx.text, businesses);
    if (picked) return commitRoute(ctx, picked, ["triage reply"]);
  }

  const outcome = classifyBusiness(ctx.text, businesses);
  if (outcome.kind === "routed") return commitRoute(ctx, outcome.business, outcome.matched);

  logger.debug(
    {
      conversationId: ctx.conversationId,
      outcome: outcome.kind,
      candidates: outcome.kind === "ambiguous" ? outcome.candidates.map((b) => b.slug) : [],
    },
    "Cannot determine which business this enquiry is for"
  );

  if ((state?.triageAttempts ?? 0) >= MAX_TRIAGE_ATTEMPTS) {
    logger.warn(
      { conversationId: ctx.conversationId, attempts: state?.triageAttempts },
      "Triage exhausted — handing the conversation to a human"
    );
    await sendFallbackBestEffort(
      ctx.owner,
      ctx.phoneNumberId,
      ctx.contactWaId,
      ctx.conversationId,
      ctx.contactId
    );
    return { kind: "asked" };
  }

  await askWhichBusiness(ctx, businesses);
  return { kind: "asked" };
}

async function commitRoute(
  ctx: { conversationId: string; owner: Organization },
  business: SharedNumberBusiness,
  matched: string[]
): Promise<ServingDecision> {
  const organization = await findOrganizationById(business.id).catch(() => null);
  if (!organization) {
    // Classified to a tenant we then could not load. Serving the owner is
    // wrong-but-answering; the alternative is silence, and the misroute is
    // recorded here rather than hidden.
    logger.error(
      { conversationId: ctx.conversationId, businessSlug: business.slug },
      "Routed to a business that could not be loaded — falling back to the number owner"
    );
    return { kind: "serve", organization: ctx.owner };
  }

  try {
    await setConversationRouting(ctx.conversationId, organization.id);
  } catch (err) {
    // The routing decision stands for this message even if it failed to
    // persist; the next message simply re-classifies.
    logger.error({ conversationId: ctx.conversationId, err }, "Failed to persist routing decision");
  }

  logger.info(
    { conversationId: ctx.conversationId, routedTo: organization.slug, matched },
    "Conversation routed to business"
  );
  return { kind: "serve", organization };
}

/**
 * Send the triage menu and record that we asked.
 *
 * Attributed to the number's owner in the database because the conversation and
 * contact belong to it — this message is sent by the switchboard, before any
 * business is on the hook for it, which is exactly why `buildTriageMessage`
 * makes no claim about price, availability or law.
 *
 * The attempt is recorded only after the send succeeds, so a WhatsApp outage
 * does not burn through the attempt budget and escalate a customer who was
 * never actually asked anything.
 */
async function askWhichBusiness(
  ctx: {
    phoneNumberId: string;
    conversationId: string;
    contactId: string;
    contactWaId: string;
    owner: Organization;
  },
  businesses: SharedNumberBusiness[]
): Promise<void> {
  const body = buildTriageMessage(businesses);

  try {
    await sendWhatsAppText(ctx.phoneNumberId, ctx.contactWaId, body);
  } catch (err) {
    logger.error({ conversationId: ctx.conversationId, err }, "Failed to send triage question");
    return;
  }

  try {
    await recordTriagePrompt(ctx.conversationId);
  } catch (err) {
    // The customer has the menu but we did not record asking. Their reply will
    // not be read as an ordinal, so they get asked once more — mildly annoying,
    // and strictly better than treating an unprompted number as a selection.
    logger.error({ conversationId: ctx.conversationId, err }, "Failed to record triage prompt");
  }

  try {
    const outboundDto = await insertOutboundMessage({
      organizationId: ctx.owner.id,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      senderType: "system",
      body,
    });
    await publishInboxEvent({
      type: "message",
      organizationId: ctx.owner.id,
      organizationSlug: ctx.owner.slug,
      conversationId: ctx.conversationId,
      message: outboundDto,
    });
  } catch (err) {
    logger.error({ conversationId: ctx.conversationId, err }, "Failed to record triage question");
  }
}

/**
 * Score an inbound message for commercial intent, swallowing any failure.
 *
 * The prior-message count is read before scoring so a returning contact is
 * weighted correctly; if that read fails the message is still scored, just
 * without the returning-contact signal — a slightly worse score beats no score.
 */
async function scoreLeadBestEffort(input: {
  organizationId: string;
  contactId: string;
  conversationId: string;
  messageId: string;
  text: string;
}): Promise<void> {
  try {
    let priorInboundCount = 0;
    try {
      // Subtract the message just recorded so "prior" really means prior.
      priorInboundCount = Math.max(0, (await countPriorInbound(input.contactId)) - 1);
    } catch (err) {
      logger.debug({ err }, "Prior-message count unavailable; scoring without it");
    }

    const assessment = scoreLead({ text: input.text, priorInboundCount });
    await recordLeadAssessment({
      ...assessment,
      organizationId: input.organizationId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      messageId: input.messageId,
    });

    logger.debug(
      { conversationId: input.conversationId, score: assessment.score, priority: assessment.priority },
      "Lead assessed"
    );
  } catch (err) {
    logger.error({ conversationId: input.conversationId, err }, "Lead scoring failed (non-fatal)");
  }
}

/**
 * Look up the employee who owns this conversation.
 *
 * Never throws. An inactive employee is treated as no employee so their
 * conversations fall back to the organization agent rather than going quiet,
 * and a lookup failure does the same — the Employee Agent Layer must be
 * incapable of making the pre-existing reply path worse.
 */
async function resolveAssignedEmployee(conversationId: string): Promise<Employee | null> {
  try {
    const employee = await findEmployeeForConversation(conversationId);
    return employee?.isActive ? employee : null;
  } catch (err) {
    logger.error(
      { conversationId, err },
      "Employee lookup failed — falling back to organization-level agent"
    );
    return null;
  }
}

async function sendFallbackBestEffort(
  organization: Organization,
  phoneNumberId: string,
  contactWaId: string,
  conversationId: string,
  contactId: string
): Promise<void> {
  try {
    await sendWhatsAppText(phoneNumberId, contactWaId, FALLBACK_REPLY);
    const outboundDto = await insertOutboundMessage({
      organizationId: organization.id,
      conversationId,
      contactId,
      senderType: "system",
      body: FALLBACK_REPLY,
    });
    await publishInboxEvent({
      type: "message",
      organizationId: organization.id,
      organizationSlug: organization.slug,
      conversationId,
      message: outboundDto,
    });
    await flagHandoffBestEffort(organization, conversationId);
  } catch (err) {
    // We could not even deliver the fallback — this contact has received
    // NO response at all and needs a human to notice and follow up
    // manually. Nothing further to automate; log loudly.
    logger.error(
      { conversationId, err },
      "Failed to deliver fallback message after AI failure — customer received NO response, needs manual follow-up"
    );
  }
}

async function flagHandoffBestEffort(organization: Organization, conversationId: string): Promise<void> {
  try {
    await setConversationHandoff(conversationId, true);
    await publishInboxEvent({
      type: "handoff_changed",
      organizationId: organization.id,
      organizationSlug: organization.slug,
      conversationId,
      isHumanHandoff: true,
    });
  } catch (err) {
    logger.error({ conversationId, err }, "Failed to flag conversation for human handoff after AI failure");
  }
}
