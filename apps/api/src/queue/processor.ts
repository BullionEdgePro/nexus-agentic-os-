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
  findEmployeeForConversation,
  recordInboundMessage,
  insertOutboundMessage,
  insertEvaluation,
  recordConversationMetric,
  setConversationHandoff,
} from "@nexus/db";
import { routeToEmployeeTwin, loadRecentHistory } from "@nexus/agents";
import { resolvePresence, containsDigitalSignature } from "@nexus/employees";
import { scoreLead, recordLeadAssessment, countPriorInbound } from "@nexus/leads";
import { evaluateOutgoingMessage, shouldEscalateReply } from "@nexus/governance";
import { sendWhatsAppText } from "../lib/whatsapp-client.js";
import { publishInboxEvent } from "../lib/pubsub.js";
import { logger } from "../lib/logger.js";

const FALLBACK_REPLY =
  "Thanks for your message — I want to make sure you get an accurate answer, so I'm looping in a specialist from our team. They'll follow up shortly.";

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

  const organization = await findOrganizationByPhoneNumberId(phoneNumberId);
  if (!organization) {
    logger.warn({ phoneNumberId }, "No organization mapped to inbound phone_number_id");
    return;
  }

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

  const agent = await routeToEmployeeTwin(phoneNumberId, employee);
  if (!agent) {
    logger.warn({ organizationId: organization.id }, "No active agent configured for organization");
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
        organizationId: organization.id,
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

    const shouldEscalate = shouldEscalateReply(evaluation, organization.slug) || signatureLeak;
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
