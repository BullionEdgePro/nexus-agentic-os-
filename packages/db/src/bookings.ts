import { getPool, withServingTenant } from "./client.js";

/**
 * Appointments the agent can actually make.
 *
 * `book_appointment` was the last unimplemented tool on the platform, and the
 * shape of the stub is worth remembering: it returned `booked: false, captured:
 * true` and told the model to say a colleague would confirm. That is option 4 —
 * collect a preference, hand it to a human — and it was rejected on 2026-08-13
 * in favour of the platform's own table. Four of the five businesses treat an
 * appointment as the natural end of a good conversation, and "someone will get
 * back to you about a time" is where those conversations were dying.
 *
 * The one rule that shapes this whole file: THE DOUBLE-BOOKING GUARANTEE IS NOT
 * IN HERE. It is `bookings_no_double_booking`, a gist exclusion constraint in
 * migration 031, and it is in the database precisely so that application code
 * cannot be the thing that gets it wrong. See `createBooking`.
 */

export type BookingStatus = "confirmed" | "cancelled" | "completed" | "no_show";

export interface BookingRecord {
  id: string;
  organizationId: string;
  businessName: string;
  businessSlug: string;
  /**
   * The business's own timezone, carried on every row.
   *
   * An appointment is a time somebody physically arrives somewhere. Rendering
   * it in the reader's local zone — which is what a follow-up due date does,
   * correctly — would show a London operator "11:00" for a 15:00 Dubai viewing,
   * and they would repeat it to the customer. The zone has to travel with the
   * row so no reader has to know which business it belonged to.
   */
  businessTimezone: string;
  contactId: string;
  contactName: string | null;
  contactWaId: string | null;
  employeeId: string | null;
  employeeName: string | null;
  conversationId: string | null;
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
  subject: string | null;
  notes: string | null;
  /** Decided against the database clock, never the browser's — see tasks.ts. */
  isPast: boolean;
  createdAt: string;
}

interface BookingRow {
  id: string;
  organization_id: string;
  business_name: string;
  business_slug: string;
  business_timezone: string;
  contact_id: string;
  contact_name: string | null;
  contact_wa_id: string | null;
  employee_id: string | null;
  employee_name: string | null;
  conversation_id: string | null;
  starts_at: string;
  ends_at: string;
  status: BookingStatus;
  subject: string | null;
  notes: string | null;
  is_past: boolean;
  created_at: string;
}

const BOOKING_FIELDS = `
  b.id, b.organization_id,
  o.name as business_name,
  o.slug as business_slug,
  o.timezone as business_timezone,
  b.contact_id,
  ct.display_name as contact_name,
  ct.wa_id        as contact_wa_id,
  b.employee_id,
  e.full_name     as employee_name,
  b.conversation_id,
  b.starts_at, b.ends_at, b.status, b.subject, b.notes,
  (b.ends_at < now()) as is_past,
  b.created_at
`;

const BOOKING_JOINS = `
  join organizations o on o.id = b.organization_id
  join contacts      ct on ct.id = b.contact_id
  left join employees e on e.id = b.employee_id
`;

const BOOKING_SELECT = `select ${BOOKING_FIELDS} from bookings b ${BOOKING_JOINS}`;

/**
 * Reads that follow a write in the same statement select FROM the CTE, not from
 * the table. A data-modifying CTE is invisible to the rest of its own statement,
 * so re-reading `bookings` here returns the pre-write snapshot — which on an
 * UPDATE means a cancellation coming back marked `confirmed` and nothing
 * erroring. tasks.ts documents the full version of this; it cost a round of
 * debugging there and is not being rediscovered here.
 */
const returning = (cte: string) => `select ${BOOKING_FIELDS} from ${cte} b ${BOOKING_JOINS}`;

function toBooking(row: BookingRow): BookingRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    businessName: row.business_name,
    businessSlug: row.business_slug,
    businessTimezone: row.business_timezone,
    contactId: row.contact_id,
    contactName: row.contact_name,
    contactWaId: row.contact_wa_id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    conversationId: row.conversation_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    subject: row.subject,
    notes: row.notes,
    isPast: row.is_past,
    createdAt: row.created_at,
  };
}

