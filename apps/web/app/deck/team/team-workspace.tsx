"use client";

import { useCallback, useEffect, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import { BUSINESS_OPTIONS } from "@/lib/store";
import {
  getTeam,
  addTeamMember,
  removeTeamMember,
  getAssignedConversations,
  takeToOwnWhatsApp,
  issueAccessCode,
  captureLead,
  getEmployeeLeads,
  labelLead,
  type ScorerAccuracy,
  type EmployeeLead,
  type TeamMember,
  readableError,
  type AssignedConversation,
  type HandoverBrief,
  getCalendars,
  type CalendarRecord,
} from "@/lib/api";
import { fontVariables } from "@/lib/fonts";
import { RotaEditor } from "./rota-editor";
import { CalendarLink } from "./calendar-link";
import "../deck.css";
import "./team.css";

const BLANK = { fullName: "", jobTitle: "", email: "", whatsappNumber: "" };

/**
 * A sign-in date somebody can read at a glance.
 *
 * Relative for the recent past, because "3 days ago" is the form the question
 * is asked in; an absolute date once it stops being recent, because "97 days
 * ago" is arithmetic nobody wants to do.
 */
function formatSignIn(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "signed in at an unreadable time";
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return "signed in today";
  if (days === 1) return "signed in yesterday";
  if (days < 30) return `signed in ${days} days ago`;
  return `signed in ${then.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}

/**
 * When an EMPLOYEE is signed in rather than the operator.
 *
 * They get their own customers and the lead form, and none of the roster
 * management — an employee cannot add colleagues or mint access codes, and the
 * API refuses both anyway. Showing controls that will 403 is worse than hiding
 * them: it reads as a broken page rather than a scoped one.
 */
export interface LockedTo {
  slug: BusinessSlug;
  employeeId: string;
  fullName: string;
}

export default function TeamWorkspace({ lockedTo }: { lockedTo?: LockedTo }) {
  const isOperator = !lockedTo;
  const [business, setBusiness] = useState<BusinessSlug>(lockedTo?.slug ?? "zipicka");
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [selected, setSelected] = useState<TeamMember | null>(null);
  /**
   * Connected calendars, by employee.
   *
   * Fetched once for the business rather than per person: the list is at most
   * as long as the team, and one request keeps the rota editor from opening
   * with an empty calendar panel that fills in a moment later.
   */
  const [calendars, setCalendars] = useState<Record<string, CalendarRecord>>({});

  const loadCalendars = useCallback(async (slug: BusinessSlug) => {
    try {
      const data = await getCalendars(slug);
      setCalendars(Object.fromEntries(data.calendars.map((c) => [c.employeeId, c])));
    } catch {
      // A calendar list that will not load must not blank the team screen.
      // The rota is the more important half and it is already on the page.
      setCalendars({});
    }
  }, []);
  const [assigned, setAssigned] = useState<AssignedConversation[]>([]);
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [brief, setBrief] = useState<{ who: string; brief: HandoverBrief } | null>(null);
  const [credential, setCredential] = useState<{ name: string; signInAs: string; code: string } | null>(null);
  const [leads, setLeads] = useState<EmployeeLead[]>([]);
  /** How the scorer has been doing, or the sentence saying why that cannot be said. */
  const [accuracy, setAccuracy] = useState<ScorerAccuracy | null>(null);
  const [leadForm, setLeadForm] = useState({ whatsappNumber: "", contactName: "", note: "" });

  const loadTeam = useCallback(
    async (slug: BusinessSlug) => {
      setError("");
      try {
        const { employees } = await getTeam(slug);
        setTeam(employees);
        setSelected((current) => {
          // A signed-in employee is always looking at themselves. Falling back
          // to "nobody selected" would show them an empty page with no way to
          // pick, since the roster is hidden for them.
          if (lockedTo) return employees.find((e) => e.id === lockedTo.employeeId) ?? current;
          return employees.find((e) => e.id === current?.id) ?? null;
        });
      } catch (err) {
        setError(readable(err));
      }
    },
    [lockedTo]
  );

  useEffect(() => {
    setSelected(null);
    setAssigned([]);
    // A shown code belongs to one person at one business; it must not survive
    // a switch to another team's panel.
    setCredential(null);
    loadTeam(business);
    void loadCalendars(business);
  }, [business, loadTeam, loadCalendars]);

  useEffect(() => {
    if (!selected) return;
    getAssignedConversations(business, selected.id)
      .then((r) => setAssigned(r.conversations))
      .catch((err) => setError(readable(err)));
    getEmployeeLeads(business, selected.id)
      .then((r) => {
        setLeads(r.leads);
        setAccuracy(r.accuracy);
      })
      .catch((err) => setError(readable(err)));
  }, [selected, business]);

  /**
   * Log a lead this person won on their own phone.
   *
   * Scored by the same engine as an inbound message, so it sorts into the same
   * pipeline — the note is what gets scored, which is why the field says so.
   */
  async function onCaptureLead(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { lead } = await captureLead(business, {
        employeeId: selected.id,
        whatsappNumber: leadForm.whatsappNumber.trim(),
        contactName: leadForm.contactName.trim() || undefined,
        note: leadForm.note.trim(),
      });
      setLeadForm({ whatsappNumber: "", contactName: "", note: "" });
      setNotice(
        `Lead logged — scored ${lead.score} (${lead.priority}${lead.isNewContact ? ", new contact" : ", already known"}).`
      );
      const { leads: refreshed } = await getEmployeeLeads(business, selected.id);
      setLeads(refreshed);
    } catch (err) {
      setError(readable(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Mark what a lead turned out to be.
   *
   * The list is updated in place rather than refetched, for the reason the
   * rota editor gives: a reload would drop the selection and close the panel
   * the moment somebody answered, which reads as the answer having failed.
   */
  async function markLead(assessmentId: string, worthAttention: boolean) {
    try {
      const { accuracy: updated } = await labelLead(business, assessmentId, { worthAttention });
      setLeads((current) =>
        current.map((lead) =>
          lead.assessmentId === assessmentId
            ? { ...lead, label: { worthAttention, outcome: null, labelledBy: "you" } }
            : lead
        )
      );
      setAccuracy(updated);
    } catch (err) {
      setError(readable(err));
    }
  }

  async function onAdd(event: React.FormEvent) {
    event.preventDefault();
    if (!form.fullName.trim()) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { employee } = await addTeamMember(business, {
        fullName: form.fullName.trim(),
        jobTitle: form.jobTitle.trim() || undefined,
        email: form.email.trim() || undefined,
        whatsappNumber: form.whatsappNumber.trim() || undefined,
      });
      setForm(BLANK);
      setNotice(`${employee.fullName} added to ${labelFor(business)}.`);
      await loadTeam(business);
    } catch (err) {
      setError(readable(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Issue this person a sign-in code.
   *
   * Held in component state rather than re-fetched, because it cannot be
   * re-fetched — the server keeps only a hash. If the operator navigates away
   * before passing it on, the fix is to issue another, which is why the panel
   * says so rather than implying it can be looked up.
   */
  async function onIssueCode(member: TeamMember) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const issued = await issueAccessCode(business, member.id);
      setCredential({ name: issued.employee.fullName, signInAs: issued.signInAs, code: issued.accessCode });
    } catch (err) {
      setError(readable(err));
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(member: TeamMember) {
    setBusy(true);
    setError("");
    try {
      await removeTeamMember(business, member.id);
      setNotice(`${member.fullName} taken off the rota. Their message history is kept.`);
      await loadTeam(business);
    } catch (err) {
      setError(readable(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Take a customer to this employee's own WhatsApp.
   *
   * The window is opened from inside the click handler — a popup blocker will
   * stop a window opened after an await, so the request result fills a tab that
   * was already granted rather than trying to create one late.
   */
  async function onTakeOver(conversation: AssignedConversation) {
    if (!selected) return;
    const tab = window.open("", "_blank");
    setBusy(true);
    setError("");
    try {
      const contact = await takeToOwnWhatsApp(conversation.conversationId, selected.id);
      if (tab) tab.location.href = contact.url;
      else window.location.href = contact.url;
      setNotice(
        `AI paused on the platform number — ${conversation.contactName ?? conversation.contactWaId} is yours now.`
      );
      // Kept on the page rather than shown in passing: WhatsApp has already
      // taken focus by now, so a transient toast would be read by nobody. This
      // is here when they come back to the tab.
      if (contact.brief) {
        setBrief({ who: conversation.contactName ?? conversation.contactWaId, brief: contact.brief });
      }
      const { conversations } = await getAssignedConversations(business, selected.id);
      setAssigned(conversations);
    } catch (err) {
      tab?.close();
      setError(readable(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`deck-root team-root ${fontVariables}`}>
      <header className="team-head">
        <div>
          <div className="eyebrow">
            {isOperator ? "Team · direct customer contact" : "My customers"}
          </div>
          <h1>{isOperator ? "Who answers, and from which phone." : `Welcome back, ${lockedTo.fullName}.`}</h1>
          <p className="team-lede">
            {isOperator
              ? "Customers all arrive on one WhatsApp number. Assign a conversation to someone here and they carry it on from their own WhatsApp — the platform stops replying the moment they do, so nobody gets answered twice."
              : "Customers assigned to you, and anything you win on your own WhatsApp. Messaging someone from your phone stops the AI replying to them here, so nobody gets answered twice."}
          </p>
        </div>
        <a className="team-back" href="/">
          Back to deck
        </a>
      </header>

      {isOperator && (
      <nav className="team-tabs" aria-label="Business">
        {BUSINESS_OPTIONS.map((option) => (
          <button
            key={option.slug}
            type="button"
            className={option.slug === business ? "on" : ""}
            onClick={() => setBusiness(option.slug)}
          >
            {option.label}
          </button>
        ))}
      </nav>
      )}

      {error && <p className="team-msg bad">{error}</p>}
      {notice && !error && <p className="team-msg ok">{notice}</p>}

      {brief && (
        <section className="handover">
          <div className="handover-head">
            <span className="handover-label">Before you message {brief.who}</span>
            <button className="handover-close" onClick={() => setBrief(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
          {/* Outstanding promises come FIRST, above the summary.

              The summary is prose a model wrote from the transcript. These are
              records staff entered, carried verbatim — and they are the part
              this person is about to contradict if they don't see them. They
              also render when the summary failed entirely, which is exactly
              when someone is most likely to message cold. */}
          {brief.brief.followUpsUnavailable && (
            <div className="handover-owed">
              <p className="handover-owed-label">
                Outstanding promises could not be checked
              </p>
              <p className="handover-owed-note">
                This is not the same as none. Open the thread before you reply — there may be
                something we have already committed to.
              </p>
            </div>
          )}
          {brief.brief.openFollowUps.length > 0 && (
            <div className="handover-owed">
              <p className="handover-owed-label">
                Already promised to {brief.who} — not done yet
              </p>
              <ul>
                {brief.brief.openFollowUps.map((followUp, index) => (
                  <li key={index} className={followUp.isOverdue ? "late" : undefined}>
                    <span>{followUp.title}</span>
                    <span className="handover-owed-meta">
                      {followUp.dueAt
                        ? `${followUp.isOverdue ? "was due " : "due "}${new Date(
                            followUp.dueAt
                          ).toLocaleString(undefined, {
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}`
                        : "no date agreed"}
                      {followUp.owner ? ` · ${followUp.owner}` : " · nobody's job"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {brief.brief.summary ? (
            <>
              <p className="handover-body">{brief.brief.summary}</p>
              <p className="handover-foot">
                From the last {brief.brief.turnsConsidered}{" "}
                {brief.brief.turnsConsidered === 1 ? "message" : "messages"} on the platform number.
                Check it against the thread before promising anything.
              </p>
            </>
          ) : (
            <p className="handover-foot">
              {brief.brief.unavailableReason} You still have the conversation — open the thread and
              read it before replying.
            </p>
          )}
        </section>
      )}

      <div className="team-grid">
        {isOperator && (
        <section className="team-panel">
          <h2>{labelFor(business)} team</h2>

          {credential && (
            <div className="cred">
              <h3>Sign-in for {credential.name}</h3>
              <dl>
                <div>
                  <dt>Sign in as</dt>
                  <dd>{credential.signInAs}</dd>
                </div>
                <div>
                  <dt>Access code</dt>
                  <dd className="code">{credential.code}</dd>
                </div>
              </dl>
              <p>
                Shown once — only a hash is stored, so this cannot be displayed again. Pass it on
                now; if it is lost, issue another and this one stops working.
              </p>
              <button type="button" className="btn small" onClick={() => setCredential(null)}>
                Done
              </button>
            </div>
          )}

          {team.length === 0 ? (
            <p className="team-empty">Nobody added yet. The AI answers every conversation for this business.</p>
          ) : (
            <ul className="team-list">
              {team.map((member) => (
                <li key={member.id}>
                  <button
                    type="button"
                    className={`team-member ${selected?.id === member.id ? "on" : ""}`}
                    onClick={() => setSelected(member)}
                  >
                    <span className={`dot ${member.presence.shouldTwinRespond ? "" : "live"}`} />
                    <span className="who">
                      <span className="nm">{member.fullName}</span>
                      <span className="rl">{member.jobTitle ?? member.employeeCode}</span>
                    </span>
                    <span className="wa">
                      {member.whatsappReady ? member.whatsappNumber : "no WhatsApp number"}
                    </span>
                    {/*
                      An unset rota is called out in the list, not only inside
                      the editor. Somebody with no hours is never offered an
                      appointment and never promised to a customer on
                      escalation — correct behaviour, and previously invisible
                      here, which is how every business ended up permanently
                      off-shift with nothing to see.
                    */}
                    {member.isActive && (member.weeklyHours ?? 0) === 0 ? (
                      <span className="team-norota">no hours set</span>
                    ) : null}
                    {/*
                      WHEN, AND FROM WHAT. A date alone says whether an account
                      is still in use; the device answers the question actually
                      asked when somebody looks -- "was that me?" A shared
                      access code shows up here as a sign-in from a machine the
                      person does not recognise, and nowhere else.

                      "Never signed in" is stated rather than left blank,
                      because a blank reads as missing data and this is a fact
                      worth acting on: an account issued and never used.
                    */}
                    <span className="team-signin">
                      {member.lastLoginAt
                        ? `${formatSignIn(member.lastLoginAt)}${member.lastLoginDevice ? ` · ${member.lastLoginDevice}` : ""}`
                        : "never signed in"}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="team-remove alt"
                    disabled={busy}
                    onClick={() => onIssueCode(member)}
                    title={`Give ${member.fullName} their own sign-in`}
                  >
                    Sign-in code
                  </button>
                  <button
                    type="button"
                    className="team-remove"
                    disabled={busy}
                    onClick={() => onRemove(member)}
                    title={`Take ${member.fullName} off the rota`}
                  >
                    Remove
                  </button>
                  {selected?.id === member.id ? (
                    <>
                    <RotaEditor
                      business={business}
                      member={member}
                      onSaved={(updated) => {
                        // Replace in place rather than refetching the list. A
                        // reload would drop the selection and close the editor
                        // the moment somebody saved, which reads as the save
                        // having failed.
                        setTeam((current) =>
                          current.map((m) => (m.id === updated.id ? { ...m, ...updated } : m))
                        );
                        setSelected((current) =>
                          current && current.id === updated.id ? { ...current, ...updated } : current
                        );
                      }}
                    />
                    <CalendarLink
                      business={business}
                      employeeId={member.id}
                      calendar={calendars[member.id] ?? null}
                      onChanged={() => void loadCalendars(business)}
                    />
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <form className="team-form" onSubmit={onAdd}>
            <h3>Add someone</h3>
            <label>
              Full name
              <input
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                placeholder="Ivan Cruz"
                required
              />
            </label>
            <label>
              Job title
              <input
                value={form.jobTitle}
                onChange={(e) => setForm({ ...form, jobTitle: e.target.value })}
                placeholder="Senior Consultant"
              />
            </label>
            <label>
              Their WhatsApp number
              <input
                value={form.whatsappNumber}
                onChange={(e) => setForm({ ...form, whatsappNumber: e.target.value })}
                placeholder="+971 50 123 4567"
                inputMode="tel"
              />
              <small>Include the country code. This is the phone they message customers from.</small>
            </label>
            <label>
              Email
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="ivan@example.com"
              />
            </label>
            <button type="submit" className="btn" disabled={busy || !form.fullName.trim()}>
              {busy ? "Saving…" : "Add to team"}
            </button>
          </form>
        </section>
        )}

        <section className="team-panel">
          <h2>
            {isOperator
              ? selected
                ? `${selected.fullName}'s customers`
                : "Assigned customers"
              : "Assigned to you"}
          </h2>

          {!selected ? (
            <p className="team-empty">Pick someone to see who they are responsible for.</p>
          ) : assigned.length === 0 ? (
            <p className="team-empty">
              Nothing assigned yet. Assign a conversation from the deck and it appears here with a
              direct line to the customer.
            </p>
          ) : (
            <ul className="cust-list">
              {assigned.map((conversation) => (
                <li key={conversation.conversationId}>
                  <div className="cust-head">
                    <span className="nm">{conversation.contactName ?? conversation.contactWaId}</span>
                    <span className="biz">{conversation.businessName}</span>
                  </div>
                  <p className="cust-last">{conversation.lastMessagePreview ?? "No messages yet"}</p>
                  <div className="cust-actions">
                    <button
                      type="button"
                      className="btn small"
                      disabled={busy || !conversation.directContact}
                      onClick={() => onTakeOver(conversation)}
                    >
                      Message from my WhatsApp
                    </button>
                    {conversation.isHumanHandoff && <span className="tag">AI paused</span>}
                    {!conversation.directContact && (
                      <span className="tag bad">Not reachable on WhatsApp</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {selected && (
            <form className="lead-form" onSubmit={onCaptureLead}>
              <h3>
                {isOperator
                  ? `Log a lead from ${selected.fullName}'s WhatsApp`
                  : "Log a lead from your WhatsApp"}
              </h3>
              <p className="lead-why">
                Conversations on a personal phone never reach this system on their own. Log one here
                and it is scored and ranked alongside everything that arrives on the shared number.
              </p>
              <label>
                Customer&rsquo;s WhatsApp number
                <input
                  value={leadForm.whatsappNumber}
                  onChange={(e) => setLeadForm({ ...leadForm, whatsappNumber: e.target.value })}
                  placeholder="+971 50 123 4567"
                  inputMode="tel"
                  required
                />
              </label>
              <label>
                Their name
                <input
                  value={leadForm.contactName}
                  onChange={(e) => setLeadForm({ ...leadForm, contactName: e.target.value })}
                  placeholder="Optional"
                />
              </label>
              <label>
                What do they want?
                <textarea
                  value={leadForm.note}
                  onChange={(e) => setLeadForm({ ...leadForm, note: e.target.value })}
                  placeholder="Asking the price for a bulk order, wants delivery to Sharjah"
                  rows={3}
                  required
                />
                <small>
                  This is what gets scored. Their actual words work better than a summary — mention
                  price, quantity, timing or urgency if they did.
                </small>
              </label>
              <button
                type="submit"
                className="btn"
                disabled={busy || !leadForm.whatsappNumber.trim() || !leadForm.note.trim()}
              >
                {busy ? "Saving…" : "Log lead"}
              </button>
            </form>
          )}

          {selected && leads.length > 0 && (
            <div className="lead-list">
              <h3>{isOperator ? `From ${selected.fullName}'s phone` : "From your phone"}</h3>
              <ul>
                {leads.map((lead) => (
                  <li key={lead.assessmentId}>
                    <div className="lead-head">
                      <span className="nm">{lead.contactName ?? lead.contactWaId}</span>
                      <span className={`tag pri-${lead.priority}`}>
                        {lead.score} · {lead.priority}
                      </span>
                    </div>
                    <p className="lead-note">{lead.note}</p>
                    {/* WAS IT WORTH IT. The scorer has never once been told
                        whether it was right, which is why F3's "model second
                        once labels exist" was a condition nobody could reach.
                        Binary on purpose: asking for a priority months later
                        asks somebody to do the scorer's job from memory. */}
                    <div className="lead-mark">
                      {lead.label ? (
                        <span className="lead-marked">
                          {lead.label.worthAttention ? "was worth it" : "was not worth it"}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className={lead.label?.worthAttention === true ? "on" : ""}
                        onClick={() => void markLead(lead.assessmentId, true)}
                      >
                        Worth it
                      </button>
                      <button
                        type="button"
                        className={lead.label?.worthAttention === false ? "on" : ""}
                        onClick={() => void markLead(lead.assessmentId, false)}
                      >
                        Not worth it
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              {/* WHAT THE MARKS ADD UP TO, or why they do not yet. A figure
                  computed from four labels has the shape of an accuracy and
                  none of the content, so below the floor this says what is
                  missing rather than showing a number. */}
              {accuracy ? (
                <p className="lead-acc">
                  {accuracy.blockedBecause ? (
                    accuracy.blockedBecause
                  ) : (
                    <>
                      Of the leads it called high or urgent,{" "}
                      {Math.round((accuracy.falseAlarmRate ?? 0) * 100)}% were not worth anyone's
                      time. Of the ordinary ones,{" "}
                      {Math.round((accuracy.missRate ?? 0) * 100)}% were — those are the ones
                      nobody was told to look at.
                    </>
                  )}
                </p>
              ) : null}
            </div>
          )}

          {selected && !selected.whatsappReady && (
            <p className="team-note">
              {selected.fullName} has no WhatsApp number saved. The links below still open the
              customer&rsquo;s chat — they will send from whichever account is signed in on the
              phone that opens them.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function labelFor(slug: BusinessSlug): string {
  return BUSINESS_OPTIONS.find((option) => option.slug === slug)?.label ?? slug;
}

/**
 * Turn an API failure into something the operator can act on.
 *
 * Moved to lib/api.ts when the catalogue needed the same thing, rather than
 * copied. It sits next to the `request` whose error format it unpicks, which is
 * the only place the two can be kept in step.
 */
const readable = readableError;
