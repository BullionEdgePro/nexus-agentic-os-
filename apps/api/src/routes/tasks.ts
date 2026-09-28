import { Hono } from "hono";
import {
  listTasks,
  listTasksForConversation,
  countTasks,
  createTask,
  completeTask,
  setTaskStatus,
  assignTask,
  rescheduleTask,
  findOrganizationBySlug,
  findOrganizationById,
  findConversationById,
  getConversationRouting,
  type TaskStatus,
} from "@nexus/db";
import { completeText } from "@nexus/agents";
import type { SessionScope } from "../lib/session.js";
import { logger } from "../lib/logger.js";
import { describeNow, localStamp, zonedLocalToUtc } from "../lib/zoned-time.js";

/**
 * Follow-ups — the work a conversation leaves behind.
 *
 * Deliberately NOT operatorOnly, unlike activity, quality and broadcasts.
 * Those three are management information: an employee reading them learns how
 * their colleagues are performing. A follow-up list is the opposite — it is the
 * thing the person doing the work needs in front of them, and a task board only
 * the manager can see is a report, not a board.
 *
 * So the scoping is done here instead, per role:
 *   operator — every business, optionally narrowed with ?business=<slug>
 *   employee — their own business, always, whatever the query string says
 *
 * That second line is the one that matters. `/api/tasks` carries no :slug, so
 * `requireTenantScope` does not apply and the request runs in a cross-tenant
 * database context. Nothing underneath will narrow the query for us; if this
 * handler forgets, an employee reads five businesses' customer commitments and
 * the response looks entirely normal.
 */

const VALID_STATUS = new Set<string>(["open", "done", "cancelled", "all"]);

function scopeOf(c: { get: (k: string) => unknown }): SessionScope {
  // Fail closed, matching require-tenant-scope: an unrecognised caller is
  // treated as an employee of no business, which resolves to zero rows rather
  // than to every row.
  return (c.get("scope") as SessionScope | undefined) ?? { sub: "unknown", role: "employee" };
}

export const tasksRoute = new Hono();

tasksRoute.get("/", async (c) => {
  const scope = scopeOf(c);
  const status = c.req.query("status") ?? "open";
  if (!VALID_STATUS.has(status)) {
    return c.json({ error: `Unknown status "${status}".` }, 400);
  }

  let organizationId: string | null = null;

  if (scope.role === "operator") {
    const slug = c.req.query("business");
    if (slug) {
      const organization = await findOrganizationBySlug(slug);
      if (!organization) return c.json({ error: "Organization not found" }, 404);
      organizationId = organization.id;
    }
  } else {
    organizationId = scope.organizationId ?? null;
    if (!organizationId) {
      // An employee session with no business attached. Serving them the
      // unfiltered list would be a cross-tenant leak dressed as an empty
      // filter, so refuse rather than fall through to "no filter".
      logger.warn({ sub: scope.sub }, "Employee session without an organization asked for tasks");
      return c.json({ error: "Your account is not attached to a business." }, 403);
    }
  }

  // ?mine=1 narrows to the caller. Only meaningful for an employee — an
  // operator has no employee row, so for them it would filter to nothing.
  const mine = c.req.query("mine") === "1" && scope.role !== "operator";

  const [tasks, counts] = await Promise.all([
    listTasks({
      organizationId,
      employeeId: mine ? scope.employeeId ?? null : null,
      status: status as TaskStatus | "all",
    }),
    countTasks(organizationId),
  ]);

  return c.json({ tasks, counts });
});

