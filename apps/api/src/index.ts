import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./config/env.js";
import { whatsappWebhook } from "./webhook/whatsapp.js";
import { organizationsRoute } from "./routes/organizations.js";
import { conversationsRoute } from "./routes/conversations.js";
import { broadcastsRoute } from "./routes/broadcasts.js";
import { metricsRoute } from "./routes/metrics.js";
import { attachInboxWebSocketServer } from "./ws/inbox-hub.js";
import { requireAuth } from "./middleware/require-auth.js";
import { logger } from "./lib/logger.js";

const app = new Hono();

// credentials:true is required for the browser to send the operator session
// cookie cross-origin. The app and the API share a registrable domain
// (app.example.com → api.example.com), so the cookie is same-site and a
// SameSite=Lax cookie still travels.
app.use("/api/*", cors({ origin: env.webOrigins, credentials: true }));

// Every /api/* route serves tenant data — conversations, contacts, metrics —
// so authentication is applied at the router, not per-route. A new endpoint is
// then protected by default rather than by the author remembering to add it.
app.use("/api/*", requireAuth);

app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/webhooks/whatsapp", whatsappWebhook);
app.route("/api/organizations", organizationsRoute);
app.route("/api/conversations", conversationsRoute);
app.route("/api/broadcasts", broadcastsRoute);
app.route("/api/metrics", metricsRoute);

const server = serve({ fetch: app.fetch, port: env.apiPort }, (info) => {
  logger.info(`Nexus API listening on http://localhost:${info.port}`);
});

attachInboxWebSocketServer(server);
