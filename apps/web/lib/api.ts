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
