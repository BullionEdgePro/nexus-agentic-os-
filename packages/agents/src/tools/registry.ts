import type { ToolDefinition } from "../types.js";

/**
 * Central registry of function-calling tools available to Domain Agents.
 * Each agent_configs.tools entry (see schema.sql) is a name looked up here.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  resolve(names: string[]): ToolDefinition[] {
    return names
      .map((name) => this.tools.get(name))
      .filter((tool): tool is ToolDefinition => Boolean(tool));
  }
}

export const defaultToolRegistry = new ToolRegistry();
