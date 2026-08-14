import { listEmployees, listBookingsInWindow } from "@nexus/db";
import { isScheduledThroughout } from "@nexus/employees";
import type { Employee } from "@nexus/shared";

/**
 * Which times this business can actually be offered.
 *
 * THE FAILURE THIS EXISTS TO PREVENT is the one the platform has produced twice
 * already in other clothes: a confident, fluent, wrong answer that nothing
 * reports as a fault. An agent that books from the customer's suggestion alone
 * will cheerfully put a property viewing at 2am on a Sunday. Nobody is there,
 * the row is valid, the constraint is satisfied, the conversation reads
 * perfectly, and the first person to discover it is the customer standing
 * outside a locked office.
 *
 * So a time is offerable only when BOTH are true:
 *
 *   1. Somebody is scheduled to be working for every minute of it — decided by
 *      `isScheduledThroughout`, which reads the same working-hours data
 *      `hasStaffOnShift` reads. One notion of a working week, not two.
 *   2. That person's diary is free — a read, and explicitly not the guarantee.
 *      The guarantee is the exclusion constraint in the database. This exists so
 *      the customer is not offered a time that is then refused a second later,
 *      which is a courtesy, not a safety property.
 *
 * An employee with no working hours configured is not offered. That is
 * deliberate and matches `hasStaffOnShift`: a business that has not said when
 * anyone works cannot have appointments made in its name.
 */

export interface SlotOffer {
  startsAt: string;
  endsAt: string;
  employeeId: string;
  employeeName: string;
}

/** Times are offered on the half hour. A 13:47 appointment is nobody's idea. */
const GRID_MINUTES = 30;

/**
 * How soon is too soon. Offering a slot twenty minutes out means a customer
 * agreeing to it, arriving, and finding the person mid-way through something
 * else — the appointment was real, the notice was not.
 */
const MIN_LEAD_MINUTES = 60;

export interface AvailabilityQuery {
  organizationId: string;
  durationMinutes: number;
  /** Defaults to now. Injected so this is testable without mocking the clock. */
  from?: Date;
  /** How far ahead to look. */
  days?: number;
  /** How many offers to return. */
  limit?: number;
  /** Restrict to one person — used when a customer asks for someone by name. */
  employeeId?: string | null;
}

interface Busy {
  employeeId: string | null;
  startsAt: number;
  endsAt: number;
}

function overlaps(busy: Busy, start: number, end: number): boolean {
  return busy.startsAt < end && busy.endsAt > start;
}

/** Round up to the next grid boundary, so offers land on :00 and :30. */
function nextGridPoint(from: Date): Date {
  const step = GRID_MINUTES * 60_000;
  return new Date(Math.ceil(from.getTime() / step) * step);
}

/**
 * MUST BE CALLED IN THE SERVING BUSINESS'S TENANT CONTEXT.
 *
 * Both queries below are tenant-scoped. Called inside the number owner's
 * context — which is what the reply pipeline opens — RLS filters every row and
 * this returns "no availability" rather than an error. See `withServingTenant`
 * in @nexus/db; the tool handler wraps this in it, and the routes reach it from
 * a cross-tenant deck context.
 */
export async function findAvailableSlots(query: AvailabilityQuery): Promise<SlotOffer[]> {
  const duration = Math.max(5, Math.round(query.durationMinutes));
  const days = query.days ?? 7;
  const limit = query.limit ?? 6;
  const now = query.from ?? new Date();

  const searchFrom = nextGridPoint(new Date(now.getTime() + MIN_LEAD_MINUTES * 60_000));
  const searchTo = new Date(searchFrom.getTime() + days * 24 * 60 * 60_000);

  const all = await listEmployees(query.organizationId);
  const candidates = all.filter(
    (employee: Employee) =>
      employee.isActive && (!query.employeeId || employee.id === query.employeeId)
  );
  if (candidates.length === 0) return [];

  const busy: Busy[] = (
    await listBookingsInWindow(query.organizationId, searchFrom, searchTo)
  ).map((booking) => ({
    employeeId: booking.employeeId,
    startsAt: Date.parse(booking.startsAt),
    endsAt: Date.parse(booking.endsAt),
  }));

  const offers: SlotOffer[] = [];
  const step = GRID_MINUTES * 60_000;
  const durationMs = duration * 60_000;

  for (let t = searchFrom.getTime(); t + durationMs <= searchTo.getTime(); t += step) {
    const start = new Date(t);
    const end = new Date(t + durationMs);

    // First person who is both working and free takes the slot. Offering the
    // same time from several people would be a menu the customer cannot use —
    // they asked for a time, not for a colleague.
    const free = candidates.find(
      (employee) =>
        isScheduledThroughout(employee, start, end) &&
        !busy.some((b) => b.employeeId === employee.id && overlaps(b, t, t + durationMs))
    );
    if (!free) continue;

    offers.push({
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      employeeId: free.id,
      employeeName: free.fullName,
    });
    if (offers.length >= limit) break;
  }

  return offers;
}

/**
 * Can this exact time be taken, and by whom?
 *
 * Separate from `findAvailableSlots` because a customer naming their own time is
 * the common case and it does not have to sit on the offer grid — "can you do
 * 3:15 on Thursday" is a reasonable question, and answering "no, but I can do
 * 3:00 or 3:30" needs this to have said no for the right reason.
 *
 * Returns the employee who can take it, or a reason nobody can. The reason is
 * separated into "outside working hours" and "everyone is booked" because those
 * need different replies: the first offers another day, the second offers
 * another time the same day.
 */
export type SlotDecision =
  | { available: true; employeeId: string; employeeName: string }
  | { available: false; reason: "closed" | "fully_booked" | "no_staff" | "too_soon" };

export async function resolveSlot(query: {
  organizationId: string;
  startsAt: Date;
  endsAt: Date;
  from?: Date;
  employeeId?: string | null;
}): Promise<SlotDecision> {
  const now = query.from ?? new Date();
  if (query.startsAt.getTime() < now.getTime()) return { available: false, reason: "too_soon" };

  const all = await listEmployees(query.organizationId);
  const candidates = all.filter(
    (employee: Employee) =>
      employee.isActive && (!query.employeeId || employee.id === query.employeeId)
  );
  if (candidates.length === 0) return { available: false, reason: "no_staff" };

  const working = candidates.filter((employee) =>
    isScheduledThroughout(employee, query.startsAt, query.endsAt)
  );
  if (working.length === 0) return { available: false, reason: "closed" };

  const busy = await listBookingsInWindow(query.organizationId, query.startsAt, query.endsAt);
  const start = query.startsAt.getTime();
  const end = query.endsAt.getTime();
  const free = working.find(
    (employee) =>
      !busy.some(
        (b) =>
          b.employeeId === employee.id &&
          Date.parse(b.startsAt) < end &&
          Date.parse(b.endsAt) > start
      )
  );
  if (!free) return { available: false, reason: "fully_booked" };

  return { available: true, employeeId: free.id, employeeName: free.fullName };
}

/**
 * How a slot is written for a customer to read.
 *
 * In the BUSINESS's timezone, always, and with the zone abbreviation attached.
 * A UAE law firm's client reading a bare "3:00 PM" that was rendered in UTC gets
 * a wrong answer that looks exactly like a right one — and the agent, having
 * produced it from a correct ISO string, has no way to notice.
 */
export function describeSlot(startsAt: string, timezone: string): string {
  const date = new Date(startsAt);
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }).format(date);
  } catch {
    // employees.timezone and organizations.timezone are free text. An unusable
    // one must not throw on the reply path; saying UTC out loud is better than
    // implying a local time we cannot compute.
    return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
}