/**
 * The slot was taken between deciding to offer it and trying to take it.
 *
 * A distinct class rather than a string match on the message, because the caller
 * has to tell this apart from every other failure and act differently: this one
 * is not an error the customer should hear about as an error. It means "offer
 * them a different time", and the agent's reply depends on getting that right.
 */
export class SlotTakenError extends Error {
  readonly code = "slot_taken";
  constructor(message = "That time has just been taken.") {
    super(message);
    this.name = "SlotTakenError";
  }
}

/** Postgres exclusion_violation, raised by bookings_no_double_booking. */
function isDoubleBooking(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === "23P01" && e?.constraint === "bookings_no_double_booking";
}

export interface BookingFilter {
  organizationId?: string | null;
  employeeId?: string | null;
  contactId?: string | null;
  /** Defaults to confirmed — a list led by cancellations buries the live diary. */
  status?: BookingStatus | "all";
  /** Only appointments that have not finished yet. Default false. */
  upcomingOnly?: boolean;
  limit?: number;
}

/**
 * Ordering is the opposite of the follow-up list, deliberately.
 *
 * Tasks sort by due date descending-ish with the newest first, because a task
 * list is a backlog. A diary is not a backlog: the next thing that happens is
 * the thing you need at the top, so this is `starts_at asc` and past
 * appointments fall to the bottom rather than being hidden. Hiding them would
 * mean an operator who wants to know whether yesterday's viewing happened has
 * nowhere to look.
 */
export async function listBookings(filter: BookingFilter = {}): Promise<BookingRecord[]> {
  const status = filter.status ?? "confirmed";
  const { rows } = await getPool().query<BookingRow>(
    `${BOOKING_SELECT}
      where ($1::uuid is null or b.organization_id = $1)
        and ($2::uuid is null or b.employee_id = $2)
        and ($3::uuid is null or b.contact_id = $3)
        and ($4::text = 'all' or b.status = $4)
        and ($5::boolean is not true or b.ends_at >= now())
      order by
        case when b.ends_at >= now() then 0 else 1 end,
        case when b.ends_at >= now() then b.starts_at end asc,
        b.starts_at desc
      limit $6`,
    [
      filter.organizationId ?? null,
      filter.employeeId ?? null,
      filter.contactId ?? null,
      status,
      filter.upcomingOnly ?? false,
      filter.limit ?? 200,
    ]
  );
  return rows.map(toBooking);
}

/**
 * Every appointment that came out of one conversation, cancelled ones included.
 *
 * The cancelled rows are the point. An operator reading a thread where a time
 * was agreed and then moved needs to see both, or the history reads as though
 * the first appointment never existed — which is exactly the confusion that
 * makes a customer and a business disagree about what was said.
 */
export async function listBookingsForConversation(
  conversationId: string
): Promise<BookingRecord[]> {
  const { rows } = await getPool().query<BookingRow>(
    `${BOOKING_SELECT}
      where b.conversation_id = $1
      order by b.starts_at desc`,
    [conversationId]
  );
  return rows.map(toBooking);
}

/**
 * What this customer already has booked with this business.
 *
 * Read on the inbound reply path, for the reason the follow-up lookup beside it
 * exists: the moment a booking matters most is when the person who made it
 * writes back. Without this, "what time am I coming in?" reaches an agent that
 * has no idea an appointment exists and answers fluently and wrongly — and,
 * worse, an agent that will happily book a second one.
 *
 * Scoped by organization AND contact. On a shared number the same person talks
 * to a shop and a law firm, and showing one business's diary while answering for
 * another would be invisible in the output.
 */
export async function listUpcomingBookingsForContact(
  organizationId: string,
  contactId: string
): Promise<BookingRecord[]> {
  return listBookings({
    organizationId,
    contactId,
    status: "confirmed",
    upcomingOnly: true,
    limit: 5,
  });
}

/**
 * Confirmed bookings overlapping a window, for the people named.
 *
 * This is a READ used to choose who to offer, and it is explicitly NOT the thing
 * that prevents a clash — see createBooking. Its only job is to avoid offering a
 * time we can already see is busy, so the customer is not told about a slot that
 * is then refused a second later.
 */
