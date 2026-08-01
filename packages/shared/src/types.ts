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

// ============================================================
// Analytics
// ============================================================

export type ResolvedBy = "ai_agent" | "human_agent" | "unresolved";

/** One row written to conversation_metrics per handled inbound message. */
export interface ConversationMetricInput {
  organizationId: string;
  conversationId: string;
  intent?: string | null;
  resolvedBy: ResolvedBy;
  inputTokens: number;
  outputTokens: number;
  firstResponseMs?: number | null;
  resolutionMs?: number | null;
}

/** Aggregated snapshot powering the command-deck overview. */
export interface OverviewMetrics {
  hasData: boolean;
  activeConversations: number;
  messagesToday: number;
  aiResolutionPct: number | null;
  avgFirstResponseMs: number | null;
  governanceHolds: number;
  tokensUsed: number;
  intents: { intent: string; count: number }[];
  tenants: { slug: string; name: string; messageCount: number; openConversations: number }[];
  feed: { org: string; senderType: SenderType; body: string; createdAt: string }[];
}

// ============================================================
// Employee Agent Layer
// ============================================================

export type PresenceStatus =
  | "online"
  | "offline"
  | "idle"
  | "busy"
  | "ai_handling"
  | "meeting"
  | "vacation"
  | "emergency";

export type PresenceSource = "manual" | "schedule" | "calendar" | "auto_idle" | "system";

/** A single working window on one weekday, in the employee's own timezone. */
export interface TimeWindow {
  start: string; // "09:00"
  end: string; // "18:00"
}

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/** Weekday → working windows. A missing or empty day means "not working". */
export type WeeklySchedule = Partial<Record<Weekday, TimeWindow[]>>;

export interface Employee {
  id: string;
  organizationId: string;
  employeeCode: string;
  fullName: string;
  email?: string | null;
  avatarUrl?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  permissions: Record<string, unknown>;

  whatsappPhoneNumberId?: string | null;
  whatsappNumber?: string | null;

  timezone: string;
  workingHours: WeeklySchedule;
  breakSchedule: WeeklySchedule;

  languages: string[];
  skills: string[];
  expertise: string[];

  twinEnabled: boolean;
  aiPersonality?: string | null;
  responseStyle?: string | null;
  knowledgeCollection?: string | null;
  escalationRules: Record<string, unknown>;
  twinDisclosure?: string | null;

  /**
   * Human-only attestation. Never exposed to the twin — see
   * packages/employees/src/twin.ts.
   */
  digitalSignature?: string | null;

  manualPresence?: PresenceStatus | null;
  manualPresenceUntil?: string | null;
  lastSeenAt?: string | null;
  humanFirst: boolean;

  isActive: boolean;
}

/** Outcome of the presence engine for one employee at one instant. */
export interface ResolvedPresence {
  status: PresenceStatus;
  source: PresenceSource;
  /** True when the AI twin should generate the reply for this employee now. */
  shouldTwinRespond: boolean;
  /** Human-readable justification, surfaced in the deck and in logs. */
  reason: string;
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
