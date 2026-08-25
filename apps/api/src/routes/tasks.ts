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
  type TaskStatus,
} from "@nexus/db";
import type { SessionScope } from "../lib/session.js";
import { logger } from "../lib/logger.js";

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
