"use client";

import { useMemo, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import { saveSchedule, type TeamMember, type TimeWindow, type WeeklySchedule, type Weekday, readableError } from "@/lib/api";

/**
 * The rota editor — the missing half of the employee layer.
 *
 * Nothing in this product could set `working_hours` until 2026-08-14. Every
 * employee created through the Team screen arrived with an empty rota, and an
 * empty rota means NOT available: `hasStaffOnShift` will not promise them to a
 * customer, and `isScheduledThroughout` will not offer them an appointment.
 * Both are deliberate — promising a person nobody has said is working is the
 * failure they exist to prevent — so the effect was an employee layer that
 * shipped, worked, and was permanently off-shift. It surfaced only when
 * appointments went live and the diary could offer nothing at all.
 *
 * Two decisions here follow from that history:
 *
 * THE HOURS TOTAL IS ALWAYS ON SCREEN, and reads "not bookable" at zero. The
 * state this whole screen exists to fix is one that produces no error anywhere
 * — a person who looks fine in a list and is silently never offered. A number
 * that says nothing is happening is the cheapest possible way to see it.
 *
 * SAVING IS EXPLICIT, per person. An editor that saved on every keystroke would
 * write a half-typed "0" as a real time, and `09:0` is not a rota — it is an
 * employee who quietly stops being available mid-edit.
 */

const DAYS: Array<{ key: Weekday; label: string }> = [
  { key: "mon", label: "Mon" },
  { key: "tue", label: "Tue" },
  { key: "wed", label: "Wed" },
  { key: "thu", label: "Thu" },
  { key: "fri", label: "Fri" },
  { key: "sat", label: "Sat" },
  { key: "sun", label: "Sun" },
];

/**
 * A DELIBERATE DUPLICATE of `weeklyHours` in packages/employees, and the reason
 * it is not imported.
 *
 * Every `@nexus/*` import in apps/web is an `import type`, erased at compile
 * time — no workspace package's runtime code is bundled into the Next build
 * anywhere. Making this the first would mean adding `transpilePackages` to
 * share fifteen lines of arithmetic, which is a build-shaped risk for a
 * cosmetic gain.
 *
 * Bounded, because the server is authoritative on both ends: the list arrives
 * with `weeklyHours` computed server-side, and the save response returns the
 * recomputed value. This copy only animates the total BETWEEN keystrokes, so
 * the worst case of drift is a preview that briefly disagrees with a number
 * that then corrects itself on save — not a stored rota anybody was wrong
 * about.
 *
 * The one rule that must not drift is the wrapping-midnight case: a 22:00–06:00
 * shift is eight hours, not minus sixteen. `rotas-can-be-set.test.mjs` pins
 * that on the server implementation.
 */
function minutesOf(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

function hoursOf(schedule: WeeklySchedule): number {
  let minutes = 0;
  for (const day of DAYS) {
    for (const window of schedule[day.key] ?? []) {
      const start = minutesOf(window.start);
      const end = minutesOf(window.end);
      if (start === null || end === null || start === end) continue;
      minutes += end > start ? end - start : 24 * 60 - start + end;
    }
  }
  return Math.round((minutes / 60) * 10) / 10;
}

/**
 * The next shift that cannot collide with the ones already there.
 *
 * Starts an hour after the last window ends — a lunch-shaped gap, which is what
 * a second shift in a day almost always is — and runs two hours. Clamped so a
 * late finish cannot produce "24:00", which is not a time the reader accepts and
 * would be rejected on save.
 */
function nextShiftAfter(existing: TimeWindow[]): TimeWindow {
  const last = existing[existing.length - 1];
  const lastEnd = last ? minutesOf(last.end) : null;
  if (lastEnd === null) return { start: "09:00", end: "17:00" };

  const start = Math.min(lastEnd + 60, 22 * 60);
  const end = Math.min(start + 120, 23 * 60 + 59);
  // No room left in the day for another shift — repeat the last one so the row
  // appears and the operator edits it, rather than silently doing nothing.
  if (end <= start) return { ...last };
  return { start: fmt(start), end: fmt(end) };
}

function fmt(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function RotaEditor({
  business,
  member,
  onSaved,
}: {
  business: BusinessSlug;
  member: TeamMember;
  onSaved: (updated: TeamMember) => void;
}) {
  const [schedule, setSchedule] = useState<WeeklySchedule>(member.workingHours ?? {});
  const [timezone, setTimezone] = useState(member.timezone || "Asia/Dubai");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const hours = useMemo(() => hoursOf(schedule), [schedule]);

  function edit(next: WeeklySchedule) {
    setSchedule(next);
    setSaved(false);
    setError("");
  }

  function addWindow(day: Weekday) {
    const existing = schedule[day] ?? [];
    // Seeded rather than blank, because an empty pair of boxes is the state
    // that saves as nothing at all.
    //
    // A SECOND SHIFT STARTS AFTER THE FIRST ONE ENDS. The first version seeded
    // a fixed 14:00–17:00, which overlapped the fixed 09:00–18:00 before it —
    // so clicking "+ shift" twice built a rota the server correctly REFUSES as
    // overlapping. Handing somebody a default that cannot be saved is worse
    // than handing them a blank one: the error arrives at save time and reads
    // as the editor being broken. Caught by actually clicking it.
    edit({ ...schedule, [day]: [...existing, nextShiftAfter(existing)] });
  }

  function setWindow(day: Weekday, index: number, patch: Partial<TimeWindow>) {
    const windows = [...(schedule[day] ?? [])];
    windows[index] = { ...windows[index], ...patch };
    edit({ ...schedule, [day]: windows });
  }

  function removeWindow(day: Weekday, index: number) {
    const windows = (schedule[day] ?? []).filter((_, i) => i !== index);
    const next = { ...schedule };
    if (windows.length === 0) delete next[day];
    else next[day] = windows;
    edit(next);
  }

  /** Copy the first configured day across the working week — the common case. */
  function copyDown() {
    const source = DAYS.map((d) => d.key).find((key) => (schedule[key] ?? []).length > 0);
    if (!source) return;
    const windows = schedule[source] ?? [];
    const next: WeeklySchedule = { ...schedule };
    for (const day of DAYS.slice(0, 5)) next[day.key] = windows.map((w) => ({ ...w }));
    edit(next);
  }

  async function submit() {
    setSaving(true);
    setError("");
    try {
      const result = await saveSchedule(business, member.id, { workingHours: schedule, timezone });
      onSaved(result.employee);
      setSaved(true);
    } catch (err) {
      // The server validates properly and names the day and window; showing its
      // message verbatim is more useful than anything this component could
      // reconstruct from a status code.
      setError(readableError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rota">
      <div className="rota-head">
        <div>
          <h4>Working hours</h4>
          <p className={hours === 0 ? "rota-total none" : "rota-total"}>
            {hours === 0
              ? "0 hours — not bookable, and will not be offered for escalation"
              : `${hours} hours a week`}
          </p>
        </div>
        <label className="rota-tz">
          <span>Timezone</span>
          <input
            value={timezone}
            onChange={(e) => {
              setTimezone(e.target.value);
              setSaved(false);
            }}
            placeholder="Asia/Dubai"
            spellCheck={false}
          />
        </label>
      </div>

      <ul className="rota-days">
        {DAYS.map((day) => {
          const windows = schedule[day.key] ?? [];
          return (
            <li key={day.key} className={windows.length === 0 ? "rota-day off" : "rota-day"}>
              <span className="rota-dayname">{day.label}</span>
              <div className="rota-windows">
                {windows.length === 0 ? (
                  <span className="rota-off">not working</span>
                ) : (
                  windows.map((window, index) => (
                    <span className="rota-window" key={index}>
                      <input
                        value={window.start}
                        onChange={(e) => setWindow(day.key, index, { start: e.target.value })}
                        aria-label={`${day.label} start`}
                        placeholder="09:00"
                        inputMode="numeric"
                      />
                      <em>to</em>
                      <input
                        value={window.end}
                        onChange={(e) => setWindow(day.key, index, { end: e.target.value })}
                        aria-label={`${day.label} end`}
                        placeholder="18:00"
                        inputMode="numeric"
                      />
                      <button
                        type="button"
                        className="rota-x"
                        onClick={() => removeWindow(day.key, index)}
                        aria-label={`Remove ${day.label} ${window.start}–${window.end}`}
                      >
                        ×
                      </button>
                    </span>
                  ))
                )}
                <button type="button" className="rota-add" onClick={() => addWindow(day.key)}>
                  + shift
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {error ? <p className="rota-error">{error}</p> : null}

      <div className="rota-actions">
        <button type="button" onClick={() => void submit()} disabled={saving}>
          {saving ? "Saving…" : "Save rota"}
        </button>
        <button type="button" className="quiet" onClick={copyDown}>
          Copy first day to Mon–Fri
        </button>
        {saved ? <span className="rota-saved">Saved</span> : null}
      </div>
    </div>
  );
}
