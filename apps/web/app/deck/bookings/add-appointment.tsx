"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import {
  createBooking,
  getContacts,
  readableError,
  type ContactSummary,
  type TeamMember,
} from "@/lib/api";
import { wallClockToInstant, describeInstant } from "@/lib/zoned-time";

/**
 * Putting an appointment in the diary by hand.
 *
 * ============================================================
 * WHY THIS EXISTS, HAVING DELIBERATELY NOT EXISTED
 * ============================================================
 *
 * The page next to this one carried, for weeks, an explicit note saying there
 * was no add form and that the omission was deliberate: an appointment is
 * agreed in the conversation, and a booking made on a screen is one nobody told
 * the customer about.
 *
 * That reasoning holds for the case it was written about and misses the case it
 * was not. A law firm takes phone calls. Somebody walks in. A client emails.
 * In every one of those a person IS talking to the customer — they simply are
 * not doing it over WhatsApp, and a diary only the agent can write to makes the
 * platform useless for the half of the business that happens out loud. The
 * owner asked for this on 2026-08-26 with that put to them.
 *
 * The guarantee the original note was protecting is kept, because it never
 * depended on the form's absence: the same `createBooking` runs, so the same
 * exclusion constraint refuses a double-booking and the same check refuses a
 * staff member who works for another business. What changes is only who can
 * start one.
 *
 * ============================================================
 * THE TIMEZONE IS THE WHOLE RISK
 * ============================================================
 *
 * A `<input type="time">` yields a wall clock with no zone attached. Sending it
 * as though it were the reader's own produces an appointment four hours out for
 * an operator in London, saved successfully, displayed plausibly, and wrong —
 * the exact failure the read side of this page was built to avoid, running
 * backwards. So the typed time is interpreted in the BUSINESS's zone, and that
 * zone is printed next to the fields rather than assumed.
 */
export function AddAppointment({
  business,
  businessName,
  timezone,
  team,
  onCreated,
}: {
  business: BusinessSlug;
  businessName: string;
  timezone: string;
  team: TeamMember[];
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
  const [contactsReadable, setContactsReadable] = useState<boolean | null>(null);
  const [search, setSearch] = useState("");
  const [contactId, setContactId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [minutes, setMinutes] = useState(60);
  const [subject, setSubject] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Customers are searched on the server, which already supports `q` — filtering
  // a first page in the browser would quietly hide anyone who did not happen to
  // be in it, and this list is the one field with no safe wrong answer.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      getContacts(business, search.trim() || undefined)
        .then((data) => {
          if (cancelled) return;
          setContacts(data.contacts);
          setContactsReadable(true);
        })
        .catch(() => {
          // Not an empty list. "This business has no customers" and "the
          // customer list could not be read" must not look alike on a form
          // whose whole job is choosing one of them.
          if (cancelled) return;
          setContacts([]);
          setContactsReadable(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, business, search]);

  // Reopening for a different business must not keep the last one's customer.
  useEffect(() => {
    setContactId("");
    setEmployeeId("");
    setSearch("");
  }, [business]);

  const preview = useMemo(() => {
    if (!date || !time) return "";
    const startsAt = wallClockToInstant(date, time, timezone);
    if (!startsAt) return "";
    const endsAt = new Date(new Date(startsAt).getTime() + minutes * 60_000).toISOString();
    return `${describeInstant(startsAt, timezone)} — ${describeInstant(endsAt, timezone, true)}`;
  }, [date, time, minutes, timezone]);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setError("");

      const startsAt = wallClockToInstant(date, time, timezone);
      if (!startsAt) {
        setError("Pick a date and a time.");
        return;
      }
      if (!contactId) {
        setError("Choose the customer this appointment is with.");
        return;
      }

      setSaving(true);
      try {
        await createBooking({
          business,
          contactId,
          employeeId: employeeId || null,
          startsAt,
          endsAt: new Date(new Date(startsAt).getTime() + minutes * 60_000).toISOString(),
          subject: subject.trim() || null,
          notes: notes.trim() || null,
        });
        setOpen(false);
        setContactId("");
        setDate("");
        setTime("");
        setSubject("");
        setNotes("");
        onCreated();
      } catch (err) {
        // Shown as it arrives. A 409 here says the time went while this form was
        // open, and the database's own sentence is the whole explanation —
        // wrapping it in "could not save" would bury the only useful part.
        setError(readableError(err));
      } finally {
        setSaving(false);
      }
    },
    [business, contactId, employeeId, date, time, minutes, subject, notes, timezone, onCreated]
  );

  if (!open) {
    return (
      <div className="bk-add-bar">
        <button type="button" className="bk-add-open" onClick={() => setOpen(true)}>
          Add an appointment
        </button>
        <span>for someone who phoned, emailed or walked in</span>
      </div>
    );
  }

  return (
    <form className="bk-add" onSubmit={submit}>
      <div className="bk-add-head">
        <strong>New appointment · {businessName}</strong>
        <button type="button" className="bk-add-close" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>

      <label className="bk-field">
        <span>Customer</span>
        <input
          type="search"
          value={search}
          placeholder="Search by name or number"
          onChange={(event) => setSearch(event.target.value)}
        />
        {contactsReadable === false ? (
          <em className="bk-unreadable">
            The customer list could not be read just now. This is not a report that there are none.
          </em>
        ) : (
          <select value={contactId} onChange={(event) => setContactId(event.target.value)} required>
            <option value="">
              {contacts.length === 0 ? "No customers match" : "Choose a customer"}
            </option>
            {contacts.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.displayName ?? "Unnamed"} · {contact.waId}
              </option>
            ))}
          </select>
        )}
      </label>

      <label className="bk-field">
        <span>With</span>
        <select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
          <option value="">Nobody yet — assign later</option>
          {team.map((member) => (
            <option key={member.id} value={member.id}>
              {member.fullName}
            </option>
          ))}
        </select>
      </label>

      <div className="bk-row">
        <label className="bk-field">
          <span>Date</span>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
        </label>
        <label className="bk-field">
          <span>Start</span>
          <input type="time" value={time} onChange={(event) => setTime(event.target.value)} required />
        </label>
        <label className="bk-field">
          <span>Length</span>
          <select value={minutes} onChange={(event) => setMinutes(Number(event.target.value))}>
            {[15, 30, 45, 60, 90, 120].map((n) => (
              <option key={n} value={n}>
                {n} min
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* The zone is stated, never assumed. Whoever types 15:00 is entitled to
          know whose three o'clock they just wrote down. */}
      <p className="bk-zone">
        Times are {businessName}&apos;s local time ({timezone}).
        {preview ? <> This appointment: <b>{preview}</b>.</> : null}
      </p>

      <label className="bk-field">
        <span>What it is about</span>
        <input
          type="text"
          value={subject}
          maxLength={120}
          placeholder="Consultation, document collection…"
          onChange={(event) => setSubject(event.target.value)}
        />
      </label>

      <label className="bk-field">
        <span>Notes</span>
        <textarea
          value={notes}
          rows={2}
          placeholder="How it was agreed, anything the person meeting them should know"
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>

      {error ? <p className="bk-add-error">{error}</p> : null}

      <div className="bk-add-foot">
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Put it in the diary"}
        </button>
        <span>
          The customer is not told. Whoever agreed this with them has already said it, or still
          has to.
        </span>
      </div>
    </form>
  );
}
