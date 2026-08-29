"use client";

import { useEffect, useState } from "react";
import { getMyDay, readableError, type MyDay } from "@/lib/api";
import "./my-day.css";

/**
 * The first thing a staff member sees.
 *
 * ============================================================
 * A SCREEN THAT ASKED FOR WORK INSTEAD OF SHOWING IT
 * ============================================================
 *
 * This page used to open with a greeting, an empty list, and a form for logging
 * a lead. The form is genuinely useful and is still here — below. What it could
 * not do is answer the question somebody actually opens a console with: what
 * needs me, and in what order.
 *
 * The order on this screen is the argument. A customer who has been waiting
 * outranks a follow-up, which outranks an appointment later today, which
 * outranks a suggestion. That is not alphabetical or chronological, it is by
 * WHO IS INCONVENIENCED IF IT IS MISSED — and a person holding their phone
 * waiting for an answer is inconvenienced most.
 *
 * ============================================================
 * NOTHING TO DO IS A RESULT, NOT AN EMPTY STATE
 * ============================================================
 *
 * When every list is empty this says so in one line and stops. The temptation
 * is to fill the space with skeletons, charts and a chart of the skeletons; the
 * effect is a person scanning a busy screen to discover that nothing on it
 * needs them. "You are clear" is faster to read and truer.
 */
export function MyDay() {
  const [day, setDay] = useState<MyDay | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMyDay()
      .then(setDay)
      .catch((err) => setError(readableError(err, "Could not load your work.")));
  }, []);

  if (error) return <p className="day-error">{error}</p>;
  if (!day) return <div className="day-waiting" aria-hidden="true" />;

  const { who, counts } = day;
  const clear =
    counts.waiting === 0 && counts.overdue === 0 && counts.openTasks === 0 && counts.appointments === 0;

  return (
    <div className="day">
      <header className="day-head">
        <p className="day-eyebrow">
          {who.businessName}
          {who.jobTitle ? ` · ${who.jobTitle}` : ""}
        </p>
        {/* The NAME. This said "Welcome back, aiapps255+staff@gmail.com"
            because the session carries a subject and the page printed it. */}
        <h1>{greeting()}, {who.firstName}.</h1>
        <p className="day-lede">{summarise(counts)}</p>
      </header>

      {day.nudges.length > 0 ? (
        <ul className="day-nudges">
          {day.nudges.map((nudge) => (
            <li key={nudge.kind} className={`day-nudge day-${nudge.severity}`}>
              <span>{nudge.text}</span>
              {nudge.href ? <a href={nudge.href}>Open</a> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {clear ? (
        <p className="day-clear">
          You are clear — nobody is waiting, nothing is overdue, and there is nothing booked.
        </p>
      ) : null}

      {/* 1. People holding their phone. Oldest first: newest-first shows the
             person who has waited least, which is the wrong end of a queue. */}
      {day.waiting.length > 0 ? (
        <section className="day-block day-first">
          <h2>
            Waiting for you
            <span className="day-count">{counts.waiting}</span>
          </h2>
          <ul className="day-list">
            {day.waiting.map((row) => (
              <li key={row.conversationId}>
                <a href={`/inbox?conversation=${row.conversationId}`}>
                  <strong>{row.contactName ?? `+${row.waId}`}</strong>
                  <span className={row.waitingHours >= 24 ? "day-late" : undefined}>
                    {describeWait(row.waitingHours)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* 2. What they promised somebody. */}
      {day.tasks.length > 0 ? (
        <section className="day-block">
          <h2>
            Your follow-ups
            {counts.overdue > 0 ? <span className="day-count day-count-bad">{counts.overdue} late</span> : null}
          </h2>
          <ul className="day-list">
            {day.tasks.map((task) => (
              <li key={task.id}>
                <a href={task.conversationId ? `/inbox?conversation=${task.conversationId}` : "/deck/tasks"}>
                  <strong>{task.title}</strong>
                  <span className={task.isOverdue ? "day-late" : undefined}>
                    {task.contactName ? `${task.contactName} · ` : ""}
                    {task.dueAt ? new Date(task.dueAt).toLocaleDateString() : "no date"}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* 3. Where they have to physically be. Rendered in the BUSINESS's zone,
             which travels on the row — an appointment is a time somebody
             arrives somewhere, and the reader's own zone would show an hour
             they would then repeat to the customer. */}
      {day.appointments.length > 0 ? (
        <section className="day-block">
          <h2>
            Coming up
            <span className="day-count">{counts.appointments}</span>
          </h2>
          <ul className="day-list">
            {day.appointments.map((booking) => (
              <li key={booking.id}>
                <a href="/deck/bookings">
                  <strong>{booking.subject ?? "Appointment"}</strong>
                  <span>
                    {booking.contactName ? `${booking.contactName} · ` : ""}
                    {new Date(booking.startsAt).toLocaleString(undefined, {
                      timeZone: booking.timezone,
                      weekday: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                      day: "numeric",
                      month: "short",
                    })}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <dl className="day-stats">
        <div>
          <dt>Your clients</dt>
          <dd>{counts.clients}</dd>
        </div>
        <div>
          <dt>Never written in</dt>
          <dd>{counts.neverSpoken}</dd>
        </div>
        <div>
          <dt>Came via your link</dt>
          <dd>{counts.referredConversations}</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * Morning, afternoon or evening, in the READER's clock.
 *
 * Deliberately not the business's timezone, unlike an appointment: this is
 * about the person reading it, and a staff member in Dubai opening the console
 * at nine at night should not be told good morning because the row said so.
 */
function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/** One sentence, ordered the way the screen is. */
function summarise(counts: MyDay["counts"]): string {
  const parts: string[] = [];
  if (counts.waiting > 0) {
    parts.push(`${counts.waiting} ${counts.waiting === 1 ? "person is" : "people are"} waiting on you`);
  }
  if (counts.overdue > 0) parts.push(`${counts.overdue} overdue`);
  if (counts.appointments > 0) {
    parts.push(`${counts.appointments} ${counts.appointments === 1 ? "appointment" : "appointments"} ahead`);
  }
  if (parts.length === 0) return "Nothing needs you right now.";
  // Sentence case, and the list reads as a sentence rather than as three chips.
  return `${parts.join(", ").replace(/^./, (c) => c.toUpperCase())}.`;
}

/**
 * How long somebody has been waiting, in words.
 *
 * Rounded coarsely on purpose. "4 hours" is a fact somebody acts on; "4.3
 * hours" is a number they read twice and act on identically.
 */
function describeWait(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 24) return `${Math.round(hours)} hr`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}
