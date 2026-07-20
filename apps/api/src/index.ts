import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./config/env.js";
import { whatsappWebhook } from "./webhook/whatsapp.js";
import { organizationsRoute } from "./routes/organizations.js";
import { conversationsRoute } from "./routes/conversations.js";
import { broadcastsRoute } from "./routes/broadcasts.js";
import { attachInboxWebSocketServer } from "./ws/inbox-hub.js";
import { logger } from "./lib/logger.js";

const app = new Hono();

app.use("/api/*", cors({ origin: env.webOrigin }));

app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/webhooks/whatsapp", whatsappWebhook);
app.route("/api/organizations", organizationsRoute);
app.route("/api/conversations", conversationsRoute);
app.route("/api/broadcasts", broadcastsRoute);

const server = serve({ fetch: app.fetch, port: env.apiPort }, (info) => {
  logger.info(`Nexus API listening on http://localhost:${info.port}`);
});

attachInboxWebSocketServer(server);
