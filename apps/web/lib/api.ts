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

export function setHandoff(
  conversationId: string,
  isHumanHandoff: boolean
): Promise<{ isHumanHandoff: boolean }> {
  return request(`/api/conversations/${conversationId}/handoff`, {
    method: "PATCH",
    body: JSON.stringify({ isHumanHandoff }),
  });
}