/**
 * WIDENED AT THE READ, not at the call site.
 *
 * The diary belongs to the business ANSWERING, so a booking row carries the
 * serving firm's organization_id -- createBooking runs inside
 * withServingTenant. Reading it back from the number owner's transaction
 * returns nothing, and for a diary that is the dangerous direction: an empty
 * list of existing bookings does not read as an error, it reads as a free
 * afternoon, and the agent offers a slot somebody already has.
 *
 * Correct today only because all four call sites in the booking tool remember
 * to wrap it, and findAvailableSlots carries a paragraph asking them to. That
 * is a convention, and this codebase has been bitten eight times by the moment
 * somebody adds the call that does not.
 *
 * The exclusion constraint is what stops an actual double-booking and it does
 * hold -- the customer would be told the slot went while they were deciding.
 * That is a bad exchange rather than a broken diary, and still not a reason to
 * leave the read wrong.
 */
export async function listBookingsInWindow(
  organizationId: string,
  from: Date,
  to: Date
): Promise<Array<{ employeeId: string | null; startsAt: string; endsAt: string }>> {
  return withServingTenant(organizationId, () =>
    listBookingsInWindowScoped(organizationId, from, to)
  );
}

async function listBookingsInWindowScoped(
  organizationId: string,
  from: Date,
  to: Date
): Promise<Array<{ employeeId: string | null; startsAt: string; endsAt: string }>> {
  const { rows } = await getPool().query<{
    employee_id: string | null;
    starts_at: string;
    ends_at: string;
  }>(
    `select employee_id, starts_at, ends_at
       from bookings
      where organization_id = $1
        and status = 'confirmed'
        and starts_at < $3::timestamptz
        and ends_at   > $2::timestamptz
      order by starts_at asc`,
    [organizationId, from.toISOString(), to.toISOString()]
  );
  return rows.map((row) => ({
    employeeId: row.employee_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
  }));
}

export interface BookingCounts {
  upcoming: number;
  today: number;
  unassigned: number;
}

/**
 * `unassigned` counts upcoming confirmed bookings with nobody on them.
 *
 * That is the number an operator has to act on: an appointment a customer is
 * expecting that no member of staff has been given. Counting past ones too would
 * let closed history inflate it until the figure stops meaning anything, which
 * is the same reasoning countTasks uses for open work.
 */
export async function countBookings(organizationId?: string | null): Promise<BookingCounts> {
  const { rows } = await getPool().query<{ upcoming: string; today: string; unassigned: string }>(
    `select
       count(*) filter (where status = 'confirmed' and ends_at >= now())::text as upcoming,
       count(*) filter (where status = 'confirmed'
                          and starts_at >= date_trunc('day', now())
                          and starts_at <  date_trunc('day', now()) + interval '1 day')::text as today,
       count(*) filter (where status = 'confirmed' and ends_at >= now()
                          and employee_id is null)::text as unassigned
     from bookings
     where ($1::uuid is null or organization_id = $1)`,
    [organizationId ?? null]
  );
  return {
    upcoming: Number(rows[0]?.upcoming ?? 0),
    today: Number(rows[0]?.today ?? 0),
    unassigned: Number(rows[0]?.unassigned ?? 0),
  };
}

export interface CreateBookingInput {
  /** Ignored when `conversationId` is given — the conversation decides. */
  organizationId?: string | null;
  conversationId?: string | null;
  contactId?: string | null;
  employeeId?: string | null;
  startsAt: string;
  endsAt: string;
  subject?: string | null;
  notes?: string | null;
}

const SUBJECT_MAX = 200;
const NOTES_MAX = 4000;
/** Nothing this platform books is a working week long; a typo should not become one. */
const MAX_DURATION_MINUTES = 8 * 60;

/**
 * Take a booking, or find out that somebody else just did.
 *
 * THE INSERT IS THE AVAILABILITY CHECK. There is no read-then-write here, and
 * adding one would be a regression however defensive it looked. Two customers
 * messaging at the same moment both read the slot as free, both are told they
 * have it, nothing errors, and the employee finds two people waiting — with no
 * record anywhere that the system did anything wrong. That failure is invisible
 * by construction, so the guarantee lives in `bookings_no_double_booking` where
 * concurrency cannot defeat it, and this function's job is to catch the refusal
 * and turn it into something a person can act on.
 *
 * Proven on production before any of this was written: the first insert was
 * accepted, an overlapping one was rejected by the constraint.
 */
