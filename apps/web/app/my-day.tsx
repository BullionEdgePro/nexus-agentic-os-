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
 * a lead. The form is genuinely useful and is still here — below, and one click
 * away from the quick actions. What it could not do is answer the question
 * somebody actually opens a console with: what needs me, and in what order.
 *
 * The order on this screen is the argument. A customer who has been waiting
 * outranks a promised call-back, which outranks an appointment later today,
 * which outranks a suggestion. That is not alphabetical or chronological, it is
 * by WHO IS INCONVENIENCED IF IT IS MISSED — and a person holding their phone
 * waiting for an answer is inconvenienced most.
 *
 * ============================================================
 * NOTHING TO DO IS A RESULT, NOT AN EMPTY STATE
 * ============================================================
 *
 * When every list is empty this says so in one line and stops. The temptation
 * is to fill the space with skeletons, charts and a chart of the skeletons; the
 * effect is a person scanning a busy screen to discover that nothing on it
 * needs them. "You are clear" is faster to read and truer — so the lists only
 * render when they hold something, and the band at the top says the rest.
 *
 * The "Clear Sky" layout (2026-09-28): a welcome band whose three counters jump
 * to their section, a row of the things a person starts from here, and the
 * lists on a two-column grid — the queue and the promises in the wide column,
 * the diary and the client book beside them.
 */
