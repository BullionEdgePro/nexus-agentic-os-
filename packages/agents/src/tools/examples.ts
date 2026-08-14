import type { ToolDefinition } from "../types.js";
import { defaultToolRegistry } from "./registry.js";

// Domain tools available to the agent swarm. check_inventory is wired to
// Shopify's Storefront API (Zipicka) using a public storefront access token —
// far simpler to provision than an Admin API token, and read-only by design.
//
// book_appointment used to live here as a stub. It is now real, and moved to
// ./bookings.ts alongside check_availability, because the two only make sense
// together: the first offers times computed from staff rotas and the live diary,
// the second takes one of them.

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";
const INVENTORY_LOOKUP_TIMEOUT_MS = 8000;

interface StorefrontVariantNode {
  title: string;
  sku: string | null;
  availableForSale: boolean;
  quantityAvailable: number | null;
}

/**
 * check_inventory: live stock lookup against the Shopify Storefront API.
 *
 * Uses a public Storefront access token (X-Shopify-Storefront-Access-Token) —
 * these are read-only, meant to be exposed in storefronts, and easy to mint
 * without the Admin API / CLI. Reports in-stock/out-of-stock via
 * `availableForSale`, plus an exact `quantityAvailable` when the store exposes
 * it (it can be null, which is fine).
 *
 * Fails *soft* on every error path — unconfigured store, network/HTTP error,
 * timeout, or no match all return a structured "can't confirm" result rather
 * than throwing, so the agent escalates to a human instead of inventing stock.
 */
export const checkInventoryTool: ToolDefinition = {
  name: "check_inventory",
  description: "Look up current stock availability for a product by name or SKU.",
  inputSchema: {
    type: "object",
    properties: {
      sku: { type: "string", description: "Product name or SKU to look up" },
    },
    required: ["sku"],
  },
  handler: async (input, ctx) => {
    const query = String(input.sku ?? "").trim();
    if (!query) return { found: false, note: "No product name or SKU was provided." };

    // Inventory is currently wired for the Zipicka storefront only.
    if (ctx.businessSlug !== "zipicka") {
      return {
        found: false,
        note: "Live inventory lookup isn't configured for this business; a human can confirm stock.",
      };
    }

    const domain = process.env.SHOPIFY_STORE_DOMAIN;
    const token = process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN;
    if (!domain || !token) {
      return {
        found: false,
        note: "The inventory service isn't connected yet; a specialist can confirm current stock.",
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INVENTORY_LOOKUP_TIMEOUT_MS);
    try {
      const response = await fetch(`https://${domain}/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Storefront-Access-Token": token,
        },
        signal: controller.signal,
        body: JSON.stringify({
          query: `query InventoryLookup($q: String!) {
            products(first: 5, query: $q) {
              edges {
                node {
                  title
                  variants(first: 10) {
                    edges { node { title sku availableForSale quantityAvailable } }
                  }
                }
              }
            }
          }`,
          variables: { q: query },
        }),
      });

      if (!response.ok) {
        return {
          found: false,
          note: `Inventory service returned an error (HTTP ${response.status}); a human can confirm stock.`,
        };
      }

      const data = (await response.json()) as {
        data?: {
          products?: {
            edges?: Array<{
              node: { title: string; variants: { edges: Array<{ node: StorefrontVariantNode }> } };
            }>;
          };
        };
      };

      const productEdges = data.data?.products?.edges ?? [];
      const matches = productEdges.flatMap(({ node: product }) =>
        (product.variants.edges ?? []).map(({ node: variant }) => ({
          product: product.title,
          variant: variant.title,
          sku: variant.sku,
          inStock: variant.availableForSale,
          quantity: variant.quantityAvailable, // may be null if the store doesn't expose it
        }))
      );

      if (matches.length === 0) {
        return { found: false, note: `No product matching "${query}" was found in the catalog.` };
      }
      return { found: true, matches };
    } catch (err) {
      const reason = err instanceof Error && err.name === "AbortError" ? "timed out" : "failed";
      return { found: false, note: `Inventory lookup ${reason}; a human can confirm stock.` };
    } finally {
      clearTimeout(timeout);
    }
  },
};

defaultToolRegistry.register(checkInventoryTool);
