import type {
  BusinessSlug,
  ConversationSummary,
  MessageDto,
  Organization,
  OverviewMetrics,
} from "@nexus/shared";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    // The API authenticates browser traffic with the operator session cookie,
    // which a cross-origin fetch omits unless credentials are requested.
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`API ${response.status} on ${path}: ${body}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Turn an API failure into something the operator can act on.
 *
 * `request` throws `API 400 on /path: {"error":"..."}`, which carries the
 * status for a developer and buries the one part written for a person. Several
 * routes go to real trouble over that sentence — "another procedure for this
 * kind of enquiry is already active" is a thing someone can fix in one click —
 * and showing it wrapped in transport detail wastes the effort.
 *
 * Lives here rather than on a page because it was already written twice over on
 * the way to being written a third time. This codebase has paid for two copies
 * of one fact before: the nav rail and the API's operator-only list drifted
 * apart precisely because nothing connected them.
 */
export function readableError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const match = /\{"error":"([^"]+)"\}/.exec(raw);
  if (match) return match[1];
  if (raw.includes("API 401")) return "Your session expired. Sign in again.";
  return "Could not reach the platform. Check the connection and try again.";
}

export function getOrganizations(): Promise<{ organizations: Organization[] }> {
  return request("/api/organizations");
}

export function getOverview(): Promise<{ metrics: OverviewMetrics }> {
  return request("/api/metrics/overview");
}

export function getConversations(orgSlug: BusinessSlug): Promise<{ conversations: ConversationSummary[] }> {
  return request(`/api/organizations/${orgSlug}/conversations`);
}

export function getMessages(conversationId: string): Promise<{ messages: MessageDto[] }> {
  return request(`/api/conversations/${conversationId}/messages`);
}

/** How a conversation has changed hands between the agent and a person. */
export interface CustodyEvent {
  /** true = a person took it; false = it went back to the agent. */
  held: boolean;
  reason:
    | "agent_escalated"
    | "human_replied"
    | "taken_by_employee"
    | "manual_toggle"
    | "stale_release";
  /** Session subject or employee id. Null when the platform acted on its own. */
  actor: string | null;
  createdAt: string;
}

/**
 * Fetched on demand, not with the messages.
 *
 * `predatesRecording` distinguishes "this conversation has never changed hands"
 * from "it changed hands before anything was recording", which are opposite
 * news. Migration 062 deliberately backfills nothing, so for older
 * conversations the honest answer is that nobody knows.
 */
export function getCustody(
  conversationId: string
): Promise<{ events: CustodyEvent[]; predatesRecording: boolean }> {
  return request(`/api/conversations/${conversationId}/custody`);
}

export function sendMessage(conversationId: string, text: string): Promise<{ message: MessageDto }> {
  return request(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

// ============================================================
// Team
// ============================================================

export interface TeamMember {
  id: string;
  employeeCode: string;
  fullName: string;
  email?: string | null;
  jobTitle?: string | null;
  whatsappNumber?: string | null;
  twinEnabled: boolean;
  isActive: boolean;
  whatsappReady: boolean;
  presence: { status: string; source: string; shouldTwinRespond: boolean };
  timezone: string;
  workingHours: WeeklySchedule;
  breakSchedule: WeeklySchedule;
  /**
   * Hours a week the rota covers, computed server-side.
   *
   * Zero means the person is NOT bookable and will not be offered for
   * escalation. That is deliberate behaviour, not a bug — but it was invisible
   * on this screen for the whole life of the employee layer, so it is now a
   * value the UI can show rather than a consequence somebody discovers later.
   */
  weeklyHours: number;
}

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export interface TimeWindow {
  start: string;
  end: string;
}
export type WeeklySchedule = Partial<Record<Weekday, TimeWindow[]>>;

/**
 * Save an employee's rota.
 *
 * Rejects with the day and window named when a time is malformed, rather than
 * storing jsonb that reads back as "never working". Returns the recomputed
 * weekly hours so the caller can show what was actually stored.
 */
export function saveSchedule(
  orgSlug: BusinessSlug,
  employeeId: string,
  input: { workingHours?: WeeklySchedule; breakSchedule?: WeeklySchedule; timezone?: string }
): Promise<{ employee: TeamMember; weeklyHours: number; presence: TeamMember["presence"] }> {
  return request(`/api/organizations/${orgSlug}/employees/${employeeId}/schedule`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export interface DirectContact {
  url: string;
  message: string;
  sendingAs: string | null;
}

export interface AssignedConversation {
  conversationId: string;
  contactWaId: string;
  contactName: string | null;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  isHumanHandoff: boolean;
  businessName: string;
  businessSlug: string;
  directContact: DirectContact | null;
}

export function getTeam(orgSlug: BusinessSlug): Promise<{ employees: TeamMember[] }> {
  return request(`/api/organizations/${orgSlug}/employees`);
}

export function addTeamMember(
  orgSlug: BusinessSlug,
  input: { fullName: string; jobTitle?: string; email?: string; whatsappNumber?: string }
): Promise<{ employee: TeamMember }> {
  return request(`/api/organizations/${orgSlug}/employees`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function removeTeamMember(orgSlug: BusinessSlug, employeeId: string): Promise<{ deactivated: boolean }> {
  return request(`/api/organizations/${orgSlug}/employees/${employeeId}`, { method: "DELETE" });
}

/**
 * Issue a sign-in code for an employee.
 *
 * The code comes back exactly once and is never readable again — reissuing is
 * the whole recovery story, and it invalidates the previous code in the same
 * write.
 */
export function issueAccessCode(
  orgSlug: BusinessSlug,
  employeeId: string
): Promise<{ accessCode: string; signInAs: string; employee: { fullName: string } }> {
  return request(`/api/organizations/${orgSlug}/employees/${employeeId}/access-code`, {
    method: "POST",
  });
}

export interface EmployeeLead {
  assessmentId: string;
  contactWaId: string;
  contactName: string | null;
  note: string | null;
  score: number;
  priority: string;
  category: string;
  createdAt: string;
  employeeName: string | null;
}

/**
 * Log a lead won on an employee's own WhatsApp.
 *
 * Follow-up happens on personal phones, so without this the pipeline only ever
 * showed what arrived on the shared number.
 */
export function captureLead(
  orgSlug: BusinessSlug,
  input: { employeeId: string; whatsappNumber: string; contactName?: string; note: string }
): Promise<{ lead: EmployeeLead & { isNewContact: boolean } }> {
  return request(`/api/organizations/${orgSlug}/leads`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getEmployeeLeads(
  orgSlug: BusinessSlug,
  employeeId?: string
): Promise<{ leads: EmployeeLead[] }> {
  const q = employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : "";
  return request(`/api/organizations/${orgSlug}/leads${q}`);
}

export function getAssignedConversations(
  orgSlug: BusinessSlug,
  employeeId: string
): Promise<{ conversations: AssignedConversation[] }> {
  return request(`/api/organizations/${orgSlug}/employees/${employeeId}/conversations`);
}

export function assignConversation(
  conversationId: string,
  employeeId: string | null
): Promise<{ conversationId: string; employeeId: string | null }> {
  return request(`/api/conversations/${conversationId}/assign`, {
    method: "POST",
    body: JSON.stringify({ employeeId }),
  });
}

/**
 * Hand a customer to an employee's personal WhatsApp.
 *
 * Returns the link AND pauses the AI on the platform number — the pause is the
 * reason this is a request rather than a URL the browser could assemble itself.
 */
export interface HandoverBrief {
  summary: string | null;
  unavailableReason: string | null;
  turnsConsidered: number;
  /**
   * What was promised and is still outstanding — structured, never passed
   * through the summariser. A model asked to summarise turns "call back
   * Tuesday 4pm, owed by Ivan" into "we said we'd get back to them", losing
   * the two parts anyone can act on. Present even when the summary failed.
   */
  openFollowUps: Array<{
    title: string;
    dueAt: string | null;
    isOverdue: boolean;
    owner: string | null;
  }>;
}

export function takeToOwnWhatsApp(
  conversationId: string,
  employeeId: string
): Promise<DirectContact & { aiPaused: boolean; brief?: HandoverBrief }> {
  return request(`/api/conversations/${conversationId}/direct-contact`, {
    method: "POST",
    body: JSON.stringify({ employeeId }),
  });
}

export function setHandoff(
  conversationId: string,
  isHumanHandoff: boolean
): Promise<{ isHumanHandoff: boolean }> {
  return request(`/api/conversations/${conversationId}/handoff`, {
    method: "PATCH",
    body: JSON.stringify({ isHumanHandoff }),
  });
}

export interface EmployeeActivity {
  employeeId: string;
  fullName: string;
  jobTitle: string | null;
  organizationSlug: string;
  organizationName: string;
  isActive: boolean;
  hasSignIn: boolean;
  lastLoginAt: string | null;
  assignedConversations: number;
  handoffs: number;
  leadsLogged: number;
  bestLeadScore: number | null;
  lastLeadAt: string | null;
  lastActiveAt: string | null;
}

export interface ActivityEvent {
  at: string;
  employeeName: string | null;
  organizationSlug: string;
  kind: "lead" | "handoff";
  detail: string;
  score: number | null;
}

/** Operator-only: what every employee across every business has been doing. */
export function getActivity(
  orgSlug?: BusinessSlug
): Promise<{ employees: EmployeeActivity[]; events: ActivityEvent[] }> {
  return request(`/api/activity${orgSlug ? `?business=${orgSlug}` : ""}`);
}

export interface BroadcastTemplate {
  id: string;
  metaTemplateName: string;
  language: string;
  category: string | null;
  isApproved: boolean;
  status: string | null;
  bodyParamCount: number;
  syncedAt: string | null;
  createdAt: string;
}

export interface BroadcastSummary {
  id: string;
  templateName: string;
  status: "draft" | "scheduled" | "sending" | "completed" | "failed";
  recipients: number;
  /** Accepted by Meta. A 2xx means it took the message, not that anybody got it. */
  sent: number;
  /** Confirmed delivered by a receipt. Unknown rather than zero before migration 051. */
  delivered: number;
  failed: number;
  scheduledAt: string | null;
  createdAt: string;
}

export function getBroadcasts(orgSlug: BusinessSlug): Promise<{
  templates: BroadcastTemplate[];
  broadcasts: BroadcastSummary[];
  reachable: number;
  canSend: boolean;
}> {
  return request(`/api/broadcasts/${orgSlug}`);
}

/** Re-reads templates from Meta for one business. */
export function syncTemplates(orgSlug: BusinessSlug): Promise<{
  organizationSlug: string;
  synced: number;
  approved: number;
  retired: number;
}> {
  return request(`/api/broadcasts/${orgSlug}/sync`, { method: "POST" });
}

export function createBroadcast(input: {
  organizationSlug: BusinessSlug;
  templateId: string;
  scheduledAt?: string;
}): Promise<{ broadcast: { id: string } }> {
  return request("/api/broadcasts", { method: "POST", body: JSON.stringify(input) });
}

export function sendBroadcast(id: string): Promise<{ broadcastId: string; enqueued: number }> {
  // The API derives the organization and template from the broadcast row, so
  // the body carries only an optional audience filter. Sent as `{}` rather than
  // omitted because the route parses JSON from it.
  return request(`/api/broadcasts/${id}/send`, { method: "POST", body: "{}" });
}

export interface QualityDay {
  day: string;
  conversations: number;
  inboundMessages: number;
  aiMessages: number;
  humanMessages: number;
  aiAnswered: number;
  escalated: number;
  aiOnly: number;
  corrections: number;
  inputTokens: number;
  outputTokens: number;
  isComplete: boolean;
}

export interface QualitySummary {
  days: number;
  conversations: number;
  aiAnswered: number;
  escalated: number;
  corrections: number;
  outputTokens: number;
  escalationRate: number | null;
  containmentRate: number | null;
}

export interface EscalationHotspot {
  intent: string;
  conversations: number;
  escalated: number;
  escalationRate: number;
}

export function getQuality(
  orgSlug: BusinessSlug,
  days = 30
): Promise<{ trend: QualityDay[]; summary: QualitySummary; hotspots: EscalationHotspot[] }> {
  return request(`/api/quality/${orgSlug}?days=${days}`);
}

export function refreshQuality(): Promise<{ dayRows: number }> {
  return request("/api/quality/refresh", { method: "POST" });
}

export interface CopilotAnswer {
  understood: string;
  answer: string;
  rows: Array<Record<string, string | number | null>>;
  matched: boolean;
}

export function askCopilot(orgSlug: BusinessSlug, question: string): Promise<CopilotAnswer> {
  return request(`/api/quality/${orgSlug}/ask`, {
    method: "POST",
    body: JSON.stringify({ question }),
  });
}

export interface KnowledgeSource {
  id: string;
  kind: string;
  title: string;
  uri: string | null;
  status: string;
  version: number;
  chunks: number;
  lastIndexedAt: string | null;
  lastCheckedAt: string | null;
  error: string | null;
}

export function getKnowledge(orgSlug: BusinessSlug): Promise<{ sources: KnowledgeSource[] }> {
  return request(`/api/organizations/${orgSlug}/knowledge`);
}

export function addKnowledge(
  orgSlug: BusinessSlug,
  input: { url?: string; title?: string; content?: string }
): Promise<{ sourceId: string; chunks: number; unchanged: boolean }> {
  return request(`/api/organizations/${orgSlug}/knowledge`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function removeKnowledge(orgSlug: BusinessSlug, id: string): Promise<{ ok: true }> {
  return request(`/api/organizations/${orgSlug}/knowledge/${id}`, { method: "DELETE" });
}

// ============================================================
// Procedures (F10)
// ============================================================

export interface ProcedureStep {
  text: string;
}

export interface ProcedureRecord {
  id: string;
  businessName: string;
  intentCategory: string;
  language: string;
  steps: ProcedureStep[];
  /** A newer inference waiting on a person. Null when there is nothing to weigh. */
  proposedSteps: ProcedureStep[] | null;
  proposedAt: string | null;
  source: "operator" | "inferred" | "catalog";
  derivedFromCount: number;
  timesApplied: number;
  timesSucceeded: number;
  isActive: boolean;
  lastInferredAt: string | null;
  dismissedAt: string | null;
  dismissedEvidence: number | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  updatedAt: string;
}

/**
 * Why there is nothing to review yet.
 *
 * Carried alongside the list rather than inferred from its length, because
 * "empty" has several causes and only some of them are worth waiting out.
 */
export interface InferenceReadiness {
  windowDays: number;
  minConversations: number;
  conversations: number;
  wellHandled: number;
  perIntent: { intent: string; wellHandled: number; enough: boolean }[];
  blockedBecause: string | null;
  canRun: boolean;
}

export interface ProcedureCounts {
  active: number;
  drafts: number;
  proposals: number;
}

export function getProcedures(orgSlug: BusinessSlug): Promise<{
  procedures: ProcedureRecord[];
  counts: ProcedureCounts;
  readiness: InferenceReadiness;
  intents: string[];
}> {
  return request(`/api/organizations/${orgSlug}/procedures`);
}

export interface InferenceRunSummary {
  considered: number;
  written: number;
  proposed: number;
  skipped: number;
}

export interface InferenceRun {
  intents: {
    intent: string;
    wellHandled: number;
    write?: { outcome: string; note?: string };
    skipped?: { reason: string; detail?: string };
  }[];
}

export function inferProcedures(
  orgSlug: BusinessSlug
): Promise<{ run: InferenceRun; summary: InferenceRunSummary }> {
  return request(`/api/organizations/${orgSlug}/procedures/infer`, { method: "POST" });
}

export function createProcedure(
  orgSlug: BusinessSlug,
  input: { intentCategory: string; steps: string[]; activate?: boolean }
): Promise<{ procedure: ProcedureRecord }> {
  return request(`/api/organizations/${orgSlug}/procedures`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * One endpoint for the four review decisions — activate, edit, accept, dismiss.
 * They share every guard, and the question being answered is always the same
 * one: what should this procedure look like now.
 */
export function updateProcedure(
  orgSlug: BusinessSlug,
  id: string,
  input: { isActive?: boolean; steps?: string[]; accept?: boolean; dismiss?: boolean }
): Promise<{ procedure: ProcedureRecord }> {
  return request(`/api/organizations/${orgSlug}/procedures/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

