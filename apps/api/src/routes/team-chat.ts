import { Hono, type Context } from "hono";
import {
  conversationViewers,
  conversationVisibleTo,
  directPair,
  ensureRoom,
  findConversationById,
  findEmployeeById,
  findOrganizationById,
  findOrganizationBySlug,
  findThread,
  getConversationRouting,
  getOrCreateDirect,
  lastReadBy,
  listEmployees,
  listOrganizations,
  listTeamMessages,
  listThreadSummaries,
  markTeamRead,
  postTeamMessage,
  readerKey,
  removeTeamMessage,
  setConversationCollaborators,
  sharedConversationCards,
  teamAccess,
  teamUnread,
  withTenant,
  type TeamMessage,
  type TeamThread,
  type TeamViewer,
} from "@nexus/db";
import { resolvePresence } from "@nexus/employees";
import type { Employee } from "@nexus/shared";
import type { SessionScope } from "../lib/session.js";
import { publishTeamEvent, type TeamEvent } from "../lib/team-events.js";
import { logger } from "../lib/logger.js";

/**
 * Team chat — staff of one business talking to each other (24 Oct 2026).
 *
 * Mounted flat at /api/team-chat, so no :slug reaches the tenant middleware
 * and the request arrives cross-tenant. Every handler therefore settles WHO is
 * asking and WHICH business first, and runs its database work inside
 * withTenant for that business — the same shape as /api/tasks. Refusals are
 * 404, like every other private thing in Nexus.
 *
 * Spec: docs/superpowers/specs/2026-10-24-team-chat-design.md
 */
export const teamChatRoute = new Hono();

type Who =
  | { role: "staff"; viewer: Extract<TeamViewer, { kind: "staff" }>; name: string; organizationId: string }
  | { role: "admin"; viewer: Extract<TeamViewer, { kind: "admin" }>; name: string };

const NOT_FOUND = { error: "Not found" } as const;

/**
 * The caller, re-read on every request: a staff member the admin removed is
 * refused at once, not when their session runs out.
 */
async function viewerOf(c: Context): Promise<Who | null> {
  const scope = c.get("scope") as SessionScope | undefined;
  if (!scope) return null;
  if (scope.role === "operator") {
    const adminId = scope.adminId ?? scope.sub;
    return { role: "admin", viewer: { kind: "admin", adminId, name: "Admin" }, name: "Admin" };
  }
  const { employeeId, organizationId } = scope;
  if (!employeeId || !organizationId) return null;
  const employee = await withTenant(organizationId, () => findEmployeeById(employeeId));
  if (!employee || !employee.isActive || employee.organizationId !== organizationId) return null;
  return {
    role: "staff",
    viewer: { kind: "staff", employeeId: employee.id, organizationId },
    name: employee.fullName,
    organizationId,
  };
}

/** A staff member's own business; the admin names one with ?business=<slug>. */
async function businessFor(c: Context, who: Who): Promise<string | null> {
  if (who.role === "staff") return who.organizationId;
  const slug = c.req.query("business");
  if (!slug) return null;
  const organization = await findOrganizationBySlug(slug);
  return organization?.id ?? null;
}

/** A thread the caller may at least read, or null. */
async function readableThread(who: Who, id: string): Promise<TeamThread | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const thread = await findThread(id);
  if (!thread || !teamAccess(thread, who.viewer).read) return null;
  return thread;
}

/**
 * The people a message may mention: active staff of the thread's business —
 * in a direct chat only its two members — and never the writer.
 */
function validMentions(raw: unknown, thread: TeamThread, employees: Employee[], self: string | null): string[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(
    employees
      .filter(
        (e) =>
          e.isActive &&
          e.organizationId === thread.organizationId &&
          (thread.kind === "room" || e.id === thread.memberA || e.id === thread.memberB)
      )
      .map((e) => e.id)
  );
  const ids = raw.filter((id): id is string => typeof id === "string" && allowed.has(id) && id !== self);
  return [...new Set(ids)].slice(0, 20);
}

async function eventFor(thread: TeamThread, type: TeamEvent["type"], extra: Partial<TeamEvent>): Promise<TeamEvent> {
  const organization = await findOrganizationById(thread.organizationId);
  return {
    type,
    organizationId: thread.organizationId,
    organizationSlug: organization?.slug ?? "",
    threadId: thread.id,
    kind: thread.kind,
    members: thread.kind === "direct" ? [thread.memberA!, thread.memberB!] : [],
    ...extra,
  };
}

/** Saved is what counts; a failed publish is logged and the screens re-read. */
async function publish(event: TeamEvent): Promise<void> {
  try {
    await publishTeamEvent(event);
  } catch (err) {
    logger.warn({ err, threadId: event.threadId }, "Team chat event could not be published");
  }
}

