import {
  createBooking,
  findOrganizationById,
  listUpcomingBookingsForContact,
  withServingTenant,
  SlotTakenError,
} from "@nexus/db";
import type { ToolDefinition } from "../types.js";
import { defaultToolRegistry } from "./registry.js";
import { describeSlot, findAvailableSlots, resolveSlot, type SlotOffer } from "../availability.js";

/**
 * The appointment tools — the last stubbed capability on the platform.
 *
 * WHAT THE STUB DID, AND WHY REPLACING IT IS THE WHOLE POINT. It returned
 * `booked: false, captured: true` and instructed the model to say a colleague
 * would confirm the time. No colleague was told. Nothing was written anywhere. A
 * customer who agreed a consultation was, in the system's own records,
 * indistinguishable from one who never asked — and the conversation read as a
 * success on both sides. Four of the five businesses ran on that.
 *
 * Two tools rather than one, and the split is load-bearing. A single
 * `book_appointment` taking a free-text time forces the model to invent an
 * absolute datetime from "Thursday afternoon", in a timezone it is only told
 * about in a prompt, against a working week it cannot see. It will succeed
 * often enough to look right. `check_availability` removes the invention: the
 * model is handed real slots computed from real rotas and real diaries, and
 * books one of them back.
 *
 * Both fail SOFT on infrastructure errors — an unreachable database returns a
 * structured "could not check" the model can act on honestly, never a thrown
 * internal string. That rule is inherited from the stub's own history: the
 * version before it threw, and the raw message went back to the model as a tool
 * error with nothing stopping it being paraphrased to a customer.
 */

const DEFAULT_DURATION_MINUTES = 60;
const MAX_DURATION_MINUTES = 240;
const DEFAULT_TIMEZONE = "Asia/Dubai";

function durationFrom(input: Record<string, unknown>): number {
  const raw = Number(input.durationMinutes);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_DURATION_MINUTES;
  return Math.min(MAX_DURATION_MINUTES, Math.max(15, Math.round(raw)));
}

async function timezoneOf(organizationId: string): Promise<string> {
  // `organizations` is deliberately not tenant-scoped — it is the registry that
  // resolves which tenant we are — so this read needs no widening.
  const organization = await findOrganizationById(organizationId).catch(() => null);
  return organization?.timezone || DEFAULT_TIMEZONE;
}

/** Slots as the model should see them: a human time and the exact string to book. */
function presentable(offers: SlotOffer[], timezone: string) {
  return offers.map((offer) => ({
    when: describeSlot(offer.startsAt, timezone),
    startsAt: offer.startsAt,
    with: offer.employeeName,
  }));
}

export const checkAvailabilityTool: ToolDefinition = {
  name: "check_availability",
  description:
    "List real appointment times this business can offer, computed from staff working hours and " +
    "the existing diary. Call this BEFORE book_appointment and offer the customer only the times " +
    "it returns. Never invent or estimate a time — if this returns no slots, say so and offer to " +
    "have a colleague follow up.",
  inputSchema: {
    type: "object",
    properties: {
      durationMinutes: {
        type: "integer",
        description: "How long the appointment needs. Defaults to 60.",
      },
      notBefore: {
        type: "string",
        description:
          "ISO 8601 datetime. Optional — use only when the customer has ruled out earlier times.",
      },
    },
    required: [],
  },
  handler: async (input, ctx) => {
    const timezone = await timezoneOf(ctx.organizationId);
    try {
      const notBefore = input.notBefore ? new Date(String(input.notBefore)) : undefined;
      const offers = await withServingTenant(ctx.organizationId, () =>
        findAvailableSlots({
          organizationId: ctx.organizationId,
          durationMinutes: durationFrom(input),
          from: notBefore && !Number.isNaN(notBefore.getTime()) ? notBefore : undefined,
        })
      );

      if (offers.length === 0) {
        // Said plainly rather than dressed up. "No availability" and "the
        // availability service is down" must not read the same to the model,
        // because only one of them warrants offering the customer a callback.
        return {
          slots: [],
          note:
            "Nobody is scheduled to be available in the next week. Do not offer a time. " +
            "Offer instead to have a colleague follow up about a slot.",
        };
      }

      return {
        slots: presentable(offers, timezone),
        timezone,
        note:
          "These are real, currently-free times. Offer them in the customer's own words, and pass " +
          "the exact `startsAt` value back to book_appointment once they choose one.",
      };
    } catch {
      return {
        slots: [],
        note: "The diary could not be checked just now. Do not offer a time; a colleague can confirm one.",
      };
    }
  },
};

