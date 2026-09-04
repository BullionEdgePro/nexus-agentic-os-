// Shared domain types used across apps/api, apps/web, packages/agents, packages/db.

export type BusinessSlug =
  | "zipicka"
  | "juris-prime"
  | "juris-prime-legal"
  | "sfs-international"
  | "abr";

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
      /**
       * Coexistence only (field `smb_message_echoes`): messages the staff member
       * sent to a customer FROM their own WhatsApp Business app, mirrored to us so
       * the dashboard shows what they said on their phone. Same shape as an
       * inbound message but business→customer, so each carries a `to` (the
       * customer) as well as a `from` (their number) — read off the index
       * signature rather than typed here, since it is Meta's shape, not ours.
       */
      message_echoes?: WhatsAppTextMessage[];
      statuses?: Array<{
        id: string;
        status: MessageStatus;
        timestamp: string;
        recipient_id: string;
        /**
         * Present only on `failed`, and the most useful field on the payload.
         *
         * Typed loosely on purpose: this is Meta's shape, not ours, and it has
         * changed before. `describeStatusError` reads it defensively and keeps
         * the words verbatim — a normalised code of our own would discard
         * exactly the part that tells somebody what to do differently.
         */
        errors?: Array<{
          code?: number;
          title?: string;
          message?: string;
          error_data?: { details?: string };
        }>;
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
  /**
   * The stored contact and conversation this message became.
   *
   * Optional only because `dry-run-reply` has neither — it probes an agent with
   * a reserved wa_id and deliberately writes nothing. The live pipeline always
   * has both by the time it calls an agent, and tools that record something
   * against a customer (book_appointment) refuse without them.
   */
  contactId?: string;
  conversationId?: string;
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
  /**
   * The staff member this conversation belongs to, or null when it is the
   * business's shared pool. Set by a referral link (the customer arrived through
   * someone's link) or by a manual assignment. It is what lets a staff member
   * filter the shared business inbox down to "my conversations" — the ones a
   * customer opened with them specifically — without the API having to serve a
   * second, differently-scoped list.
   */
  assignedEmployeeId: string | null;
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
  /**
   * The F10 procedure that was in front of the agent when this reply was
   * composed, if any. Stamped even when governance then blocked the reply —
   * see migration 036 for why excluding those would make the success rate
   * unable to go down.
   */
  procedureId?: string | null;
  /**
   * Whether knowledge retrieval worked for this reply.
   *
   * Null when search_knowledge was never called — most replies. 'miss' means it
   * ran and found nothing; 'failed' means it could not run at all. Keeping those
   * two apart is the whole point: they are identical to a reader of the
   * conversation, and only one of them is an outage.
   *
   * 'degraded' (migration 047) is a third thing that looks like the other two
   * from outside: semantic search could not run, and keyword search answered in
   * its place. The customer got an answer, so it is not 'failed'; the provider
   * was down, so it must not be 'hit'.
   */
  retrievalOutcome?: "hit" | "miss" | "failed" | "degraded" | null;
  /**
   * What the customer actually received (migration 049).
   *
   * The reason this exists: metrics were written near the end of the reply
   * pipeline's `try`, so a model that threw jumped past the write entirely and
   * a failed reply left no row. Twelve rows existed, all 'ai_agent', beside four
   * fallback messages that had no row at all — an AI resolution rate of 100%
   * over a denominator that excluded every failure.
   *
   * Null on rows written before it was recorded, and deliberately not
   * backfilled: the successes could be inferred and the failures could not, and
   * a column complete for one and empty for the other is worse than honestly
   * unknown for both.
   */
  replyOutcome?: ReplyOutcome | null;
}

/**
 * What the customer received, as distinct from who resolved it.
 *
 *   agent            — a model reply. This row's token usage is that reply's.
 *   fallback         — the model produced nothing; the platform's sentence went
 *                      out instead. Tokens are 0, and 0 is the true value.
 *   none             — the fallback failed too; the customer received nothing.
 *   agent_unrecorded — a reply went out and the bookkeeping after it threw. The
 *                      row keeps the conversation in the denominator; its token
 *                      counts are NOT the reply's, and this value says so rather
 *                      than a zero that would read as a measurement.
 */
/**
 * What happened to the reply for one inbound message.
 *
 * `skipped_handover` is NOT a failure. It records that a message arrived at a
 * conversation a person had taken over and the agent stood down on purpose --
 * which until 2026-08-19 left no trace at all: a debug log below the container
 * log level, a job that completed cleanly, and no metric row. See migration 057.
 */
export type ReplyOutcome =
  | "agent"
  | "fallback"
  | "none"
  | "agent_unrecorded"
  | "skipped_handover";

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

/**
 * The socials a person self-reports being on. A directory, not a connection —
 * see packages/employees/src/social-accounts.ts. `website` and `other` are here
 * because a link somewhere unlisted is still worth recording.
 */
export const SOCIAL_PLATFORMS = [
  "facebook",
  "instagram",
  "tiktok",
  "linkedin",
  "youtube",
  "x",
  "snapchat",
  "whatsapp",
  "website",
  "other",
] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export interface SocialAccount {
  platform: SocialPlatform;
  /** The account name or handle, e.g. "@zipicka" or "Zipicka UAE". */
  label: string;
  /** A link to the page/profile; may be empty (a handle alone is still useful). */
  url: string;
}

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
  /** Set only once Meta has confirmed the number exists on the business account. */
  whatsappVerifiedName?: string | null;
  whatsappConnectedAt?: string | null;
  whatsappQualityRating?: string | null;
  /** Off by default: a staff campaign spends the shared number's quality rating. */
  canBroadcast?: boolean;
  /** NULL means no ceiling set here — which is NOT unlimited; Meta's tier still applies. */
  broadcastMonthlyCap?: number | null;

  timezone: string;
  workingHours: WeeklySchedule;
  breakSchedule: WeeklySchedule;
  /** Self-reported social presence — a directory of handles/links, never a token. */
  socialAccounts: SocialAccount[];

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
  /**
   * When this person last SIGNED IN, and what from.
   *
   * Distinct from `lastSeenAt`, which is activity. A date alone answers "is
   * this account still used"; the device answers the question somebody actually
   * asks looking at their own record -- "was that me?"
   *
   * Null on both means nobody has ever signed in with it.
   */
  lastLoginAt?: string | null;
  lastLoginDevice?: string | null;
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
  /**
   * Body parameters already resolved per recipient. Resolved when the job is
   * queued rather than when it runs, so a contact renamed mid-send cannot make
   * two recipients of the same broadcast receive differently-shaped messages.
   */
  templateParams?: string[];
}
