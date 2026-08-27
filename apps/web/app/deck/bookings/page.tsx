"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BusinessTabs } from "@/lib/business-tabs";
import type { BusinessSlug } from "@nexus/shared";
import {
  getBookings,
  updateBooking,
  getTeam,
  type BookingRecord,
  type BookingCounts,
  type BookingStatus,
  type TeamMember, readableError, getOrganizations } from "@/lib/api";
import { AddAppointment } from "./add-appointment";
import { fontVariables } from "@/lib/fonts";
import { TENANTS } from "@/lib/tenants";
import "../deck.css";
import "../activity/activity.css";
import "../tasks/tasks.css";
import "./bookings.css";

/**
 * The diary — appointments the agent actually made.
 *
 * Until this shipped, `book_appointment` wrote nothing anywhere. A customer who
 * agreed a consultation and a customer who never asked were, in the platform's
 * records, the same customer. This page is the first place either has ever been
 * visible.
 *
 * THERE IS NOW AN ADD FORM, having deliberately not been one. What this said
 * before, and why it changed:
 *
 *   "A booking made here would be a booking nobody told the customer about —
 *    the conversation is where an appointment is agreed."
 *
 * True of the case it was written about, and silent about the case it was not.
 * A law firm takes phone calls; somebody walks in; a client emails. A person is
 * talking to the customer in every one of those — just not over WhatsApp — and
 * a diary only the agent can write to is a diary that describes a fraction of
 * the business. The owner asked for it on 2026-08-26 with the original
 * reasoning put to them.
 *
 * The guarantee that note was protecting never depended on the form's absence:
 * an appointment added here goes through the same `createBooking`, so the same
 * exclusion constraint refuses a double-booking and the same check refuses a
 * staff member from another company. Cancelling — and now creating — is still
 * something the customer has to be told about by a person, which is why the
 * caveat at the bottom says so rather than leaving it implied.
 *
 * TIMES ARE SHOWN IN THE BUSINESS'S ZONE, unlike the follow-ups page. A due date
 * is a deadline for whoever is reading it, so their own clock is right. An
 * appointment is a moment somebody physically walks into an office in Dubai, and
 * an operator reading "11:00" in London would repeat it to a customer as though
 * it were the arrival time. The zone label is always rendered for the same
 * reason — an unlabelled time invites the reader to assume it is theirs.
 */
