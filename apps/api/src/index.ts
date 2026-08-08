import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./config/env.js";
import { whatsappWebhook } from "./webhook/whatsapp.js";
import { organizationsRoute } from "./routes/organizations.js";
import { conversationsRoute } from "./routes/conversations.js";
import { broadcastsRoute } from "./routes/broadcasts.js";
import { metricsRoute } from "./routes/metrics.js";
import { knowledgeRoute } from "./routes/knowledge.js";
import { employeesRoute, conversationAssignmentRoute } from "./routes/employees.js";
import { employeeAuthRoute } from "./routes/employee-auth.js";
import { attachInboxWebSocketServer } from "./ws/inbox-hub.js";
import { requireAuth } from "./middleware/require-auth.js";
import {
  requireTenantScope,
  requireConversationScope,
  operatorOnly,
} from "./middleware/require-tenant-scope.js";
import { logger } from "./lib/logger.js";

const app = new Hono();

// credentials:true is required for the browser to send the operator session
// cookie cross-origin. The app and the API share a registrable domain
// (app.example.com → api.example.com), so the cookie is same-site and a
// SameSite=Lax cookie still travels.
app.use("/api/*", cors({ origin: env.webOrigins, credentials: true }));
app.use("/auth/*", cors({ origin: env.webOrigins, credentials: true }));

// Every /api/* route serves tenant data — conversations, contacts, metrics —
// so authentication is applied at the router, not per-route. A new endpoint is
// then protected by default rather than by the author remembering to add it.
app.use("/api/*", requireAuth);

// Authentication says WHO. These say WHAT they may reach, and they are applied
// at the mount rather than inside handlers so a new endpoint under one of these
// prefixes is scoped by default. An employee token that slipped past this would
// read another business's entire customer history, so the checks live in front
// of every tenant path rather than in the routes that remembered to ask.
app.use("/api/organizations/:slug/*", requireTenantScope);
app.use("/api/conversations/:id/*", requireConversationScope);

// Cross-tenant by definition — there is no scoped version of "every business's
// metrics", and a broadcast reaches a whole contact list at once. Employees are
// refused outright rather than served a filtered shape the UI must be trusted
// to interpret correctly.
app.use("/api/metrics/*", operatorOnly);
app.use("/api/broadcasts", operatorOnly);
app.use("/api/broadcasts/*", operatorOnly);

app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/webhooks/whatsapp", whatsappWebhook);
// Outside /api/*, because requireAuth guards everything under there and a
// login endpoint that needs a session cannot issue one.
app.route("/auth", employeeAuthRoute);
app.route("/api/organizations", organizationsRoute);
// Same mount point: knowledge is addressed per organization
// (/api/organizations/:slug/knowledge), and Hono composes the two routers.
app.route("/api/organizations", knowledgeRoute);
app.route("/api/organizations", employeesRoute);
app.route("/api/conversations", conversationsRoute);
// Assignment and the personal-WhatsApp handoff hang off a conversation id,
// so they compose onto the same /api/conversations router.
app.route("/api/conversations", conversationAssignmentRoute);
app.route("/api/broadcasts", broadcastsRoute);
app.route("/api/metrics", metricsRoute);

const server = serve({ fetch: app.fetch, port: env.apiPort }, (info) => {
  logger.info(`Nexus API listening on http://localhost:${info.port}`);
});

attachInboxWebSocketServer(server);
