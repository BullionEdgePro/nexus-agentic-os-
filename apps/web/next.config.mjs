import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Produces a self-contained .next/standalone build (deps pruned to only
  // what's actually imported) — keeps the production Docker image small
  // instead of shipping the full monorepo node_modules.
  output: "standalone",
  experimental: {
    // npm workspaces hoist node_modules to the monorepo root, not apps/web —
    // without this, Next's file tracer mis-resolves the workspace root and
    // silently drops hoisted deps from the standalone build. (Next 15+
    // stabilizes this as a top-level option; on Next 14 it's experimental.)
    outputFileTracingRoot: join(here, "..", ".."),
  },
};

export default nextConfig;
