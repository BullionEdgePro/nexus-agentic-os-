// Shared domain types used across apps/api, apps/web, packages/agents, packages/db.

export type BusinessSlug =
  | "zipicka"
  | "juris-prime"
  | "juris-prime-legal"
  | "sfs-international"
  | "atif-ali-production";

export interface Organization {
  id: string;
  slug: BusinessSlug;
  name: string;
  whatsappPhoneNumberId: string;
  whatsappBusinessAccountId: string;
  timezone: string;
  createdAt: string;
}

export type MessageDirection = "inbound" | "outbound";
export type MessageStatus = "queued" | "sent" | "delivered" | "read" | "failed";
export type SenderType = "contact" | "ai_agent" | "human_agent" | "system";

export interface WhatsAppTextMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  [key: string]: unknown;
}

export interface WhatsAppWebhookEntry {
  id: string;
  changes: Array<{
    field: string;
    value: {
      messaging_product: "whatsapp";
      metadata: { display_phone_number: string; phone_number_id: string };
      contacts?: Array<{ profile: { name: string }; wa_id: string }>;
      messages?: WhatsAppTextMessage[];
      statuses?: Array<{
        id: string;
        status: MessageStatus;
        timestamp: string;
        recipient_id: string;
      }>;
    };
  }>;
}

export interface WhatsAppWebhookPayload {
  object: string;
  entry: WhatsAppWebhookEntry[];
}

/** Shape of the job pushed onto the inbound-webhook Redis queue. */
export interface InboundWebhookJob {
  receivedAt: string;
  phoneNumberId: string;
  payload: WhatsAppWebhookPayload;
}

/** Normalized unit of work handed from the queue worker to the agent switchboard. */
export interface InboundMessageEvent {
  organizationId: string;
  contactWaId: string;
  contactName?: string;
  messageId: string;
  text: string;
  timestamp: string;
}

export interface AgentConfig {
  id: string;
  organizationId: string;
  name: string;
  systemPrompt: string;
  model: string;
  tools: string[];
  ragCollection?: string;
  isActive: boolean;
}

// ============================================================
// Unified Inbox REST/WS DTOs
// ============================================================

export interface ConversationSummary {
  id: string;
  contactId: string;
  contactWaId: string;
  contactName: string | null;
  status: "open" | "pending" | "resolved" | "closed";
  isHumanHandoff: boolean;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  senderType: SenderType;
  body: string | null;
  status: MessageStatus;
  createdAt: string;
}

/** Broadcast over the WebSocket channel to connected Unified Inbox clients. */
export interface InboxSocketEvent {
  type: "message" | "handoff_changed";
  organizationId: string;
  organizationSlug: BusinessSlug;
  conversationId: string;
  message?: MessageDto;
  isHumanHandoff?: boolean;
}

export type HallucinationRisk = "low" | "medium" | "high";

export interface GovernanceEvaluation {
  piiFlagged: boolean;
  hallucinationRisk: HallucinationRisk;
  notes?: string;
}

export type AudienceFilter = Record<string, unknown>; // matched via jsonb containment against contacts.attributes

export interface CreateBroadcastInput {
  organizationId: string;
  templateId: string;
  audienceFilter: AudienceFilter;
  scheduledAt?: string;
}

export type BroadcastStatus = "draft" | "scheduled" | "sending" | "completed" | "failed";

/** Job payload for the per-recipient broadcast-send queue. */
export interface BroadcastSendJob {
  broadcastId: string;
  recipientId: string;
  contactWaId: string;
  phoneNumberId: string;
  templateName: string;
  templateLanguage: string;
}
