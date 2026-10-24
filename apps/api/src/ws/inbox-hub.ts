import type { ServerType } from "@hono/node-server";
import { WebSocketServer, WebSocket } from "ws";
import type { InboxSocketEvent } from "@nexus/shared";
import { conversationViewers, conversationVisibleTo } from "@nexus/db";
import { subscribeToInboxEvents } from "../lib/pubsub.js";
import { subscribeToTeamEvents, type TeamEvent } from "../lib/team-events.js";
import { verifySessionToken, readCookie, SESSION_COOKIE } from "../lib/session.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

/**
 * Who is listening, decided from the SESSION (22 Oct 2026).
 *
 * The hub used to trust a client-chosen ?org, and with none it sent every
 * business's messages to whoever was signed in. A staff member is now pinned to
 * their own business and to the conversations that are theirs; only the admin
 * may watch one business (?org) or all of them.
 */
interface Client {
  socket: WebSocket;
  /** Null only for the admin watching every business. */
  organizationSlug: string | null;
  /** Set for a staff member: they receive events for their own conversations only. */
  employeeId: string | null;
  /**
   * Which stream this socket asked for (24 Oct 2026): the inbox at /ws, team
   * chat at /ws/team. Kept apart so a team message never rides the inbox
   * stream, nor a customer's message the team one.
   */
  stream: "inbox" | "team";
}

const WS_PATH = "/ws";
const TEAM_PATH = "/ws/team";

/**
 * Attaches the Unified Inbox WebSocket endpoint to the API's HTTP server and
 * bridges Redis-published inbox events (see lib/pubsub.ts) out to connected
 * browser clients, filtered by the `org` query param each client connects
 * with (?org=zipicka).
 */
export function attachInboxWebSocketServer(httpServer: ServerType): () => void {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<Client>();

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "", "http://internal");
    if (url.pathname !== WS_PATH && url.pathname !== TEAM_PATH) {
      socket.destroy();
      return;
    }

    // This socket streams live customer messages, so it needs the same
    // authentication as the REST routes. Browsers cannot set headers on a
    // WebSocket handshake, but they DO send cookies — which is exactly the
    // credential the operator session already uses.
    void (async () => {
      const token = readCookie(request.headers.cookie, SESSION_COOKIE);
      const session = await verifySessionToken(token, env.sessionSecret);
      if (!session) {
        logger.warn("Rejected unauthenticated WebSocket upgrade on the inbox stream");
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        const stream = url.pathname === TEAM_PATH ? "team" : "inbox";
        const client: Client =
          session.role === "operator"
            ? { socket: ws, organizationSlug: url.searchParams.get("org"), employeeId: null, stream }
            : { socket: ws, organizationSlug: session.organizationSlug ?? "", employeeId: session.employeeId ?? "", stream };
        clients.add(client);
        ws.on("close", () => clients.delete(client));
        ws.on("error", () => clients.delete(client));
      });
    })();
  });

  const unsubscribe = subscribeToInboxEvents((event: InboxSocketEvent) => {
    void (async () => {
      const payload = JSON.stringify(event);
      const listening = [...clients].filter(
        (client) =>
          client.stream !== "team" &&
          (!client.organizationSlug || client.organizationSlug === event.organizationSlug)
      );
      // Asked once per event, and only when a staff member is listening.
      const viewers = listening.some((client) => client.employeeId)
        ? await conversationViewers(event.conversationId).catch(() => null)
        : null;
      for (const client of listening) {
        if (client.employeeId && !(viewers && conversationVisibleTo(viewers, client.employeeId))) continue;
        if (client.socket.readyState === WebSocket.OPEN) client.socket.send(payload);
      }
    })();
  });

  // TEAM CHAT. A staff socket hears its own business's room and the direct
  // chats it is one of the two people in; the admin hears every business, or
  // the one named with ?org.
  const unsubscribeTeam = subscribeToTeamEvents((event: TeamEvent) => {
    const payload = JSON.stringify(event);
    for (const client of clients) {
      if (client.stream !== "inbox" && hearsTeamEvent(client, event) && client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(payload);
      }
    }
  });

  logger.info(`Unified Inbox WebSocket endpoint attached at ${WS_PATH} (team chat at ${TEAM_PATH})`);

  return () => {
    unsubscribe();
    unsubscribeTeam();
    wss.close();
  };
}

function hearsTeamEvent(client: Client, event: TeamEvent): boolean {
  if (!client.employeeId) return !client.organizationSlug || client.organizationSlug === event.organizationSlug;
  return (
    client.organizationSlug === event.organizationSlug &&
    (event.kind === "room" || event.members.includes(client.employeeId))
  );
}