tasksRoute.post("/", async (c) => {
  const scope = scopeOf(c);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.title !== "string") {
    return c.json({ error: "A task needs a title." }, 400);
  }

  let organizationId: string | null = null;

  // A task created without a conversation has to say which business it is for.
  // For an employee that is never a choice — it is their own, regardless of
  // what the request body claims, or one employee could file work into another
  // company's list.
  if (scope.role === "operator") {
    if (typeof body.business === "string" && body.business) {
      const organization = await findOrganizationBySlug(body.business);
      if (!organization) return c.json({ error: "Organization not found" }, 404);
      organizationId = organization.id;
    }
  } else {
    organizationId = scope.organizationId ?? null;
    if (!organizationId) return c.json({ error: "Your account is not attached to a business." }, 403);
  }

  if (!organizationId && !body.conversationId) {
    return c.json({ error: "Choose a business, or start the task from a conversation." }, 400);
  }

  try {
    const task = await createTask({
      organizationId,
      conversationId: typeof body.conversationId === "string" ? body.conversationId : null,
      contactId: typeof body.contactId === "string" ? body.contactId : null,
      employeeId: typeof body.employeeId === "string" ? body.employeeId : null,
      title: body.title,
      notes: typeof body.notes === "string" ? body.notes : null,
      dueAt: typeof body.dueAt === "string" && body.dueAt ? body.dueAt : null,
    });
    return c.json({ task }, 201);
  } catch (err) {
    // These are all operator-facing validation messages written to be read by a
    // person — an unassignable employee, an unreadable date, a missing
    // conversation. Returning 400 with the message beats a 500 that says
    // "internal error" about a form someone can fix in five seconds.
    const message = err instanceof Error ? err.message : "Could not create the task.";
    logger.warn({ err }, "Task creation refused");
    return c.json({ error: message }, 400);
  }
});

/**
 * Status changes and reassignment.
 *
 * PATCH rather than separate /complete and /reopen endpoints, because the
 * client's real question is "what should this task look like now" and the three
 * transitions share every guard.
 *
 * Note there is no DELETE. A task is the record that something was promised to
 * a customer; `cancelled` keeps that record while taking it off the live list.
 */
tasksRoute.patch("/:taskId", async (c) => {
  const scope = scopeOf(c);
  const taskId = c.req.param("taskId");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Nothing to change." }, 400);

  // The task must be one of theirs. This path takes an id and no slug, so it
  // runs cross-tenant: without this, an employee holding any task id could
  // close, cancel or reassign another business's follow-up, the row would
  // change, and the only trace would be work marked done that nobody did.
  //
  // Null for an operator, who legitimately administers all five businesses.
  let within: string | null = null;
  if (scope.role !== "operator") {
    within = scope.organizationId ?? null;
    if (!within) return c.json({ error: "Your account is not attached to a business." }, 403);
  }

  try {
    let task = null;

    if (typeof body.status === "string") {
      if (!["open", "done", "cancelled"].includes(body.status)) {
        return c.json({ error: `Unknown status "${body.status}".` }, 400);
      }
      task =
        body.status === "done"
          ? // Credit the employee who closed it. An operator has no employee row,
            // so their completion records the time and no name — see completeTask.
            await completeTask(
              taskId,
              scope.role === "operator" ? null : scope.employeeId ?? null,
              within
            )
          : await setTaskStatus(taskId, body.status as TaskStatus, within);
    }

    if ("employeeId" in body) {
      task = await assignTask(
        taskId,
        typeof body.employeeId === "string" && body.employeeId ? body.employeeId : null,
        within
      );
    }

    // Moving a follow-up, which the board does when a card is dragged between
    // its when-columns. `null` clears the date rather than being refused: a
    // commitment with no date is a state the schema allows and the list already
    // shows, and refusing to return to it would make the board a one-way ratchet.
    if ("dueAt" in body) {
      let dueAt: string | null = null;
      if (typeof body.dueAt === "string" && body.dueAt) {
        const parsed = new Date(body.dueAt);
        if (Number.isNaN(parsed.getTime())) {
          return c.json({ error: "That is not a date the calendar recognises." }, 400);
        }
        dueAt = parsed.toISOString();
      } else if (body.dueAt !== null) {
        return c.json({ error: "A due date must be a date, or null to clear it." }, 400);
      }
      task = await rescheduleTask(taskId, dueAt, within);
    }

    // Null from every branch means the row was not visible or was already in
    // the requested state. 404 covers both without telling an employee whether
    // a task id exists in another business.
    if (!task) return c.json({ error: "That task is not available to change." }, 404);
    return c.json({ task });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not update the task.";
    logger.warn({ err, taskId }, "Task update refused");
    return c.json({ error: message }, 400);
  }
});

/**
 * Tasks hanging off one conversation.
 *
 * Composed onto /api/conversations, so `requireConversationScope` already
 * decided whether this caller may see this conversation at all — including the
 * shared-number case where the owning business and the serving business differ.
 */
