import { REAL_ESTATE_WORKFLOW } from "./real-estate.js";
import type { Workflow } from "./types.js";

export * from "./types.js";
export * from "./real-estate.js";
export * from "./status.js";
export * from "./buckets.js";

/**
 * Which businesses have a workflow drawn (2 Nov 2026): only SFS International,
 * whose boss drew it. This decides the staff sidebar item, the Business HQ
 * link and the page's business switcher.
 */
const REGISTRY: Record<string, Workflow> = {
  "sfs-international": REAL_ESTATE_WORKFLOW,
};

export const BUSINESSES_WITH_WORKFLOW: readonly string[] = Object.keys(REGISTRY);

export function workflowFor(slug: string): Workflow | null {
  return REGISTRY[slug] ?? null;
}