// ============================================================
// What we say — authored agent wording (045)
// ============================================================

export type PhraseMoment = "handing_over" | "no_one_available";

export interface AgentPhrase {
  id: string;
  moment: PhraseMoment;
  language: string;
  /** Sent to the customer verbatim. Not a prompt hint. */
  body: string;
  source: "operator" | "catalog";
  catalogInstallId: string | null;
  isActive: boolean;
  reviewedAt: string | null;
  reviewedBy: string | null;
  updatedAt: string;
}

export interface PhraseMomentInfo {
  moment: PhraseMoment;
  label: string;
  blurb: string;
}

/**
 * The vocabulary comes back with the list.
 *
 * The page never holds its own copy of which moments exist — a form offering
 * one the server would refuse is the same drift that put a dead tab in the nav
 * rail.
 */
export function getPhrases(
  orgSlug: BusinessSlug
): Promise<{ phrases: AgentPhrase[]; moments: PhraseMomentInfo[] }> {
  return request(`/api/organizations/${orgSlug}/phrases`);
}

export function createPhrase(
  orgSlug: BusinessSlug,
  input: { moment: PhraseMoment; body: string }
): Promise<{ phrase: AgentPhrase }> {
  return request(`/api/organizations/${orgSlug}/phrases`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Edit the wording, switch it on, or both.
 *
 * Switching on is refused while the body still holds an unfilled
 * `{{placeholder}}` — that text reaches the customer exactly as written.
 */
export function updatePhrase(
  orgSlug: BusinessSlug,
  id: string,
  input: { body?: string; isActive?: boolean }
): Promise<{ phrase: AgentPhrase }> {
  return request(`/api/organizations/${orgSlug}/phrases/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

/** Mirrors `unfilledPlaceholders` in @nexus/shared — shown before the server refuses. */
export function unfilledPlaceholders(body: string): string[] {
  const found = body.match(/\{\{\s*[^}]+\s*\}\}/g) ?? [];
  return [...new Set(found.map((match) => match.trim()))];
}

// ============================================================
// The shared brain (F5)
// ============================================================

export interface SharedPattern {
  intentCategory: string;
  language: string;
  sampleCount: number;
  escalatedCount: number;
  escalationRate: number;
  avgResolutionSeconds: number | null;
  contributingTenants: number;
}

/**
 * How much of the platform's traffic F5 can actually read.
 *
 * `neverClassified` is the one to watch: nothing in the reply path writes a
 * NULL intent any more, so a rising count means classification stopped — a
 * defect, not a quiet week. The `intent-unclassified` operator raises it; this
 * screen is where somebody can see the shape of it.
 */
export interface IntentCoverage {
  conversations: number;
  classified: number;
  nonPatternOnly: number;
  neverClassified: number;
  rate: number;
}

export interface BrainStatus {
  patternsStored: number;
  patternsShareable: number;
  contributingTenants: number;
  /** Why the brain has nothing to offer, or null when it does. */
  blockedBecause: string | null;
  coverage: IntentCoverage;
}

/**
 * Pooled outcomes across every business.
 *
 * Operator-only by mount — `/api/quality` is, and this genuinely spans
 * businesses, so there is no per-tenant form of it to show an employee.
 */
export function getSharedBrain(): Promise<{ patterns: SharedPattern[]; status: BrainStatus }> {
  return request("/api/quality/shared");
}

export interface BusinessLink {
  slug: string;
  name: string;
  number: string | null;
  url: string | null;
  unavailableReason: string | null;
}

export function getLinks(): Promise<{ links: BusinessLink[] }> {
  return request("/api/links");
}

// ============================================================
// Marketplace (F13)
// ============================================================

export type CatalogItemKind = "template" | "procedure" | "knowledge_pack";

export interface CatalogItem {
  id: string;
  slug: string;
  kind: CatalogItemKind;
  title: string;
  summary: string;
  /** Shape depends on `kind`. Rendered generically — see the page. */
  payload: Record<string, unknown>;
  suitsIndustry: string | null;
  language: string;
  version: number;
  publishedAt: string | null;
}

export interface CatalogInstall {
  id: string;
  organizationId: string;
  businessName: string;
  businessSlug: string;
  catalogItemId: string;
  itemSlug: string;
  itemTitle: string;
  itemKind: CatalogItemKind;
  /** What this business is running. May trail `availableVersion`. */
  installedVersion: number;
  availableVersion: number;
  isActive: boolean;
  installedAt: string;
  removedAt: string | null;
}

export interface CatalogCounts {
  published: number;
  installs: number;
  businesses: number;
  outdated: number;
  /** Installs whose material has actually been added to the business. */
  activated: number;
}

/**
 * What activating one did.
 *
 * A procedure lands switched off; a knowledge pack is live the moment it is
 * indexed, because a chunk has no off state. The `note` is the server's own
 * sentence about which of those just happened, shown rather than re-derived
 * here — the two applications must not hold separate opinions about what a
 * button did.
 */
export type ActivationOutcome =
  | {
      kind: "procedure";
      procedureId: string;
      created: boolean;
      /** Set when something else is already live for that situation. */
      blockedBySource: string | null;
      note: string;
    }
  | { kind: "knowledge_pack"; sourceId: string; chunks: number; skipped: boolean; note: string };

/**
 * The shelf, the installs and the totals in one call.
 *
 * `activationWired` is the honest one. An install currently records a decision
 * and nothing more — no catalogue payload has been connected to the live agent
 * yet — so the page reads this rather than implying that installing something
 * changed what customers hear.
 */
export function getCatalog(): Promise<{
  items: CatalogItem[];
  installs: CatalogInstall[];
  counts: CatalogCounts;
  /** Kinds the server will actually activate. `template` is deliberately absent. */
  activatableKinds: CatalogItemKind[];
}> {
  return request("/api/catalog");
}

/**
 * Put an installed pack's material into the business.
 *
 * Materialises; does not switch on. A procedure arrives in How we answer
 * switched off and a person turns it on there, where they can see what else is
 * active for the same situation. There is no counterpart to this call — taking
 * material back out belongs to the screens that own it, because by then it is
 * the business's own and may have been changed since.
 */
export function activateCatalogInstall(
  organizationSlug: string,
  installId: string
): Promise<{ outcome: ActivationOutcome }> {
  return request(
    `/api/catalog/installs/${installId}/activate?business=${encodeURIComponent(organizationSlug)}`,
    { method: "POST" }
  );
}

export function installCatalogItem(
  organizationSlug: string,
  itemSlug: string
): Promise<{ install: CatalogInstall }> {
  return request("/api/catalog/installs", {
    method: "POST",
    body: JSON.stringify({ organizationSlug, itemSlug }),
  });
}

/**
 * The business is named as well as the install id.
 *
 * /api/catalog is cross-tenant, so the id alone would be enough to remove any
 * business's install — the route checks the two against each other rather than
 * trusting whichever id arrived.
 */
/**
 * What taking a catalogue update did.
 *
 * `kind` is null when the pack was installed but never added to the business —
 * there was no copy to reconcile, so only the recorded version moved.
 */
export interface CatalogUpdateOutcome {
  kind: CatalogItemKind | null;
  from: number;
  to: number;
  note: string;
}

/**
 * Move a business from the version it installed to the current one.
 *
 * Only ever from a button. A catalogue that upgraded itself inside a live agent
 * would change what customers are told with nobody deciding to, which is the
 * rule the whole install-version design exists to keep.
 */
export function takeCatalogUpdate(
  organizationSlug: string,
  installId: string
): Promise<{ outcome: CatalogUpdateOutcome }> {
  return request(
    `/api/catalog/installs/${installId}/update?business=${encodeURIComponent(organizationSlug)}`,
    { method: "POST" }
  );
}

export function removeCatalogInstall(
  organizationSlug: string,
  installId: string
): Promise<{ install: CatalogInstall }> {
  return request(`/api/catalog/installs/${installId}?business=${encodeURIComponent(organizationSlug)}`, {
    method: "DELETE",
  });
}

// ============================================================
// Operators
// ============================================================

export type FindingSeverity = "info" | "warn" | "urgent";

export interface OperatorFinding {
  id: string;
  organizationId: string;
  businessName: string;
  businessSlug: string;
  operator: string;
  severity: FindingSeverity;
  title: string;
  detail: string | null;
  subjectKind: string | null;
  subjectId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  /**
   * When somebody accepted this finding. Null for everything nobody has
   * looked at, which is almost everything.
   *
   * An accepted finding is still TRUE and still reconciled — it is not
   * resolved and not deleted. It lapses back to unaccepted if the condition
   * goes away and returns, because that is a new occurrence.
   */
  dismissedAt: string | null;
  dismissedBy: string | null;
  dismissedReason: string | null;
}

export interface OperatorInfo {
  slug: string;
  title: string;
  description: string;
  /** Null means this operator has never found anything — not that it is broken. */
  lastSeenAt: string | null;
}

export function getFindings(business?: BusinessSlug | ""): Promise<{
  findings: OperatorFinding[];
  /**
   * The three severities EXCLUDE accepted findings; `dismissed` counts them.
   *
   * A badge that still reads "1 urgent" after somebody accepted the only urgent
   * finding can never be cleared, and an unclearable badge is ignored inside a
   * week. Counted separately rather than dropped, because a page that silently
   * knows about four problems it is not mentioning is exactly what this screen
   * exists not to be.
   */
  counts: { urgent: number; warn: number; info: number; dismissed: number };
  operators: OperatorInfo[];
  /**
   * When the sweep last completed, and whether it is overdue (migration 050).
   *
   * Null means it has not completed since the worker started. The page must not
   * treat that as "recently" — an empty findings list from a sweep that stopped
   * looks exactly like an empty list from a healthy one, which is the whole
   * reason this field exists.
   */
  lastSweptAt: string | null;
  sweepStalled: boolean;
  alertsConfigured: boolean;
  alertsIncludeWarnings: boolean;
}> {
  return request(`/api/operators${business ? `?business=${business}` : ""}`);
}

/**
 * Accept a finding, or take the acceptance back.
 *
 * Not a delete. The row stays and stays reconciled, so a finding that stops
 * being true is still retracted normally, and one that comes back arrives
 * un-accepted because it is a new occurrence.
 */
export function dismissFinding(id: string, reason?: string): Promise<{ ok: true }> {
  return request(`/api/operators/findings/${encodeURIComponent(id)}/dismiss`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

export function restoreFinding(id: string): Promise<{ ok: true }> {
  return request(`/api/operators/findings/${encodeURIComponent(id)}/restore`, {
    method: "POST",
  });
}

// ============================================================
// Follow-ups
// ============================================================

export type TaskStatus = "open" | "done" | "cancelled";

export interface TaskRecord {
  id: string;
  organizationId: string;
  businessName: string;
  businessSlug: string;
  conversationId: string | null;
  contactId: string | null;
  contactName: string | null;
  contactWaId: string | null;
  employeeId: string | null;
  employeeName: string | null;
  title: string;
  notes: string | null;
  dueAt: string | null;
  status: TaskStatus;
  /** Decided by the database clock — do not recompute from dueAt in the browser. */
  isOverdue: boolean;
  completedAt: string | null;
  completedByName: string | null;
  createdAt: string;
}

export interface TaskCounts {
  open: number;
  overdue: number;
  unassigned: number;
}

export function getTasks(options: {
  business?: BusinessSlug | "";
  status?: TaskStatus | "all";
} = {}): Promise<{ tasks: TaskRecord[]; counts: TaskCounts }> {
  const query = new URLSearchParams();
  if (options.business) query.set("business", options.business);
  if (options.status) query.set("status", options.status);
  const suffix = query.toString();
  return request(`/api/tasks${suffix ? `?${suffix}` : ""}`);
}

export function createTask(input: {
  business?: BusinessSlug | "";
  conversationId?: string | null;
  employeeId?: string | null;
  title: string;
  notes?: string | null;
  dueAt?: string | null;
}): Promise<{ task: TaskRecord }> {
  return request("/api/tasks", { method: "POST", body: JSON.stringify(input) });
}

export function updateTask(
  taskId: string,
  change: { status?: TaskStatus; employeeId?: string | null }
): Promise<{ task: TaskRecord }> {
  return request(`/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify(change) });
}

/**
 * Follow-ups raised from inside a conversation.
 *
 * Separate from createTask on purpose: these carry no business, because the
 * server takes it from the conversation's routed organization. On a shared
 * number the client cannot know that — the inbox knows which business it is
 * FILTERED to, which is not the same thing — so it must not be asked to say.
 */
export function getConversationTasks(conversationId: string): Promise<{ tasks: TaskRecord[] }> {
  return request(`/api/conversations/${conversationId}/tasks`);
}

export function createConversationTask(
  conversationId: string,
  input: { title: string; dueAt?: string | null }
): Promise<{ task: TaskRecord }> {
  return request(`/api/conversations/${conversationId}/tasks`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ============================================================
// Appointments
// ============================================================

export type BookingStatus = "confirmed" | "cancelled" | "completed" | "no_show";

export interface BookingRecord {
  id: string;
  organizationId: string;
  businessName: string;
  businessSlug: string;
  /** Render appointment times in THIS zone, not the reader's. See the page. */
  businessTimezone: string;
  contactId: string;
  contactName: string | null;
  contactWaId: string | null;
  employeeId: string | null;
  employeeName: string | null;
  conversationId: string | null;
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
  subject: string | null;
  notes: string | null;
  /** Decided by the database clock — do not recompute from startsAt in the browser. */
  isPast: boolean;
  createdAt: string;
}

export interface BookingCounts {
  upcoming: number;
  today: number;
  unassigned: number;
}

export function getBookings(
  options: {
    business?: BusinessSlug | "";
    status?: BookingStatus | "all";
    upcoming?: boolean;
  } = {}
): Promise<{ bookings: BookingRecord[]; counts: BookingCounts }> {
  const query = new URLSearchParams();
  if (options.business) query.set("business", options.business);
  if (options.status) query.set("status", options.status);
  if (options.upcoming) query.set("upcoming", "1");
  const suffix = query.toString();
  return request(`/api/bookings${suffix ? `?${suffix}` : ""}`);
}

export function updateBooking(
  bookingId: string,
  change: { status?: BookingStatus; employeeId?: string | null }
): Promise<{ booking: BookingRecord }> {
  return request(`/api/bookings/${bookingId}`, { method: "PATCH", body: JSON.stringify(change) });
}

/** Appointments that came out of one conversation, cancellations included. */
export function getConversationBookings(
  conversationId: string
): Promise<{ bookings: BookingRecord[] }> {
  return request(`/api/conversations/${conversationId}/bookings`);
}

// ============================================================
// Forecasts (F11 Predictive BI)
// ============================================================

export type ForecastMetric = "conversations" | "escalated";

/**
 * Why a metric cannot be forecast, and what the method scored when it could.
 *
 * `blockedBecause` is the field this screen was designed around rather than a
 * fallback. Most businesses here have no customers, so a refusal is the normal
 * response and needs to read as an answer.
 */
export interface MetricReadiness {
  metric: ForecastMetric;
  label: string;
  historyDays: number;
  activeDays: number;
  blockedBecause: string | null;
  /** The method marked against this business's own past. Null when blocked. */
  backtest: {
    days: number;
    methodMae: number;
    baselineMae: number;
    beatsBaseline: boolean;
  } | null;
}

export interface ForecastStatus {
  lastCompleteDay: string | null;
  horizonDays: number;
  metrics: MetricReadiness[];
}

export interface StoredForecast {
  metric: ForecastMetric;
  targetDay: string;
  horizonDays: number;
  predicted: number;
  intervalLow: number;
  intervalHigh: number;
  /** What "the same weekday last week" said at the same moment. */
  baseline: number;
  historyDays: number;
  madeAt: string;
}

export interface ScoredForecast extends StoredForecast {
  actual: number;
  error: number;
  baselineError: number;
}

/**
 * How the claims actually committed to in advance have turned out.
 *
 * Never totalled across horizons — a claim made overnight and one made six days
 * out are different claims, and averaging them produces a figure that improves
 * whenever the job runs late.
 */
export interface ForecastAccuracy {
  metric: ForecastMetric;
  horizonDays: number;
  scored: number;
  methodMae: number;
  baselineMae: number;
  beatsBaseline: boolean;
  insideInterval: number;
  publishable: boolean;
}

export function getForecast(orgSlug: BusinessSlug): Promise<{
  status: ForecastStatus;
  upcoming: StoredForecast[];
  accuracy: ForecastAccuracy[];
  recent: ScoredForecast[];
}> {
  return request(`/api/organizations/${orgSlug}/forecast`);
}

export function refreshForecast(orgSlug: BusinessSlug): Promise<{
  scored: number;
  written: number;
  refusedAsBackdated: number;
  blocked: number;
}> {
  return request(`/api/organizations/${orgSlug}/forecast/refresh`, { method: "POST" });
}

// ============================================================
// Header: search, and the signed-in account
// ============================================================

export interface SearchHit {
  kind: "contact" | "task";
  id: string;
  title: string;
  detail: string | null;
  businessName: string;
  businessSlug: string;
  href: string;
}

export function searchAll(term: string): Promise<{ hits: SearchHit[]; term: string }> {
  return request(`/api/search?q=${encodeURIComponent(term)}`);
}

export interface Me {
  email: string;
  role: "operator" | "employee";
  fullName: string | null;
  employeeCode?: string;
  businessName: string | null;
  businessSlug: string | null;
  whatsappNumber: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
  /** False for operators — there is no operator profile to change. */
  editable: boolean;
}

export function getMe(): Promise<Me> {
  return request("/api/me");
}

export function updateMe(input: {
  fullName?: string;
  whatsappNumber?: string | null;
  avatarUrl?: string | null;
}): Promise<{ ok: true }> {
  return request("/api/me", { method: "PATCH", body: JSON.stringify(input) });
}
