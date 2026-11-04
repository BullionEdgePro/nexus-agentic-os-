import Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig, BusinessSlug, InboundMessageEvent } from "@nexus/shared";
import { isolated } from "@nexus/db";
import type { AgentReplyResult, ConversationTurn, DomainAgent, ToolContext } from "./types.js";
import { defaultToolRegistry } from "./tools/registry.js";

let client: Anthropic | undefined;
function getClient(): Anthropic {
  // Bounded (audit, 4 Nov 2026): the SDK's default is ten minutes and two
  // retries, while the customer's lock lasts 90 seconds -- a hung call held a
  // worker and a database connection, and the customer waited half an hour.
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 30_000, maxRetries: 1 });
  return client;
}

const MAX_TOOL_ITERATIONS = 4;

/**
 * Generic Business Agent: one Anthropic-backed conversational agent per
 * organization, configured entirely by an agent_configs row (system prompt,
 * model, tool allowlist, RAG collection). Business-specific behavior comes
 * from the row, not from subclassing.
 */
export class AnthropicDomainAgent implements DomainAgent {
  constructor(
    public readonly config: AgentConfig,
    private readonly businessSlug: BusinessSlug,
    /**
     * Present when this agent is an employee's twin rather than the org agent.
     *
     * Carried over from the Gemini agent when the reply path moved to
     * Anthropic. It is not cosmetic: it reaches the tool context and scopes
     * knowledge retrieval to tenant-wide sources PLUS this employee's own.
     * Omitting it compiles, runs, and quietly answers every twin from the
     * tenant default — an employee's own SOPs would simply stop being found,
     * with no error and a plausible-looking reply.
     */
    private readonly employeeId: string | null = null
  ) {}

  async respond(
    event: InboundMessageEvent,
    history: ConversationTurn[]
  ): Promise<AgentReplyResult> {
    const anthropic = getClient();
    const tools = defaultToolRegistry.resolve(this.config.tools);
    const toolCalls: AgentReplyResult["toolCalls"] = [];
    const ctx: ToolContext = {
      organizationId: event.organizationId,
      businessSlug: this.businessSlug,
      contactWaId: event.contactWaId,
      employeeId: this.employeeId,
      contactId: event.contactId ?? null,
      conversationId: event.conversationId ?? null,
    };

    const messages: Anthropic.MessageParam[] = [
      ...history.map((turn) => ({ role: turn.role, content: turn.content }) as Anthropic.MessageParam),
      { role: "user", content: event.text },
    ];

    let usage = { inputTokens: 0, outputTokens: 0 };

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const response = await anthropic.messages.create({
        model: this.config.model,
        max_tokens: 1024,
        system: this.config.systemPrompt,
        messages,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
        })),
      });

      usage = {
        inputTokens: usage.inputTokens + response.usage.input_tokens,
        outputTokens: usage.outputTokens + response.usage.output_tokens,
      };

      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );

      if (toolUseBlocks.length === 0) {
        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        return { text, toolCalls, usage };
      }

      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        const tool = defaultToolRegistry.get(block.name);
        let output: unknown;
        let isError = false;
        try {
          if (!tool) throw new Error(`Tool "${block.name}" is not registered`);
          // Isolated (caught-error audit, 3 Nov 2026): a tool that swallowed a database
          // error left the reply's transaction refusing everything after it.
          output = await isolated(() => tool.handler(block.input as Record<string, unknown>, ctx));
        } catch (err) {
          isError = true;
          output = err instanceof Error ? err.message : String(err);
        }
        toolCalls.push({ name: block.name, input: block.input as Record<string, unknown>, output });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: typeof output === "string" ? output : JSON.stringify(output),
          is_error: isError,
        });
      }
      messages.push({ role: "user", content: toolResults });
    }

    // A failure, not a reply (audit, 4 Nov 2026). This used to send "a human
    // will follow up shortly" as an ordinary answer: no handover, nobody told,
    // and possibly just after a booking was made. Thrown, the reply path sends
    // its fallback and hands over only when somebody can take it.
    throw new Error(
      `The agent used all ${MAX_TOOL_ITERATIONS} tool rounds without a reply (${toolCalls.map((call) => call.name).join(", ")})`
    );
  }
}
