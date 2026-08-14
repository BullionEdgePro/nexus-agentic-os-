import { Hono } from "hono";
import {
  listBookings,
  listBookingsForConversation,
  countBookings,
  createBooking,
  setBookingStatus,
  assignBooking,
  findOrganizationBySlug,
  SlotTakenError,
  type BookingStatus,
} from "@nexus/db";
import type { SessionScope } from "../lib/session.js";
import { logger } from "../lib/logger.js";

/**
 * The diary — what the agent agreed on the business's behalf.
 *
 * Deliberately NOT operatorOnly, on the same reasoning as follow-ups. Activity,
 * quality and broadcasts are management information: an employee reading them
 * learns how their colleagues are doing. A diary is the opposite — it is the
 * thing the person being booked needs in front of them, and an appointment list
 * only a manager can see is a report, not a diary.
 *
 * So the scoping happens here, per role:
 *   operator — every business, optionally narrowed with ?business=<slug>
 *   employee — their own business, always, whatever the query string says
 *
 * `/api/bookings` carries no :slug, so `requireTenantScope` does not apply and
 * the request runs cross-tenant. Nothing underneath narrows it for us; if this
 * handler forgets, an employee reads five businesses' customer appointments —
 * names, numbers and what was agreed — and the response looks entirely normal.
 */

const VALID_STATUS = new Set<string>(["confirmed", "cancelled", "completed", "no_show", "all"]);
const SETTABLE_STATUS = new Set<string>(["confirmed", "cancelled", "completed", "no_show"]);

function scopeOf(c: { get: (k: string) => unknown }): SessionScope {
  // Fail closed, matching require-tenant-scope: an unrecognised caller is an
  // employee of no business, which resolves to zero rows rather than every row.
  return (c.get("scope") as SessionScope | undefined) ?? { sub: "unknown", role: "employee" };
}

export const bookingsRoute = new Hono();

bookingsRoute.get("/", async (c) => {
  const scope = scopeOf(c);
  const status = c.req.query("status") ?? "confirmed";
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
      // An employee session with no business attached. Serving the unfiltered
      // list would be a cross-tenant leak dressed as an empty filter.
      logger.warn({ sub: scope.sub }, "Employee session without an organization asked for bookings");
      return c.json({ error: "Your account is not attached to a business." }, 403);
    }
  }

  // ?mine=1 narrows to the caller's own diary. Meaningless for an operator, who
  // has no employee row and would filter down to nothing.
  const mine = c.req.query("mine") === "1" && scope.role !== "operator";
  // ?upcoming=1 hides what has already happened. Off by default: an operator
  // asking whether yesterday's viewing went ahead has to have somewhere to look.
  const upcomingOnly = c.req.query("upcoming") === "1";

  const [bookings, counts] = await Promise.all([
    listBookings({
      organizationId,
      employeeId: mine ? scope.employeeId ?? null : null,
      status: status as BookingStatus | "all",
      upcomingOnly,
    }),
    countBookings(organizationId),
  ]);

  return c.json({ bookings, counts });
});

bookingsRoute.post("/", async (c) => {
  const scope = scopeOf(c);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.startsAt !== "string" || typeof body.endsAt !== "string") {
    return c.json({ error: "An appointment needs a start and an end." }, 400);
  }

  let organizationId: string | null = null;

  // For an employee the business is never a choice — it is their own, whatever
  // the request body claims, or one company could put appointments in another's
  // diary.
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
    return c.json({ error: "Choose a business, or start the appointment from a conversation." }, 400);
  }

  try {
    const booking = await createBooking({
      organizationId,
      conversationId: typeof body.conversationId === "string" ? body.conversationId : null,
      contactId: typeof body.contactId === "string" ? body.contactId : null,
      employeeId: typeof body.employeeId === "string" ? body.employeeId : null,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      subject: typeof body.subject === "string" ? body.subject : null,
      notes: typeof body.notes === "string" ? body.notes : null,
    });
    return c.json({ booking }, 201);
  } catch (err) {
    // 409, not 400. The request was well-formed and would have succeeded a
    // moment earlier — the resource is the problem, not the input, and a client
    // that retries a 400 unchanged is right to expect the same answer while one
    // that retries this may well get a different one.
    if (err instanceof SlotTakenError) {
      return c.json({ error: err.message, code: err.code }, 409);
    }
    const message = err instanceof Error ? err.message : "Could not create the appointment.";
    logger.warn({ err }, "Booking creation refused");
    return c.json({ error: message }, 400);
  }
});

/**
 * Status changes and reassignment.
 *
 * There is no DELETE, deliberately. A booking is the record that a customer was
 * told to come in at a time; `cancelled` keeps that record while freeing the
 * slot — the exclusion constraint only applies to confirmed rows, so cancelling
 * genuinely makes the time bookable again. Deleting would lose the fact that
 * anybody ever agreed to it, and a customer who turns up anyway would be met
 * with a system that has no idea who they are.
 */
bookingsRoute.patch("/:bookingId", async (c) => {
  const scope = scopeOf(c);
  const bookingId = c.req.param("bookingId");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Nothing to change." }, 400);

  // The booking must be one of theirs. This path takes an id and no slug, so it
  // runs cross-tenant: without this, an employee holding any booking id could
  // cancel another business's appointment. The row would change, the response
  // would look ordinary, and the trace would be a customer arriving for a slot
  // the system says was called off.
  let within: string | null = null;
  if (scope.role !== "operator") {
    within = scope.organizationId ?? null;
    if (!within) return c.json({ error: "Your account is not attached to a business." }, 403);
  }

  try {
    let booking = null;

    if (typeof body.status === "string") {
      if (!SETTABLE_STATUS.has(body.status)) {
        return c.json({ error: `Unknown status "${body.status}".` }, 400);
      }
      booking = await setBookingStatus(bookingId, body.status as BookingStatus, within);
    }

    if ("employeeId" in body) {
      booking = await assignBooking(
        bookingId,
        typeof body.employeeId === "string" && body.employeeId ? body.employeeId : null,
        within
      );
    }

    // Null from every branch means the row was not visible or was already in the
    // requested state. 404 covers both without telling an employee whether a
    // booking id exists in another business.
    if (!booking) return c.json({ error: "That appointment is not available to change." }, 404);
    return c.json({ booking });
  } catch (err) {
    if (err instanceof SlotTakenError) {
      return c.json({ error: err.message, code: err.code }, 409);
    }
    const message = err instanceof Error ? err.message : "Could not update the appointment.";
    logger.warn({ err, bookingId }, "Booking update refused");
    return c.json({ error: message }, 400);
  }
});

/**
 * Appointments hanging off one conversation.
 *
 * Composed onto /api/conversations, so `requireConversationScope` has already
 * decided whether this caller may see this conversation at all — including the
 * shared-number case where the owning and serving businesses differ.
 */
export const conversationBookingsRoute = new Hono();

conversationBookingsRoute.get("/:id/bookings", async (c) => {
  const bookings = await listBookingsForConversation(c.req.param("id"));
  return c.json({ bookings });
});