/** Messages with the hand-over card resolved (customer name and channel). */
async function withCards(messages: TeamMessage[]) {
  const ids = [...new Set(messages.map((m) => m.sharedConversationId).filter((id): id is string => !!id))];
  const cards = await sharedConversationCards(ids);
  return messages.map((m) => {
    const card = m.sharedConversationId ? cards.get(m.sharedConversationId) : undefined;
    return { ...m, share: card && m.sharedConversationId ? { conversationId: m.sharedConversationId, ...card } : null };
  });
}

/**
 * Belt and braces for the id routes: on top of teamAccess, a staff member's
 * thread must belong to their own business, compared against the session
 * itself (the repo's rule for every route that takes a bare id).
 */
function sameBusiness(c: Context, organizationId: string): boolean {
  const scope = c.get("scope") as SessionScope | undefined;
  if (!scope) return false;
  return scope.role === "operator" || scope.organizationId === organizationId;
}

teamChatRoute.get("/threads", async (c) => {
  const who = await viewerOf(c);
  if (!who) return c.json(NOT_FOUND, 404);
  const organizationId = await businessFor(c, who);
  if (!organizationId) return c.json(NOT_FOUND, 404);

  const [threads, employees] = await withTenant(organizationId, async () => [
    await listThreadSummaries(organizationId, who.viewer),
    await listEmployees(organizationId),
  ] as const);
  const organization = await findOrganizationById(organizationId);
  const me = who.role === "staff" ? who.viewer.employeeId : null;
  const now = new Date();

  return c.json({
    business: { slug: organization?.slug ?? "", name: organization?.name ?? "" },
    me: { employeeId: me, isAdmin: who.role === "admin", name: who.name },
    threads,
    colleagues: employees
      .filter((e) => e.isActive && e.id !== me)
      .map((e) => ({
        id: e.id,
        fullName: e.fullName,
        jobTitle: e.jobTitle ?? null,
        avatarUrl: e.avatarUrl ?? null,
        onShift: resolvePresence(e, now).status !== "offline",
      })),
  });
});

teamChatRoute.post("/direct", async (c) => {
  const who = await viewerOf(c);
  if (!who || who.role !== "staff") return c.json(NOT_FOUND, 404);
  const body = (await c.req.json().catch(() => null)) as { employeeId?: unknown } | null;
  const colleagueId = typeof body?.employeeId === "string" ? body.employeeId : "";
  if (!/^[0-9a-f-]{36}$/i.test(colleagueId)) return c.json(NOT_FOUND, 404);

  const colleague = await withTenant(who.organizationId, () => findEmployeeById(colleagueId));
  // Only an active colleague of the SAME business, and never yourself.
  if (
    !colleague ||
    colleague.organizationId !== who.organizationId ||
    !colleague.isActive ||
    colleague.id === who.viewer.employeeId
  ) {
    return c.json(NOT_FOUND, 404);
  }
  const [a, b] = directPair(who.viewer.employeeId, colleague.id);
  const thread = await withTenant(who.organizationId, () => getOrCreateDirect(who.organizationId, a, b));
  return c.json({ thread });
});

teamChatRoute.get("/threads/:id/messages", async (c) => {
  const who = await viewerOf(c);
  if (!who) return c.json(NOT_FOUND, 404);
  const thread = await readableThread(who, c.req.param("id"));
  const scope = c.get("scope") as SessionScope | undefined;
  if (!thread || !scope || (scope.role !== "operator" && !sameBusiness(c, thread.organizationId))) {
    return c.json(NOT_FOUND, 404);
  }

  const beforeRaw = c.req.query("before");
  const before = beforeRaw && !Number.isNaN(Date.parse(beforeRaw)) ? new Date(beforeRaw).toISOString() : null;
  const limit = Number(c.req.query("limit") ?? 50) || 50;

  const me = who.role === "staff" ? who.viewer.employeeId : null;
  const other = thread.kind === "direct" && me ? (thread.memberA === me ? thread.memberB : thread.memberA) : null;
  const [messages, seenByOther] = await withTenant(thread.organizationId, async () => [
    await listTeamMessages(thread.id, before, limit),
    other ? await lastReadBy(thread.id, other) : null,
  ] as const);

  return c.json({
    thread,
    canPost: teamAccess(thread, who.viewer).post,
    seenByOther,
    messages: await withCards(messages),
  });
});