export const conversationTasksRoute = new Hono();

conversationTasksRoute.get("/:id/tasks", async (c) => {
  const tasks = await listTasksForConversation(c.req.param("id"));
  return c.json({ tasks });
});

/**
 * A follow-up said the way a person says it — "call him back Thursday 3pm about
 * the quote" — read into a title and a due time. DoubleTick calls this AI
 * Reminders.
 *
 * READS, NEVER WRITES. It returns what it understood and the pane shows it back
 * ("Call back about the quote · Thu 1 Oct, 15:00"); the follow-up is created by
 * the ordinary POST below only when the person confirms. An assistant that
 * guessed a date and filed it would put a wrong promise on the board with
 * nobody having read it.
 *
 * The time is the SERVING business's wall clock (zonedLocalToUtc), not the
 * server's UTC: "3pm" on a Dubai team's phone is 11:00 UTC, and a bare string
 * would have made every reminder four hours late.
 */
conversationTasksRoute.post("/:id/tasks/understand", async (c) => {
  const body = await c.req.json().catch(() => null);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "Say what needs doing, and when." }, 400);
  if (text.length > 300) return c.json({ error: "Keep it to a sentence or two." }, 413);

  const conversationId = c.req.param("id");
  const conversation = await findConversationById(conversationId);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);
  const routing = await getConversationRouting(conversationId).catch(() => null);
  const serving = await findOrganizationById(routing?.routedOrganizationId ?? conversation.organizationId);
  const timeZone = serving?.timezone || "Asia/Dubai";

  const now = new Date();
  const answer = await completeText({
    system:
      'You turn a support agent\'s note into a follow-up task. Reply with ONLY a JSON object: {"title": string, "due": string|null}. "title" is a short imperative task (max 80 chars) in the note\'s language, without the date or time in it. "due" is the local date-time "YYYY-MM-DDTHH:MM" the note asks for, resolved against the current local time you are given; if a day is given without a time use 09:00; if no time or day is mentioned use null. Never invent a date the note does not imply.',
    prompt: `Current local time: ${describeNow(now, timeZone)} (${localStamp(now, timeZone)}).\nNote: ${text}`,
    maxTokens: 120,
  });
  if (!answer) {
    return c.json({ error: "The assistant is not available right now — add it by hand below." }, 503);
  }

  // The model's JSON, checked field by field rather than trusted: a title it
  // could not produce falls back to the note itself, and a due time that is not
  // the exact shape, not a real date, or already past is dropped to "no date"
  // rather than filed wrong.
  let parsed: { title?: unknown; due?: unknown } = {};
  try {
    parsed = JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    parsed = {};
  }
  const title =
    typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim().slice(0, 200) : text.slice(0, 200);
  const dueDate = typeof parsed.due === "string" ? zonedLocalToUtc(parsed.due, timeZone) : null;
  const dueAt = dueDate && dueDate.getTime() > now.getTime() - 60_000 ? dueDate.toISOString() : null;

  // dateDropped: the note implied a time that could not be used (malformed or
  // already past) — said out loud so the pane can ask for one, not silently
  // filed as "no date".
  return c.json({ title, dueAt, timeZone, dateDropped: typeof parsed.due === "string" && !dueAt });
});

conversationTasksRoute.post("/:id/tasks", async (c) => {
  const scope = scopeOf(c);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.title !== "string") {
    return c.json({ error: "A task needs a title." }, 400);
  }

  try {
    const task = await createTask({
      conversationId: c.req.param("id"),
      // Defaults to the person raising it. Someone writing down a follow-up
      // mid-conversation almost always means "I will do this", and a task that
      // silently lands with no owner is one nobody does.
      employeeId:
        typeof body.employeeId === "string"
          ? body.employeeId
          : scope.role === "operator"
            ? null
            : scope.employeeId ?? null,
      title: body.title,
      notes: typeof body.notes === "string" ? body.notes : null,
      dueAt: typeof body.dueAt === "string" && body.dueAt ? body.dueAt : null,
    });
    return c.json({ task }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not create the task.";
    logger.warn({ err }, "Conversation task creation refused");
    return c.json({ error: message }, 400);
  }
});
