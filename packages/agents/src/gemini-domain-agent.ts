import { GoogleGenAI, createPartFromFunctionResponse } from "@google/genai";
import type { Content } from "@google/genai";
import type { AgentConfig, BusinessSlug, InboundMessageEvent } from "@nexus/shared";
import type { AgentReplyResult, ConversationTurn, DomainAgent, ToolContext } from "./types.js";
import { defaultToolRegistry } from "./tools/registry.js";

let client: GoogleGenAI | undefined;
function getClient(): GoogleGenAI {
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

const MAX_TOOL_ITERATIONS = 4;

/**
 * Generic Business Agent, Gemini-backed variant: same DomainAgent contract
 * and per-tenant config as AnthropicDomainAgent, calling the Gemini API
 * (free tier on Flash-family models) instead. Swapped in at the switchboard
 * level — see switchboard.ts.
 */
export class GeminiDomainAgent implements DomainAgent {
  constructor(
    public readonly config: AgentConfig,
    private readonly businessSlug: BusinessSlug,
    /** Present when this agent is an employee's twin rather than the org agent. */
    private readonly employeeId: string | null = null
  ) {}

  async respond(
    event: InboundMessageEvent,
    history: ConversationTurn[]
  ): Promise<AgentReplyResult> {
    const ai = getClient();
    const tools = defaultToolRegistry.resolve(this.config.tools);
    const toolCalls: AgentReplyResult["toolCalls"] = [];
    const ctx: ToolContext = {
      organizationId: event.organizationId,
      businessSlug: this.businessSlug,
      contactWaId: event.contactWaId,
      employeeId: this.employeeId,
    };

    const contents: Content[] = [
      ...history.map(
        (turn) =>
          ({
            role: turn.role === "assistant" ? "model" : "user",
            parts: [{ text: turn.content }],
          }) as Content
      ),
      { role: "user", parts: [{ text: event.text }] },
    ];

    const geminiTools = [
      {
        functionDeclarations: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parametersJsonSchema: tool.inputSchema,
        })),
      },
    ];

    let usage = { inputTokens: 0, outputTokens: 0 };

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const response = await ai.models.generateContent({
        model: this.config.model,
        contents,
        config: {
          systemInstruction: this.config.systemPrompt,
          tools: geminiTools,
          maxOutputTokens: 1024,
        },
      });

      usage = {
        inputTokens: usage.inputTokens + (response.usageMetadata?.promptTokenCount ?? 0),
        outputTokens: usage.outputTokens + (response.usageMetadata?.candidatesTokenCount ?? 0),
      };

      const functionCalls = response.functionCalls ?? [];

      if (functionCalls.length === 0) {
        return { text: response.text ?? "", toolCalls, usage };
      }

      const modelTurn = response.candidates?.[0]?.content;
      if (modelTurn) contents.push(modelTurn);

      const responseParts = [];
      for (const call of functionCalls) {
        const tool = call.name ? defaultToolRegistry.get(call.name) : undefined;
        let output: unknown;
        let isError = false;
        try {
          if (!tool) throw new Error(`Tool "${call.name}" is not registered`);
          output = await tool.handler((call.args ?? {}) as Record<string, unknown>, ctx);
        } catch (err) {
          isError = true;
          output = err instanceof Error ? err.message : String(err);
        }
        toolCalls.push({
          name: call.name ?? "",
          input: (call.args ?? {}) as Record<string, unknown>,
          output,
        });
        responseParts.push(
          createPartFromFunctionResponse(
            call.id ?? call.name ?? "",
            call.name ?? "",
            isError ? { error: output } : { output }
          )
        );
      }
      contents.push({ role: "user", parts: responseParts });
    }

    return {
      text: "I'm having trouble completing that request right now — a human will follow up shortly.",
      toolCalls,
      usage,
    };
  }
}