export default function BookingsPage() {
  const [bookings, setBookings] = useState<BookingRecord[]>([]);
  const [counts, setCounts] = useState<BookingCounts>({ upcoming: 0, today: 0, unassigned: 0 });
  const [business, setBusiness] = useState<BusinessSlug | "">("");
  const [status, setStatus] = useState<BookingStatus | "all">("confirmed");
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [error, setError] = useState("");
  /**
   * A LOAD that failed, kept apart from an ACTION that failed.
   *
   * The render below refuses to draw anything when this is set, because the
   * alternative is the previous business's numbers under the new one's name.
   * An action failure — a recompute, a send, a save — must NOT do that: the
   * screen it happened on is still correct, and blanking it would lose the
   * context the message is about.
   */
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  /**
   * Each business's own zone, for the ADD form.
   *
   * The rows already carry `businessTimezone`, but an empty diary carries no
   * rows — and an empty diary is exactly when somebody reaches for this form.
   * Falling back to the reader's clock there would make the first appointment a
   * business ever books the one most likely to be at the wrong hour.
   */
  const [timezones, setTimezones] = useState<Record<string, string>>({});

  const load = useCallback(async (slug: BusinessSlug | "", which: BookingStatus | "all") => {
    setLoading(true);
    setError("");
    setLoadError("");
    try {
      const data = await getBookings({ business: slug, status: which });
      setBookings(data.bookings);
      setCounts(data.counts);
    } catch (err) {
      setLoadError(readableError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(business, status);
  }, [business, status, load]);

  useEffect(() => {
    getOrganizations()
      .then((data) =>
        setTimezones(Object.fromEntries(data.organizations.map((o) => [o.slug, o.timezone])))
      )
      // Failing soft is right here and only because of what the fallback is:
      // `zoneFor` prefers a zone off a real booking row and the form prints
      // whichever zone it ends up using, so a reader is never shown a time
      // without being told whose clock it is on.
      .catch(() => undefined);
  }, []);

  // Assignees come from the business being viewed. With "all businesses"
  // selected there is no single staff list, so reassignment is offered only
  // inside one business — the alternative is a dropdown mixing five companies'
  // employees, where picking wrong is a rejection the operator cannot explain.
  useEffect(() => {
    if (!business) {
      setTeam([]);
      return;
    }
    let cancelled = false;
    getTeam(business)
      .then((data) => {
        if (!cancelled) setTeam(data.employees.filter((member) => member.isActive));
      })
      .catch(() => {
        if (!cancelled) setTeam([]);
      });
    return () => {
      cancelled = true;
    };
  }, [business]);

  async function change(booking: BookingRecord, next: BookingStatus) {
    setError("");
    try {
      await updateBooking(booking.id, { status: next });
      await load(business, status);
    } catch (err) {
      // The 409 from a re-confirm that collided arrives here as its message.
      // Shown as-is: "that time has been given to somebody else since" is the
      // whole explanation, and wrapping it in "could not update" would bury it.
      setError(readableError(err));
    }
  }

  async function assign(booking: BookingRecord, employeeId: string) {
    setError("");
    try {
      await updateBooking(booking.id, { employeeId: employeeId || null });
      await load(business, status);
    } catch (err) {
      setError(readableError(err));
    }
  }

  const heading = useMemo(() => {
    if (counts.upcoming === 0) return "Nothing in the diary";
    if (counts.today > 0) return `${counts.today} today`;
    return `${counts.upcoming} upcoming`;
  }, [counts]);

  return (
    <div className={`deck-root ${fontVariables}`}>
      <div className="act-root">

        <header className="act-head">
          <h1>Appointments</h1>
        </header>
        {/* This used to open "What the agent agreed on the business's behalf",
            which stopped being true the moment staff could add one. The second
            sentence is untouched, because it never depended on who started the
            booking — both routes run the same checks. */}
        <p className="act-lede">
          What this business has agreed to — by agent, or by whoever took the call. Every one was
          taken against a live diary and the database refuses two people the same slot, so an
          appointment appearing here is one somebody can actually keep.
        </p>

        <div className="tk-counts">
          <div className="tk-count">
            <strong>{counts.upcoming}</strong>
            <span>upcoming</span>
          </div>
          <div className="tk-count">
            <strong>{counts.today}</strong>
            <span>today</span>
          </div>
          <div className={`tk-count${counts.unassigned > 0 ? " warn" : ""}`}>
            <strong>{counts.unassigned}</strong>
            <span>nobody assigned</span>
          </div>
        </div>

        <BusinessTabs
          value={business}
          onChange={(slug) => setBusiness(slug)}
        />

        {/*
         * OFFERED ONLY INSIDE ONE BUSINESS, for the reason the assignee dropdown
         * above already gives: with "all businesses" selected there is no single
         * staff list and no single timezone, and a form mixing five companies'
         * customers is one where picking wrong is a mistake nobody can see.
         */}
        {business ? (
          <AddAppointment
            business={business}
            businessName={TENANTS.find((t) => t.slug === business)?.name ?? business}
            timezone={zoneFor(business, timezones, bookings)}
            team={team}
            onCreated={() => void load(business, status)}
          />
        ) : null}

        {loadError ? (
          /*
           * WHEN THE LOAD FAILS, NOTHING BELOW IS DRAWN.
           *
           * This line used to appear ABOVE the data, and the data was
           * whatever the last successful load had put in state. Switch
           * business, have the request fail, and this page showed the
           * PREVIOUS business's numbers under the new one's name — one
           * tenant's figures attributed to another, arriving through the
           * UI rather than the database that spent a whole feature
           * preventing exactly that.
           *
           * Clearing the data instead would have been worse: the page
           * would fall through to its empty state and say "nothing to
           * report" when the truth is "nobody could ask". Those are the
           * two silences the operators panel was fixed for this morning.
           */
          <p className="act-msg">{loadError}</p>
        ) : null}

        <h2 className="act-sub-head">{heading}</h2>

        {loadError ? null : loading ? (
          <div className="act-empty">Loading…</div>
        ) : bookings.length === 0 ? (
          <div className="act-empty">
            <strong>Nothing here.</strong>
            <br />
            {status === "confirmed"
              ? "No appointments booked for this selection."
              : "No appointments match this filter."}
          </div>
        ) : (
          <ul className="tk-list bk-list">
            {bookings.map((booking) => (
              <li
                className={`tk-item bk-item${booking.isPast ? " bk-past" : ""}${
                  booking.status !== "confirmed" ? " closed" : ""
                }`}
                key={booking.id}
              >
                <div className="bk-when">
                  <strong>{formatDay(booking.startsAt, booking.businessTimezone)}</strong>
                  <span>
                    {formatTime(booking.startsAt, booking.businessTimezone)}–
                    {formatTime(booking.endsAt, booking.businessTimezone)}
                  </span>
                  <em>{zoneLabel(booking.startsAt, booking.businessTimezone)}</em>
                </div>

                <div className="tk-main">
                  <p className="tk-title">{booking.subject ?? "Appointment"}</p>
                  {booking.notes ? <p className="tk-notes">{booking.notes}</p> : null}
                  <p className="tk-meta">
                    <span className="tk-biz">{booking.businessName}</span>
                    <span>
                      with {booking.contactName ?? `+${booking.contactWaId ?? "unknown"}`}
                    </span>
                    {booking.employeeName ? (
                      <span>{booking.employeeName}</span>
                    ) : booking.status === "confirmed" && !booking.isPast ? (
                      // The one flag on this page that means somebody has to act:
                      // a customer is expecting to be met by nobody in particular.
                      <span className="act-flag warn">nobody assigned</span>
                    ) : null}
                    {booking.status !== "confirmed" ? (
                      <span className="tk-done-by">{booking.status.replace("_", " ")}</span>
                    ) : null}
                  </p>
                </div>

                <div className="tk-actions bk-actions">
                  {business && booking.status === "confirmed" && !booking.isPast ? (
                    <select
                      value={booking.employeeId ?? ""}
                      onChange={(e) => void assign(booking, e.target.value)}
                      aria-label="Assign this appointment"
                    >
                      <option value="">Nobody</option>
                      {team.map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.fullName}
                        </option>
                      ))}
                    </select>
                  ) : null}

                  {booking.status === "confirmed" ? (
                    <>
                      {booking.isPast ? (
                        <>
                          <button onClick={() => void change(booking, "completed")}>Attended</button>
                          <button className="quiet" onClick={() => void change(booking, "no_show")}>
                            No show
                          </button>
                        </>
                      ) : (
                        <button className="quiet" onClick={() => void change(booking, "cancelled")}>
                          Cancel
                        </button>
                      )}
                    </>
                  ) : booking.status === "cancelled" ? (
                    <button className="quiet" onClick={() => void change(booking, "confirmed")}>
                      Reinstate
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="act-caveat">
          Cancelling here frees the slot for somebody else immediately, and keeps the record that
          the appointment existed — nothing on this page deletes. It does not tell the customer:
          they were given a time by the agent, and someone has to say it has changed.
        </p>
      </div>
    </div>
  );
}

/**
 * Formatting helpers, all taking the BUSINESS timezone explicitly.
 *
 * No default parameter, on purpose. A default would let a new call site omit the
 * zone and silently render in the reader's own — which is the exact mistake this
 * page is built to avoid, and one that produces a plausible time rather than a
 * visible fault.
 */
/**
 * The zone to type an appointment in, from whichever source actually knows.
 *
 * A booking already in the diary is the strongest evidence — it is the zone the
 * server itself stamped on that business. The organizations list is the fallback
 * and the one that carries an empty diary. Only if neither answered does this
 * reach the browser's own zone, and the form prints whatever comes back, so the
 * weakest case is still stated out loud rather than assumed.
 */
function zoneFor(
  slug: string,
  timezones: Record<string, string>,
  bookings: BookingRecord[]
): string {
  const fromRow = bookings.find((b) => b.businessSlug === slug)?.businessTimezone;
  return (
    fromRow ||
    timezones[slug] ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "UTC"
  );
}

function formatDay(iso: string, timeZone: string): string {
  return safeFormat(iso, timeZone, { weekday: "short", day: "numeric", month: "short" });
}

function formatTime(iso: string, timeZone: string): string {
  return safeFormat(iso, timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

function zoneLabel(iso: string, timeZone: string): string {
  return safeFormat(iso, timeZone, { timeZoneName: "short" }).split(", ").pop() ?? timeZone;
}

function safeFormat(iso: string, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone, ...options }).format(when);
  } catch {
    // organizations.timezone is free text. An unusable value must not blank the
    // diary; showing UTC and saying so beats implying a local time we cannot
    // compute.
    return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...options }).format(when);
  }
}
