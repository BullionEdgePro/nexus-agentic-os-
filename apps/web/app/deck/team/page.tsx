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
  type TeamMember,
  type AssignedConversation,
} from "@/lib/api";
import { fontVariables } from "@/lib/fonts";
import "../deck.css";
import "./team.css";

const BLANK = { fullName: "", jobTitle: "", email: "", whatsappNumber: "" };

export default function TeamPage() {
  const [business, setBusiness] = useState<BusinessSlug>("zipicka");
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [selected, setSelected] = useState<TeamMember | null>(null);
  const [assigned, setAssigned] = useState<AssignedConversation[]>([]);
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [credential, setCredential] = useState<{ name: string; signInAs: string; code: string } | null>(null);

  const loadTeam = useCallback(async (slug: BusinessSlug) => {
    setError("");
    try {
      const { employees } = await getTeam(slug);
      setTeam(employees);
      setSelected((current) => employees.find((e) => e.id === current?.id) ?? null);
    } catch (err) {
      setError(readable(err));
    }
  }, []);

  useEffect(() => {
    setSelected(null);
    setAssigned([]);
    // A shown code belongs to one person at one business; it must not survive
    // a switch to another team's panel.
    setCredential(null);
    loadTeam(business);
  }, [business, loadTeam]);

  useEffect(() => {
    if (!selected) return;
    getAssignedConversations(business, selected.id)
      .then((r) => setAssigned(r.conversations))
      .catch((err) => setError(readable(err)));
  }, [selected, business]);

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
          <div className="eyebrow">Team · direct customer contact</div>
          <h1>Who answers, and from which phone.</h1>
          <p className="team-lede">
            Customers all arrive on one WhatsApp number. Assign a conversation to someone here and
            they carry it on from their own WhatsApp — the platform stops replying the moment they
            do, so nobody gets answered twice.
          </p>
        </div>
        <a className="team-back" href="/deck">
          Back to deck
        </a>
      </header>

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

      {error && <p className="team-msg bad">{error}</p>}
      {notice && !error && <p className="team-msg ok">{notice}</p>}

      <div className="team-grid">
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

        <section className="team-panel">
          <h2>{selected ? `${selected.fullName}'s customers` : "Assigned customers"}</h2>

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
 * The raw message is `API 400 on /path: {"error":"..."}` — the useful part is
 * the server's sentence, so it is pulled out rather than shown wrapped in
 * transport detail nobody can do anything about.
 */
function readable(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const match = /\{"error":"([^"]+)"\}/.exec(raw);
  if (match) return match[1];
  if (raw.includes("API 401")) return "Your session expired. Sign in again.";
  return "Could not reach the platform. Check the connection and try again.";
}
