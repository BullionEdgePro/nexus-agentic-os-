import type { Job } from "bullmq";
import type { InboundWebhookJob, MessageDto } from "@nexus/shared";
import {
  findOrganizationByPhoneNumberId,
  recordInboundMessage,
  insertOutboundMessage,
  insertEvaluation,
  setConversationHandoff,
} from "@nexus/db";
import { routeToDomainAgent, loadRecentHistory } from "@nexus/agents";
import { evaluateOutgoingMessage } from "@nexus/governance";
import { sendWhatsAppText } from "../lib/whatsapp-client.js";
import { publishInboxEvent } from "../lib/pubsub.js";
import { logger } from "../lib/logger.js";

const FALLBACK_REPLY =
  "Thanks for your message — I want to make sure you get an accurate answer, so I'm looping in a specialist from our team. They'll follow up shortly.";

export async function processInboundWebhookJob(job: Job<InboundWebhookJob>): Promise<void> {
  const { payload, phoneNumberId } = job.data;

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      const messages = change.value.messages ?? [];
      for (const message of messages) {
        if (message.type !== "text" || !message.text) continue;

        const contactName = change.value.contacts?.find((c) => c.wa_id === message.from)?.profile.name;

        const organization = await findOrganizationByPhoneNumberId(phoneNumberId);
        if (!organization) {
          logger.warn({ phoneNumberId }, "No organization mapped to inbound phone_number_id");
          continue;
        }

        const inboundResult = await recordInboundMessage({
          organizationId: organization.id,
          contactWaId: message.from,
          contactName,
          waMessageId: message.id,
          body: message.text.body,
          rawPayload: message,
        });
        const { conversationId, contactId, messageId, isHumanHandoff, aiPausedUntil } = inboundResult;

        if (!messageId) {
          // Meta redelivered a message we already processed — skip the agent call.
          continue;
        }

        const inboundDto: MessageDto = {
          id: messageId,
          conversationId,
          direction: "inbound",
          senderType: "contact",
          body: message.text.body,
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
          continue;
        }

        const agent = await routeToDomainAgent(phoneNumberId);
        if (!agent) {
          logger.warn({ organizationId: organization.id }, "No active agent configured for organization");
          continue;
        }

        const history = await loadRecentHistory(conversationId);
        const result = await agent.respond(
          {
            organizationId: organization.id,
            contactWaId: message.from,
            contactName,
            messageId: message.id,
            text: message.text.body,
            timestamp: message.timestamp,
          },
          history
        );

        if (!result.text) continue;

        const evaluation = await evaluateOutgoingMessage({
          draftReply: result.text,
          conversationHistory: history.map((turn) => `${turn.role}: ${turn.content}`).join("\n"),
        });

        const shouldEscalate = evaluation.piiFlagged || evaluation.hallucinationRisk === "high";
        const finalText = shouldEscalate ? FALLBACK_REPLY : result.text;

        await sendWhatsAppText(phoneNumberId, message.from, finalText);

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
      }
    }
  }
}
