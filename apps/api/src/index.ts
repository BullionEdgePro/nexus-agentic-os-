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
import { adminAuthRoute } from "./routes/admin-auth.js";
import { activityRoute } from "./routes/activity.js";
import { qualityRoute } from "./routes/quality.js";
import { linksRoute, publicLinksRoute } from "./routes/links.js";
import { tasksRoute, conversationTasksRoute } from "./routes/tasks.js";
import { bookingsRoute, conversationBookingsRoute } from "./routes/bookings.js";
import { operatorsRoute } from "./routes/operators.js";
import { proceduresRoute } from "./routes/procedures.js";
import { catalogRoute } from "./routes/catalog.js";
import { phrasesRoute } from "./routes/phrases.js";
import { forecastsRoute } from "./routes/forecasts.js";
import { searchRoute } from "./routes/search.js";
import { meRoute } from "./routes/me.js";
import { attachInboxWebSocketServer } from "./ws/inbox-hub.js";
import { requireAuth } from "./middleware/require-auth.js";
import {
  requireTenantScope,
  requireConversationScope,
  operatorOnly,
} from "./middleware/require-tenant-scope.js";
import { logger } from "./lib/logger.js";
import { tenantContext, webhookContext } from "./middleware/tenant-context.js";

const app = new Hono();

// credentials:true is required for the browser to send the operator session
// cookie cross-origin. The app and the API share a registrable domain
// (app.example.com → api.example.com), so the cookie is same-site and a
// SameSite=Lax cookie still travels.
app.use("/api/*", cors({ origin: env.webOrigins, credentials: true }));
app.use("/auth/*", cors({ origin: env.webOrigins, credentials: true }));
// The public links endpoint carries no cookie and needs none, so it is open to
// any origin: a business's own website may well want to read it directly rather
// than have someone paste a link by hand.
app.use("/links/*", cors({ origin: "*" }));

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
// Employee activity is management information: an employee must not be able to
// read their colleagues' numbers, and on a shared platform that would mean
// every other business's staff as well.
app.use("/api/activity", operatorOnly);
app.use("/api/activity/*", operatorOnly);
app.use("/api/links", operatorOnly);
app.use("/api/quality", operatorOnly);
app.use("/api/quality/*", operatorOnly);
app.use("/api/broadcasts", operatorOnly);
app.use("/api/broadcasts/*", operatorOnly);
// The marketplace. Not because the catalogue is sensitive — it holds no
// business's data at all, by construction — but because installing a pack
// changes what every customer of that business is eventually told, and the
// screen shows what all five businesses are running side by side. That is an
// owner's decision and an owner's view, not a sales executive's.
app.use("/api/catalog", operatorOnly);
app.use("/api/catalog/*", operatorOnly);

// Every /api/* request runs inside a database tenant context — a named one for
// a single business, an explicitly-reasoned cross-tenant one otherwise. Placed
// after the authorisation checks above, because what a caller may reach is
// settled before which rows the database will return.
app.use("/api/*", tenantContext);

app.get("/health", (c) => c.json({ status: "ok" }));
app.use("/webhooks/whatsapp", webhookContext);
app.route("/webhooks/whatsapp", whatsappWebhook);
// Outside /api/*, because requireAuth guards everything under there and a
// login endpoint that needs a session cannot issue one.
app.route("/auth", employeeAuthRoute);
app.route("/auth", adminAuthRoute);
// The five customer links, unauthenticated. Outside /api/* because requireAuth
// guards everything under there, and the people who publish these links — a web
// designer, a printer, whoever runs an Instagram account — are not staff and
// will never have an operator account. See routes/links.ts for why this is
// public-facing material by definition rather than by concession.
app.route("/links", publicLinksRoute);
app.route("/api/organizations", organizationsRoute);
// Same mount point: knowledge is addressed per organization
// (/api/organizations/:slug/knowledge), and Hono composes the two routers.
app.route("/api/organizations", knowledgeRoute);
app.route("/api/organizations", employeesRoute);
// Procedural memory, addressed per organization for the same reason knowledge
// is: it is that business's own material, and mounting it here means the tenant
// context — and therefore RLS — is established by the middleware rather than by
// the handler remembering to narrow.
app.route("/api/organizations", proceduresRoute);
// Predictive BI, mounted here for the same reason as the two above and NOT
// under /api/quality, where the rest of the reporting lives: `forecasts` is a
// tenant-scoped table with an RLS policy, and this mount is what gives it a
// tenant context to enforce against. See routes/forecasts.ts.
app.route("/api/organizations", forecastsRoute);
// What this business says in its own words (045). Mounted here for the same
// reason as knowledge and procedures — it is the business's own material, its
// own staff are the people who know whether the wording fits, and the mount is
// what gives `agent_phrases` a tenant context for RLS to enforce against.
app.route("/api/organizations", phrasesRoute);
app.route("/api/conversations", conversationsRoute);
// Assignment and the personal-WhatsApp handoff hang off a conversation id,
// so they compose onto the same /api/conversations router.
app.route("/api/conversations", conversationAssignmentRoute);
app.route("/api/broadcasts", broadcastsRoute);
app.route("/api/metrics", metricsRoute);
app.route("/api/activity", activityRoute);
app.route("/api/quality", qualityRoute);
app.route("/api/links", linksRoute);
// The marketplace, mounted flat rather than under /api/organizations/:slug like
// Knowledge and Procedures. The catalogue is one shelf for the whole platform
// and the useful view of it — who is running what — spans every business, so
// there is no per-business form of this route to mount. Installs name their
// business explicitly in the request; see routes/catalog.ts for why that is the
// boundary here rather than RLS.
app.route("/api/catalog", catalogRoute);
// Not operator-only, unlike the four above it. A follow-up list is the working
// surface of the person doing the work, not management information about them,
// so employees reach it too — narrowed to their own business inside the route,
// which is where the check has to live because /api/tasks carries no :slug for
// requireTenantScope to read.
app.route("/api/tasks", tasksRoute);
// Tasks raised from inside a conversation. Composed onto the conversations
// router so requireConversationScope has already settled access.
app.route("/api/conversations", conversationTasksRoute);
// The diary. Not operator-only for the same reason follow-ups are not: the
// person who has been booked is the person who needs to see it.
app.route("/api/bookings", bookingsRoute);
app.route("/api/conversations", conversationBookingsRoute);
// Operator findings. Same shape as tasks: narrowed by role inside the handler,
// because this path has no :slug either.
app.route("/api/operators", operatorsRoute);
// Header search and the signed-in account. Both narrowed by role inside their
// handlers, because neither path carries a :slug for requireTenantScope.
app.route("/api/search", searchRoute);
app.route("/api/me", meRoute);

const server = serve({ fetch: app.fetch, port: env.apiPort }, (info) => {
  logger.info(`Nexus API listening on http://localhost:${info.port}`);
});

attachInboxWebSocketServer(server);
