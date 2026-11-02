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
  // @nexus/shared is TypeScript source whose files import each other as
  // "./x.js" (the Node ESM style the API runs). The web used to take only types
  // from it, which compile away; the workflow audit (2 Nov 2026) takes values —
  // workflowFor in the rail, the status rules on the page — so Next compiles the
  // package and resolves "./x.js" to the ".ts" beside it.
  transpilePackages: ["@nexus/shared"],
  webpack: (config) => {
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
  experimental: {
    // npm workspaces hoist node_modules to the monorepo root, not apps/web —
    // without this, Next's file tracer mis-resolves the workspace root and
    // silently drops hoisted deps from the standalone build. (Next 15+
    // stabilizes this as a top-level option; on Next 14 it's experimental.)
    outputFileTracingRoot: join(here, "..", ".."),
  },
  // The service worker must never be served from a cache, or a fix to it
  // reaches phones days late (spec 2026-10-09-nexus-mobile-app-design.md).
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
