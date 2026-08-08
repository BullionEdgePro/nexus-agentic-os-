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
export function takeToOwnWhatsApp(
  conversationId: string,
  employeeId: string
): Promise<DirectContact & { aiPaused: boolean }> {
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
