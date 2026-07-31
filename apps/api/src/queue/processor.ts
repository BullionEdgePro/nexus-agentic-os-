import type { Job } from "bullmq";
import type {
  ConversationMetricInput,
  InboundWebhookJob,
  MessageDto,
  Organization,
  WhatsAppTextMessage,
  WhatsAppWebhookEntry,
} from "@nexus/shared";
import {
  findOrganizationByPhoneNumberId,
  recordInboundMessage,
  insertOutboundMessage,
  insertEvaluation,
  recordConversationMetric,
  setConversationHandoff,
} from "@nexus/db";
import { routeToDomainAgent, loadRecentHistory } from "@nexus/agents";
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

  const aiPaused = Boolean(aiPausedUntil && new Date(aiPausedUntil).getTime() > Date.now());
  if (isHumanHandoff || aiPaused) {
    logger.debug(
      { conversationId, isHumanHandoff, aiPaused },
      "Skipping AI agent — conversation is in human handoff"
    );
    return;
  }

  const agent = await routeToDomainAgent(phoneNumberId);
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

    const shouldEscalate = shouldEscalateReply(evaluation, organization.slug);
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