export function MyDay() {
  const [day, setDay] = useState<MyDay | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMyDay()
      .then(setDay)
      .catch((err) => setError(readableError(err, "Could not load your work.")));
  }, []);

  if (error) {
    return (
      <div className="day">
        <p className="day-error">{error}</p>
      </div>
    );
  }
  if (!day) return <div className="day day-waiting" aria-hidden="true" />;

  const { who, counts } = day;
  const clear =
    counts.waiting === 0 && counts.overdue === 0 && counts.openTasks === 0 && counts.appointments === 0;

  return (
    <div className="day">
      <header className={`day-hero${clear ? " is-clear" : ""}`}>
        <div className="day-hero-copy">
          <p className="day-eyebrow">
            {who.businessName}
            {who.jobTitle ? ` · ${who.jobTitle}` : ""}
            <span className="day-date">{today()}</span>
          </p>
          {/* The NAME. This said "Welcome back, aiapps255+staff@gmail.com"
              because the session carries a subject and the page printed it. */}
          <h1>
            {greeting()}, {who.firstName}.
          </h1>
          <p className="day-lede">{summarise(counts)}</p>
        </div>

        {clear ? (
          <div className="day-clear" role="status">
            <svg className="day-clear-mark" viewBox="0 0 52 52" aria-hidden="true">
              <circle cx="26" cy="26" r="23" />
              <path d="m15 27 7 7 15-16" />
            </svg>
            <p>You are clear — nobody is waiting, nothing is overdue, and there is nothing booked.</p>
          </div>
        ) : (
          <nav className="day-focus" aria-label="What needs you">
            <a href="#day-waiting" className={`day-focus-tile${counts.waiting > 0 ? " hot" : ""}`}>
              <b>{counts.waiting}</b>
              <span>waiting on you</span>
            </a>
            <a href="#day-tasks" className={`day-focus-tile${counts.overdue > 0 ? " late" : ""}`}>
              <b>{counts.overdue > 0 ? counts.overdue : counts.openTasks}</b>
              <span>{counts.overdue > 0 ? "promises late" : "promises open"}</span>
            </a>
            <a href="#day-agenda" className="day-focus-tile">
              <b>{counts.appointments}</b>
              <span>appointments ahead</span>
            </a>
          </nav>
        )}
      </header>

      {/* Where a person starts from here — each one a real screen. */}
      <nav className="day-actions" aria-label="Quick actions">
        <a href="/inbox" className="day-action">
          <Glyph d="M4 5h16v11H8l-4 4V5Z" />
          <span>
            <b>Open my chats</b>
            <small>Everything assigned to you</small>
          </span>
        </a>
        <a href="/deck/tasks" className="day-action">
          <Glyph d="M9 11l3 3 8-8M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h11" />
          <span>
            <b>Add a follow-up</b>
            <small>Promise it, and be reminded</small>
          </span>
        </a>
        <a href="/deck/bookings" className="day-action">
          <Glyph d="M7 3v3m10-3v3M4 9h16M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z" />
          <span>
            <b>Book an appointment</b>
            <small>Phoned, walked in, or asked</small>
          </span>
        </a>
        <a href="/deck/my-clients" className="day-action">
          <Glyph d="M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 3h2m2 0h2m-6 3h6m-6-6h2" />
          <span>
            <b>My link &amp; QR</b>
            <small>Hand customers straight to you</small>
          </span>
        </a>
        <a href="#log-lead" className="day-action">
          <Glyph d="M12 5v14M5 12h14" />
          <span>
            <b>Log a lead</b>
            <small>Won on your own phone</small>
          </span>
        </a>
      </nav>

      {day.nudges.length > 0 ? (
        <ul className="day-nudges">
          {day.nudges.map((nudge) => (
            <li key={nudge.kind} className={`day-nudge day-${nudge.severity}`}>
              <span>{nudge.text}</span>
              {nudge.href ? <a href={nudge.href}>Open →</a> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {clear ? null : (
        <div className="day-grid">
          <div className="day-main">
            {/* 1. People holding their phone. Oldest first: newest-first shows
                   the person who has waited least, which is the wrong end of a
                   queue. */}
            {day.waiting.length > 0 ? (
              <section className="day-card day-first" id="day-waiting">
                <h2>
                  Waiting for you
                  <span className="day-count day-count-hot">{counts.waiting}</span>
                </h2>
                <ul className="day-list">
                  {day.waiting.map((row) => {
                    const name = row.contactName ?? `+${row.waId}`;
                    return (
                      <li key={row.conversationId}>
                        <a href={`/inbox?conversation=${row.conversationId}`}>
                          <span className="day-av" aria-hidden="true">
                            {initial(name)}
                          </span>
                          <strong>{name}</strong>
                          <span className={`day-wait${row.waitingHours >= 24 ? " day-late" : ""}`}>
                            {describeWait(row.waitingHours)}
                          </span>
                          <span className="day-go" aria-hidden="true">
                            Reply →
                          </span>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            {/* 2. What they promised somebody. */}
            {day.tasks.length > 0 ? (
              <section className="day-card" id="day-tasks">
                <h2>
                  Your follow-ups
                  {counts.overdue > 0 ? (
                    <span className="day-count day-count-bad">{counts.overdue} late</span>
                  ) : (
                    <span className="day-count">{counts.openTasks}</span>
                  )}
                </h2>
                <ul className="day-list">
                  {day.tasks.map((task) => (
                    <li key={task.id}>
                      <a href={task.conversationId ? `/inbox?conversation=${task.conversationId}` : "/deck/tasks"}>
                        <span className={`day-tick${task.isOverdue ? " late" : ""}`} aria-hidden="true" />
                        <strong>{task.title}</strong>
                        <span className={`day-due${task.isOverdue ? " day-late" : ""}`}>
                          {task.contactName ? `${task.contactName} · ` : ""}
                          {task.dueAt ? new Date(task.dueAt).toLocaleDateString() : "no date"}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>

          <aside className="day-side">
            {/* 3. Where they have to physically be. Rendered in the BUSINESS's
                   zone, which travels on the row — an appointment is a time
                   somebody arrives somewhere, and the reader's own zone would
                   show an hour they would then repeat to the customer. */}
            {day.appointments.length > 0 ? (
              <section className="day-card" id="day-agenda">
                <h2>
                  Coming up
                  <span className="day-count">{counts.appointments}</span>
                </h2>
                <ol className="day-agenda">
                  {day.appointments.map((booking) => (
                    <li key={booking.id}>
                      <a href="/deck/bookings">
                        <time>
                          {new Date(booking.startsAt).toLocaleString(undefined, {
                            timeZone: booking.timezone,
                            weekday: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                            day: "numeric",
                            month: "short",
                          })}
                        </time>
                        <strong>{booking.subject ?? "Appointment"}</strong>
                        {booking.contactName ? <span>{booking.contactName}</span> : null}
                      </a>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}

            <BookCard counts={counts} />
          </aside>
        </div>
      )}

      {clear ? <BookCard counts={counts} wide /> : null}
    </div>
  );
}

/** The client book in three numbers — reference, so it sits beside the work. */
function BookCard({ counts, wide }: { counts: MyDay["counts"]; wide?: boolean }) {
  return (
    <section className={`day-card day-book${wide ? " wide" : ""}`}>
      <h2>
        Your book
        <a href="/deck/my-clients" className="day-more">
          Open →
        </a>
      </h2>
      <dl className="day-stats">
        <div>
          <dt>Your clients</dt>
          <dd>{counts.clients}</dd>
        </div>
        <div>
          <dt>Never written in</dt>
          <dd className={counts.neverSpoken > 0 ? "day-attn" : undefined}>{counts.neverSpoken}</dd>
        </div>
        <div>
          <dt>Came via your link</dt>
          <dd>{counts.referredConversations}</dd>
        </div>
      </dl>
    </section>
  );
}

function Glyph({ d }: { d: string }) {
  return (
    <span className="day-action-ic" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d={d} />
      </svg>
    </span>
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

/** "Monday, 28 September" — in the reader's clock, like the greeting. */
function today(): string {
  return new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

function initial(name: string): string {
  const c = name.replace(/^\+/, "").trim().charAt(0);
  return /\d/.test(c) || !c ? "#" : c.toUpperCase();
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