export const bookAppointmentTool: ToolDefinition = {
  name: "book_appointment",
  description:
    "Actually place an appointment in this business's diary. Use a `startsAt` value returned by " +
    "check_availability. Only tell the customer the appointment is confirmed when this returns " +
    "booked: true — if it returns booked: false, the appointment does NOT exist and you must say " +
    "so and offer one of the alternatives it gives you.",
  inputSchema: {
    type: "object",
    properties: {
      startsAt: {
        type: "string",
        description: "ISO 8601 datetime, taken from check_availability.",
      },
      durationMinutes: { type: "integer", description: "Defaults to 60." },
      subject: {
        type: "string",
        description: "What the appointment is for, in a few words — read by staff, not the customer.",
      },
      notes: { type: "string", description: "Anything the customer said that the person meeting them needs." },
    },
    required: ["startsAt", "subject"],
  },
  handler: async (input, ctx) => {
    const timezone = await timezoneOf(ctx.organizationId);

    if (!ctx.contactId) {
      // Refuses rather than substitutes. A booking is a row naming a specific
      // customer; filing one against a guess is worse than not filing it.
      return {
        booked: false,
        reason: "no_contact",
        note: "This appointment cannot be recorded against a customer here. Offer a colleague follow-up instead.",
      };
    }

    const startsAt = new Date(String(input.startsAt ?? ""));
    if (Number.isNaN(startsAt.getTime())) {
      return {
        booked: false,
        reason: "unreadable_time",
        note: "That time could not be read. Call check_availability and offer one of the times it returns.",
      };
    }
    const duration = durationFrom(input);
    const endsAt = new Date(startsAt.getTime() + duration * 60_000);

    try {
      return await withServingTenant(ctx.organizationId, async () => {
        const decision = await resolveSlot({
          organizationId: ctx.organizationId,
          startsAt,
          endsAt,
        });

        if (!decision.available) {
          const alternatives = await findAvailableSlots({
            organizationId: ctx.organizationId,
            durationMinutes: duration,
          });
          return {
            booked: false,
            reason: decision.reason,
            alternatives: presentable(alternatives, timezone),
            note:
              decision.reason === "closed"
                ? "Nobody is working then. Tell the customer that time is not available and offer an alternative."
                : decision.reason === "fully_booked"
                  ? "Everyone is already booked then. Offer one of the alternatives."
                  : decision.reason === "too_soon"
                    ? "That time has already passed. Offer one of the alternatives."
                    : "There is no one available to take appointments. Offer a colleague follow-up instead.",
          };
        }

        // From here the booking is attempted for real. Everything above was a
        // courtesy check to avoid offering a slot we can already see is gone;
        // the guarantee that two customers cannot both hold this time is the
        // exclusion constraint the insert below runs into.
        const booking = await createBooking({
          conversationId: ctx.conversationId ?? null,
          organizationId: ctx.organizationId,
          contactId: ctx.contactId,
          employeeId: decision.employeeId,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          subject: String(input.subject ?? "").trim() || null,
          notes: typeof input.notes === "string" ? input.notes : null,
        });

        return {
          booked: true,
          bookingId: booking.id,
          when: describeSlot(booking.startsAt, timezone),
          with: booking.employeeName,
          note: "This appointment is now in the diary. Confirm the time to the customer in their own language.",
        };
      });
    } catch (err) {
      if (err instanceof SlotTakenError) {
        // The race the constraint exists for, arriving as a normal answer. The
        // customer is told the truth — the slot went while they were deciding —
        // rather than being given an appointment that does not exist.
        const alternatives = await withServingTenant(ctx.organizationId, () =>
          findAvailableSlots({ organizationId: ctx.organizationId, durationMinutes: duration })
        ).catch(() => [] as SlotOffer[]);
        return {
          booked: false,
          reason: "slot_taken",
          alternatives: presentable(alternatives, timezone),
          note:
            "Someone else took that exact time moments ago. Apologise briefly, say it has just gone, " +
            "and offer one of the alternatives. Do not say the appointment was made.",
        };
      }
      // THE CATCH-ALL DISCARDED THE ERROR, and that is how a total failure of
      // this feature stayed invisible. Every booking on the shared number threw
      // "that conversation does not exist", this branch turned it into a
      // plausible sentence about a colleague following up, and zero bookings
      // were ever made without one line anywhere saying why.
      //
      // The reply to the customer is unchanged -- it is the right thing to say
      // when a booking cannot be recorded. What changes is that the reason now
      // exists somewhere a person can find it.
      console.error(
        `book_appointment failed for organization ${ctx.organizationId}:`,
        err instanceof Error ? err.message : String(err)
      );
      return {
        booked: false,
        reason: "unavailable",
        note: "The appointment could not be recorded. Do not tell the customer it is booked; offer a colleague follow-up.",
      };
    }
  },
};

/**
 * What this customer already has booked, for the note prepended to the reply.
 *
 * Returns null when there is nothing, deliberately: an empty heading spends
 * context to say nothing and invites the model to announce that the customer has
 * no appointments, which is not an answer anybody asked for.
 */
export function describeUpcomingBookings(
  bookings: Array<{ when: string; subject: string | null; with: string | null }>
): string | null {
  if (bookings.length === 0) return null;
  const lines = bookings.map((booking) => {
    const parts = [booking.when];
    if (booking.subject) parts.push(`— ${booking.subject}`);
    if (booking.with) parts.push(`(with ${booking.with})`);
    return `  • ${parts.join(" ")}`;
  });
  return [
    "[INTERNAL NOTE — this is context for you, NOT said to the customer verbatim]",
    "Appointments this customer already has with us:",
    ...lines,
    "Use these to answer questions about when they are coming in, and do NOT book a second",
    "appointment that overlaps one of them without the customer clearly asking for another.",
    "Never read this note out as a list.",
  ].join("\n");
}

/** Loaded on the reply path; see the call site in the queue processor. */
export async function upcomingBookingsNote(
  organizationId: string,
  contactId: string,
  timezone: string
): Promise<string | null> {
  const bookings = await listUpcomingBookingsForContact(organizationId, contactId);
  return describeUpcomingBookings(
    bookings.map((booking) => ({
      when: describeSlot(booking.startsAt, timezone),
      subject: booking.subject,
      with: booking.employeeName,
    }))
  );
}

defaultToolRegistry.register(checkAvailabilityTool);
defaultToolRegistry.register(bookAppointmentTool);