export async function createBooking(input: CreateBookingInput): Promise<BookingRecord> {
  const startsAt = Date.parse(input.startsAt);
  const endsAt = Date.parse(input.endsAt);
  if (Number.isNaN(startsAt)) throw new Error(`"${input.startsAt}" is not a start time I can read.`);
  if (Number.isNaN(endsAt)) throw new Error(`"${input.endsAt}" is not an end time I can read.`);
  if (endsAt <= startsAt) {
    // The column check would catch this too, as a constraint violation that
    // surfaces as a 500 naming neither field.
    throw new Error("An appointment has to end after it starts.");
  }
  if (endsAt - startsAt > MAX_DURATION_MINUTES * 60_000) {
    throw new Error(`An appointment cannot run longer than ${MAX_DURATION_MINUTES / 60} hours.`);
  }

  const subject = input.subject?.trim() || null;
  if (subject && subject.length > SUBJECT_MAX) {
    throw new Error(`Keep the subject under ${SUBJECT_MAX} characters; put the detail in the notes.`);
  }
  const notes = input.notes?.trim() || null;
  if (notes && notes.length > NOTES_MAX) throw new Error(`Notes are limited to ${NOTES_MAX} characters.`);

  let organizationId = input.organizationId ?? null;
  let contactId = input.contactId ?? null;

  if (input.conversationId) {
    // THE BUSINESS COMES FROM THE CONVERSATION, NOT FROM THE CALLER — and it is
    // the SERVING business, not the number's owner. Five businesses answer one
    // number, so reading `organization_id` here would file every appointment
    // under Zipicka: the law firm's diary would be empty and a retailer's full
    // of consultations, with nothing anywhere reporting a fault.
    //
    // AND THE READ DOES NOT NEED TO WIDEN, which I got wrong on 2026-08-22 and
    // am recording because the wrong version was deployed for twenty minutes.
    //
    // I probed the booking tools with a conversation that had no
    // routed_organization_id, saw "that conversation does not exist", and read
    // it as the eleventh instance of this codebase's shared-number defect. It
    // is not. The conversations policy already carries
    // `routed_organization_id::text = current_setting('app.current_org')`, so a
    // conversation ROUTED to the serving business is visible to it -- and the
    // switchboard routes every conversation it hands over. An unrouted
    // conversation belonging to one business, with a booking requested for
    // another, is a state the pipeline never produces and my probe invented.
    //
    // Verified after correcting the probe: the booking is made, and a second
    // attempt on the same slot is refused as fully_booked. It has worked all
    // along.
    //
    // The widening I briefly added would have been a permanent cross-tenant
    // grant on this read, which is precisely what the withServingTenant comment
    // in client.ts argues against: "the relationship is real for one statement;
    // it should not become a permanent grant."
    const { rows } = await getPool().query<{ organization_id: string; contact_id: string | null }>(
      `select coalesce(routed_organization_id, organization_id) as organization_id, contact_id
         from conversations where id = $1`,
      [input.conversationId]
    );
    // "or is not visible from here" is kept, and it is the accurate half: an
    // unrouted conversation belonging to another business really is invisible
    // rather than absent, and saying only "does not exist" would send the next
    // person looking for a missing row.
    if (!rows[0]) throw new Error("That conversation does not exist, or is not visible from here.");
    organizationId = rows[0].organization_id;
    contactId = contactId ?? rows[0].contact_id;
  }

  if (!organizationId) {
    throw new Error("A booking must belong to a business — pass a conversation or an organization.");
  }
  if (!contactId) {
    // Enforced by the column as well. Said here because "not null violation on
    // contact_id" tells an operator nothing, and because a booking with nobody
    // to meet is a category error rather than a missing field.
    throw new Error("A booking needs somebody to meet — no contact was resolved.");
  }

  if (input.employeeId) {
    // A foreign key to employees does not say WHICH business's employee. Without
    // this, an appointment could be put in the diary of somebody at a different
    // company, where it would read as ordinary work. RLS does not catch it: the
    // deck runs in a cross-tenant context where both rows are legitimately
    // visible.
    const { rows } = await getPool().query<{ n: string }>(
      `select count(*)::text as n from employees
        where id = $1 and organization_id = $2 and is_active = true`,
      [input.employeeId, organizationId]
    );
    if (Number(rows[0]?.n ?? 0) !== 1) {
      throw new Error("That person does not work for this business, so the appointment cannot be theirs.");
    }
  }

  try {
    const { rows } = await getPool().query<BookingRow>(
      `with inserted as (
         insert into bookings
           (organization_id, conversation_id, contact_id, employee_id, starts_at, ends_at, subject, notes)
         values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8)
         returning *
       )
       ${returning("inserted")}`,
      [
        organizationId,
        input.conversationId ?? null,
        contactId,
        input.employeeId ?? null,
        new Date(startsAt).toISOString(),
        new Date(endsAt).toISOString(),
        subject,
        notes,
      ]
    );
    return toBooking(rows[0]);
  } catch (err) {
    if (isDoubleBooking(err)) throw new SlotTakenError();
    throw err;
  }
}

