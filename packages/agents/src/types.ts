import type { AgentConfig, BusinessSlug, InboundMessageEvent } from "@nexus/shared";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema, passed straight through to the model
  handler: (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  organizationId: string;
  businessSlug: BusinessSlug;
  contactWaId: string;
}

export interface AgentReplyResult {
  text: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; output: unknown }>;
  usage: { inputTokens: number; outputTokens: number };
}

export interface DomainAgent {
  config: AgentConfig;
  respond(event: InboundMessageEvent, history: ConversationTurn[]): Promise<AgentReplyResult>;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}
