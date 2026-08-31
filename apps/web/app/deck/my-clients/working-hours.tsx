"use client";

import { useEffect, useState } from "react";
import {
  getMySchedule,
  saveMySchedule,
  readableError,
  type Weekday,
  type WeeklySchedule,
} from "@/lib/api";

/**
 * A staff member's own working hours — the time they are in and out, set by
 * them.
 *
 * ============================================================
 * WHY THIS EXISTS SEPARATELY FROM THE OWNER'S ROTA EDITOR
 * ============================================================
 *
 * The owner can set anybody's rota from the Team screen. This is the same rota,
 * but a person editing their OWN — reached through the session, never an id in a
 * URL — so nobody can touch a colleague's from here. The most ordinary change to
 * a rota is "these are the hours I work", and it should not need going through
 * the owner.
 *
 * An empty day means off, and a week with no hours at all means off-shift: the
 * assistant will not offer you to a customer and cannot book you a slot. That is
 * deliberate, so the weekly total is shown out loud — a zero here is a state you
 * chose, not a fault to discover later when nobody is ever handed to you.
 *
 * One window a day, on purpose. Split shifts exist in the owner's editor; "time
 * in and out" is the thing a person actually sets for themselves, and a single
 * pair of times is what that is.
 */

const DAYS: { key: Weekday; label: string }[] = [
  { key: "mon", label: "Monday" },
  { key: "tue", label: "Tuesday" },
  { key: "wed", label: "Wednesday" },
  { key: "thu", label: "Thursday" },
  { key: "fri", label: "Friday" },
  { key: "sat", label: "Saturday" },
  { key: "sun", label: "Sunday" },
];

interface DayState {
  on: boolean;
  start: string;
  end: string;
}

type Week = Record<Weekday, DayState>;

const BLANK: DayState = { on: false, start: "09:00", end: "18:00" };

/** Server rota → the one-window-per-day shape this editor works in. */
function toWeek(schedule: WeeklySchedule): Week {
  const week = {} as Week;
  for (const { key } of DAYS) {
    const first = schedule[key]?.[0];
    week[key] = first ? { on: true, start: first.start, end: first.end } : { ...BLANK };
  }
  return week;
}

/** Editor shape → the rota the server stores. Off days are simply absent. */
function toSchedule(week: Week): WeeklySchedule {
  const schedule: WeeklySchedule = {};
  for (const { key } of DAYS) {
    if (week[key].on) schedule[key] = [{ start: week[key].start, end: week[key].end }];
  }
  return schedule;
}

/** Minutes a day covers, or 0 if the window is empty or backwards-across-midnight aside. */
function dayMinutes(day: DayState): number {
  if (!day.on) return 0;
  const [sh, sm] = day.start.split(":").map(Number);
  const [eh, em] = day.end.split(":").map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if ([sh, sm, eh, em].some(Number.isNaN) || start === end) return 0;
  return end > start ? end - start : 24 * 60 - start + end;
}

export function WorkingHoursPanel() {
  const [week, setWeek] = useState<Week | null>(null);
  const [timezone, setTimezone] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedHours, setSavedHours] = useState<number | null>(null);

  const load = async () => {
    try {
      const data = await getMySchedule();
      setWeek(toWeek(data.workingHours));
      setTimezone(data.timezone);
      setSavedHours(data.weeklyHours);
      setError(null);
    } catch (err) {
      const message = readableError(err, "Could not load your working hours.");
      // The owner has no employee record here, so this panel is not theirs.
      if (/no personal account|only a staff|account not found/i.test(message)) setWeek(null);
      else setError(message);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (!week) return null;

  const totalMinutes = DAYS.reduce((sum, { key }) => sum + dayMinutes(week[key]), 0);
  const totalHours = Math.round((totalMinutes / 60) * 10) / 10;

  const setDay = (key: Weekday, patch: Partial<DayState>) =>
    setWeek((current) => (current ? { ...current, [key]: { ...current[key], ...patch } } : current));

  return (
    <section className="wh">
      <h2>Your working hours</h2>
      <p className="wh-lede">
        The hours you are in and out. When you are off-shift, customers are not handed to you — the
        assistant helps them itself instead.{timezone ? ` Times are in ${timezone}.` : ""}
      </p>

      {error ? <p className="mc-error">{error}</p> : null}

      <div className="wh-grid">
        {DAYS.map(({ key, label }) => (
          <div key={key} className={`wh-row${week[key].on ? "" : " off"}`}>
            <label className="wh-day">
              <input
                type="checkbox"
                checked={week[key].on}
                onChange={(event) => setDay(key, { on: event.target.checked })}
              />
              <span>{label}</span>
            </label>
            {week[key].on ? (
              <div className="wh-times">
                <input
                  type="time"
                  aria-label={`${label} start`}
                  value={week[key].start}
                  onChange={(event) => setDay(key, { start: event.target.value })}
                />
                <span className="wh-to">to</span>
                <input
                  type="time"
                  aria-label={`${label} end`}
                  value={week[key].end}
                  onChange={(event) => setDay(key, { end: event.target.value })}
                />
              </div>
            ) : (
              <span className="wh-offlabel">Off</span>
            )}
          </div>
        ))}
      </div>

      <div className="wh-foot">
        <span className={`wh-total${totalHours === 0 ? " zero" : ""}`}>
          {totalHours === 0
            ? "0 hours — you are off-shift and will not be offered to customers"
            : `${totalHours} hours a week`}
        </span>
        <button
          type="button"
          className="wh-save"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              const result = await saveMySchedule(toSchedule(week));
              setSavedHours(result.weeklyHours);
            } catch (err) {
              setError(readableError(err, "Those hours were not saved."));
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Saving…" : "Save my hours"}
        </button>
      </div>

      {savedHours !== null ? (
        <p className="wh-saved">
          {savedHours === 0
            ? "Saved. You are currently off-shift."
            : `Saved — ${savedHours} hours a week on file.`}
        </p>
      ) : null}
    </section>
  );
}