/**
 * THE `withinOrganization` ARGUMENT, same as tasks.ts.
 *
 * `/api/bookings` carries no organization slug, so it runs cross-tenant by
 * design — the operator deck genuinely spans all five businesses. Nothing
 * underneath will stop an employee at one company cancelling another's
 * appointment if they hold its id: the row would change, the response would look
 * ordinary, and the only trace would be a customer turning up to a slot the
 * system says was cancelled. Null means "no restriction" and is what an operator
 * passes.
 */

/**
 * Change a booking's status. Cancelling is never a delete.
 *
 * A customer who was told 3pm and then finds nothing on record cannot tell a
 * cancellation from a system that lost their booking. Keeping the row also keeps
 * the exclusion constraint honest in the other direction: it only applies to
 * `confirmed` rows, so cancelling genuinely frees the slot for somebody else.
 */
export async function setBookingStatus(
  bookingId: string,
  status: BookingStatus,
  withinOrganization?: string | null
): Promise<BookingRecord | null> {
  try {
    const { rows } = await getPool().query<BookingRow>(
      `with updated as (
         update bookings set status = $2, updated_at = now()
          where id = $1 and status <> $2
            and ($3::uuid is null or organization_id = $3)
          returning *
       )
       ${returning("updated")}`,
      [bookingId, status, withinOrganization ?? null]
    );
    return rows[0] ? toBooking(rows[0]) : null;
  } catch (err) {
    // Re-confirming a cancelled appointment can collide, because the slot it
    // used to hold may have been given away in the meantime. That is a real
    // answer, not an internal error.
    if (isDoubleBooking(err)) throw new SlotTakenError("That time has been given to somebody else since.");
    throw err;
  }
}

/** Put a booking in somebody's diary, or take it back out of it. */
export async function assignBooking(
  bookingId: string,
  employeeId: string | null,
  withinOrganization?: string | null
): Promise<BookingRecord | null> {
  if (employeeId) {
    // Same cross-business check as createBooking — reassignment is the other
    // door into the identical mistake.
    const { rows } = await getPool().query<{ n: string }>(
      `select count(*)::text as n
         from bookings b
         join employees e on e.id = $2
                         and e.organization_id = b.organization_id
                         and e.is_active = true
        where b.id = $1`,
      [bookingId, employeeId]
    );
    if (Number(rows[0]?.n ?? 0) !== 1) {
      throw new Error("That person does not work for this business, so the appointment cannot be theirs.");
    }
  }

  try {
    const { rows } = await getPool().query<BookingRow>(
      `with updated as (
         update bookings set employee_id = $2, updated_at = now()
          where id = $1 and ($3::uuid is null or organization_id = $3)
          returning *
       )
       ${returning("updated")}`,
      [bookingId, employeeId, withinOrganization ?? null]
    );
    return rows[0] ? toBooking(rows[0]) : null;
  } catch (err) {
    // Assigning an unassigned booking is the moment it starts competing for a
    // person's time, so this is the second place the constraint can fire — and
    // the first time anyone would learn the two appointments overlap.
    if (isDoubleBooking(err)) {
      throw new SlotTakenError("That person already has an appointment overlapping this one.");
    }
    throw err;
  }
}