teamChatRoute.post("/threads/:id/messages", async (c) => {
  const who = await viewerOf(c);
  if (!who) return c.json(NOT_FOUND, 404);
  const thread = await readableThread(who, c.req.param("id"));
  const scope = c.get("scope") as SessionScope | undefined;
  if (!thread || !scope || (scope.role !== "operator" && !sameBusiness(c, thread.organizationId))) {
    return c.json(NOT_FOUND, 404);
  }
  const access = teamAccess(thread, who.viewer);
  // The admin reads a direct chat between two staff; it is not theirs to write in.
  if (!access.post) return c.json(NOT_FOUND, 404);

  const input = (await c.req.json().catch(() => null)) as {
    clientId?: unknown;
    body?: unknown;
    mentions?: unknown;
    shareConversationId?: unknown;
  } | null;
  const clientId = typeof input?.clientId === "string" ? input.clientId.trim().slice(0, 80) : "";
  const text = typeof input?.body === "string" ? input.body.trim() : "";
  if (!clientId) return c.json({ error: "This message has no id; reload the page and send it again." }, 400);
  if (!text) return c.json({ error: "Write a message first." }, 400);
  if (text.length > 4000) return c.json({ error: "That message is too long (4000 characters at most)." }, 400);

  const me = who.role === "staff" ? who.viewer.employeeId : null;
  const employees = await withTenant(thread.organizationId, () => listEmployees(thread.organizationId));
  const mentions = validMentions(input?.mentions, thread, employees, me);

  // HANDING OVER A CUSTOMER. Only in a direct chat, only by a staff member who
  // can see that customer's chat, and only a chat of this business. Sending it
  // adds the colleague to the chat — said on screen before it is sent.
  let share: { conversationId: string; addCollaborator: string | null; collaborators: string[] } | null = null;
  const shareId = typeof input?.shareConversationId === "string" ? input.shareConversationId : null;
  if (shareId) {
    if (who.role !== "staff" || thread.kind !== "direct") {
      return c.json({ error: "A customer chat can be handed over only in a direct chat." }, 400);
    }
    const conversation = /^[0-9a-f-]{36}$/i.test(shareId) ? await findConversationById(shareId) : null;
    const routing = conversation ? await getConversationRouting(shareId).catch(() => null) : null;
    const serving = routing?.routedOrganizationId ?? conversation?.organizationId ?? null;
    const viewers = conversation ? await conversationViewers(shareId) : null;
    if (!conversation || serving !== thread.organizationId || !viewers || !conversationVisibleTo(viewers, who.viewer.employeeId)) {
      return c.json(NOT_FOUND, 404);
    }
    const colleague = thread.memberA === me ? thread.memberB! : thread.memberA!;
    share = {
      conversationId: shareId,
      addCollaborator: conversationVisibleTo(viewers, colleague) ? null : colleague,
      collaborators: viewers.collaboratorIds,
    };
  }

  const { message, created } = await withTenant(thread.organizationId, async () => {
    const saved = await postTeamMessage({
      thread,
      authorEmployeeId: me,
      authorName: who.name,
      authorIsAdmin: who.role === "admin",
      body: text,
      clientId,
      mentions,
      sharedConversationId: share?.conversationId ?? null,
    });
    await markTeamRead(thread, readerKey(who.viewer));
    return saved;
  });

  if (created && share?.addCollaborator) {
    await setConversationCollaborators(share.conversationId, [...share.collaborators, share.addCollaborator]);
  }
  const [shaped] = await withCards([message]);
  if (created) await publish(await eventFor(thread, "team_message", { message: shaped }));
  return c.json({ message: shaped }, created ? 201 : 200);
});

teamChatRoute.post("/threads/:id/read", async (c) => {
  const who = await viewerOf(c);
  if (!who) return c.json(NOT_FOUND, 404);
  const thread = await readableThread(who, c.req.param("id"));
  const scope = c.get("scope") as SessionScope | undefined;
  if (!thread || !scope || (scope.role !== "operator" && !sameBusiness(c, thread.organizationId))) {
    return c.json(NOT_FOUND, 404);
  }
  const reader = readerKey(who.viewer);
  await withTenant(thread.organizationId, () => markTeamRead(thread, reader));
  await publish(await eventFor(thread, "team_read", { reader }));
  return c.json({ ok: true });
});

teamChatRoute.delete("/messages/:id", async (c) => {
  const who = await viewerOf(c);
  if (!who || who.role !== "staff") return c.json(NOT_FOUND, 404);
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return c.json(NOT_FOUND, 404);
  const scope = c.get("scope") as SessionScope | undefined;
  if (!scope || scope.role !== "employee" || scope.organizationId !== who.organizationId) return c.json(NOT_FOUND, 404);
  const removed = await withTenant(who.organizationId, () => removeTeamMessage(id, who.viewer.employeeId));
  if (!removed) return c.json(NOT_FOUND, 404);
  const thread = await findThread(removed.threadId);
  if (thread) await publish(await eventFor(thread, "team_message_removed", { message: { ...removed } }));
  return c.json({ message: removed });
});

teamChatRoute.get("/unread", async (c) => {
  const who = await viewerOf(c);
  if (!who) return c.json(NOT_FOUND, 404);
  if (who.role === "staff") {
    return c.json(await withTenant(who.organizationId, () => teamUnread(who.organizationId, who.viewer)));
  }
  // The admin's badge spans every business.
  let unread = 0;
  let mentioned = 0;
  for (const organization of await listOrganizations()) {
    const counts = await withTenant(organization.id, () => teamUnread(organization.id, who.viewer));
    unread += counts.unread;
    mentioned += counts.mentioned;
  }
  return c.json({ unread, mentioned });
});

// The room exists before anyone writes in it, so the first visit is never empty
// of a place to talk.
export async function prepareTeamRoom(organizationId: string): Promise<void> {
  await withTenant(organizationId, () => ensureRoom(organizationId));
}
