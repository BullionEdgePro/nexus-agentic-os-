import type { ToolDefinition } from "../types.js";
import { defaultToolRegistry } from "./registry.js";

// Example domain tools. Wire the handlers to real backends (Shopify, a
// booking calendar, etc.) per business before enabling them in an
// agent_configs.tools array.

export const checkInventoryTool: ToolDefinition = {
  name: "check_inventory",
  description: "Look up current stock quantity for a product by SKU or name.",
  inputSchema: {
    type: "object",
    properties: {
      sku: { type: "string", description: "Product SKU or name to look up" },
    },
    required: ["sku"],
  },
  handler: async (input) => {
    throw new Error(
      `check_inventory not wired to a store yet (requested sku: ${String(input.sku)})`
    );
  },
};

export const bookAppointmentTool: ToolDefinition = {
  name: "book_appointment",
  description: "Book a consultation or service appointment on the business calendar.",
  inputSchema: {
    type: "object",
    properties: {
      serviceName: { type: "string" },
      preferredTime: { type: "string", description: "ISO 8601 datetime" },
      contactName: { type: "string" },
    },
    required: ["serviceName", "preferredTime"],
  },
  handler: async (input) => {
    throw new Error(
      `book_appointment not wired to a calendar yet (requested: ${String(input.serviceName)} at ${String(input.preferredTime)})`
    );
  },
};

defaultToolRegistry.register(checkInventoryTool);
defaultToolRegistry.register(bookAppointmentTool);
