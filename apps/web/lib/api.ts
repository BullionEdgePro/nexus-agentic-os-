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
  sent: number;
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
  counts: { urgent: number; warn: number; info: number };
  operators: OperatorInfo[];
}> {
  return request(`/api/operators${business ? `?business=${business}` : ""}`);
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
