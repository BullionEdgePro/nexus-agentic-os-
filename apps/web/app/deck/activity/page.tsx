"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BusinessTabs } from "@/lib/business-tabs";
import type { BusinessSlug } from "@nexus/shared";
import {
  getStaffWork,
  getStaffMemberWork,
  readableError,
  type StaffWorkPerson,
  type StaffWorkAttention,
  type StaffConversation,
  type StaffTimelineItem,
} from "@/lib/api";
import { fontVariables } from "@/lib/fonts";
import { ResponseTimes } from "./response-times";
import "../deck.css";
import "./activity.css";

/**
 * Staff work — the admin's view of every staff member's work (22 Oct 2026).
 *
 * Replaces "Team activity", which was a table of counts: the owner asked to see
 * every chat from staff on WhatsApp, social media and email, and everything
 * they do in Nexus. Per person: their channels, their chats on every channel,
 * the customers waiting on them, their replies (from Nexus and from their
 * phone) and a timeline. Admin only — /api/activity is operatorOnly, and staff
 * see only their own work everywhere else.
 */

const CHANNEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  email: "Email",
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
};

const CONNECTION: Record<string, string> = {
  whatsapp: "WhatsApp",
  gmail: "Gmail",
  imap: "Mailbox",
  tiktok: "TikTok",
  facebook: "Facebook",
  instagram: "Instagram",
};

function ago(iso: string | null): string {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

const STATUS_WORDS: Record<StaffWorkPerson["status"], string> = {
  online: "Online",
  away: "Away",
  "never-signed-in": "Never signed in",
};

export default function StaffWorkPage() {
  const [business, setBusiness] = useState<BusinessSlug | "">("");
  const [people, setPeople] = useState<StaffWorkPerson[]>([]);
  const [attention, setAttention] = useState<StaffWorkAttention | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await getStaffWork(business);
      setPeople(data.people);
      setAttention(data.attention);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setLoading(false);
    }
  }, [business]);

  useEffect(() => {
    void load();
    // Fresh every minute: "waiting on them" is the number that goes stale.
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const person = useMemo(() => people.find((p) => p.employeeId === selected) ?? null, [people, selected]);
  const unownedTotal = attention?.unowned.reduce((sum, row) => sum + row.count, 0) ?? 0;

  return (
    <div className={`deck-root ${fontVariables}`}>
      <main className="sw">
        <header className="sw-head">
          <div>
            <p className="sw-eyebrow">People</p>
            <h1 className="sw-title">Staff work</h1>
            <p className="sw-lede">
              Every chat, email and social message your staff handle, and everything they do in Nexus —
              in one place.
            </p>
          </div>
          <BusinessTabs value={business} onChange={(slug) => { setBusiness(slug); setSelected(null); }} />
        </header>

        {error ? (
          <p className="sw-error" role="alert">
            {error} <button type="button" onClick={() => void load()}>Try again</button>
          </p>
        ) : null}

        {attention ? (
          <section className="sw-card sw-attention" aria-label="Needs your attention">
            <h2>Needs your attention</h2>
            <div className="sw-tiles">
              <div className={`sw-tile ${attention.waitingLongTotal ? "crit" : "ok"}`}>
                <strong>{attention.waitingLongTotal}</strong>
                <span>Customers waiting more than 2 hours</span>
              </div>
              <a className={`sw-tile ${unownedTotal ? "warn" : "ok"}`} href="/inbox">
                <strong>{unownedTotal}</strong>
                <span>Open chats that belong to nobody — assign them in Conversations</span>
              </a>
              <a className={`sw-tile ${attention.staffWithoutNumber ? "plain" : "ok"}`} href="/deck/team">
                <strong>{attention.staffWithoutNumber}</strong>
                <span>Staff without their own WhatsApp number</span>
              </a>
              <div className={`sw-tile ${attention.pausedCampaigns ? "warn" : "ok"}`}>
                <strong>{attention.pausedCampaigns}</strong>
                <span>Campaigns paused because most messages were refused</span>
              </div>
            </div>
            {attention.waitingLong.length ? (
              <ul className="sw-waiting">
                {attention.waitingLong.map((row) => (
                  <li key={row.conversationId}>
                    <a href={`/inbox?business=${row.businessSlug}&conversation=${row.conversationId}`}>
                      <span className="sw-waiting-who">{row.contactName ?? "A customer"}</span>
                      <span className="sw-waiting-on">waiting on {row.employeeName}</span>
                      <span className="sw-waiting-since">since {ago(row.since)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {loading && !people.length ? <p className="sw-note">Loading staff…</p> : null}

        <section className="sw-grid" aria-label="Staff">
          {people.map((p) => (
            <article key={p.employeeId} className={`sw-card sw-person${selected === p.employeeId ? " on" : ""}`}>
              <div className="sw-person-head">
                <span className="sw-avatar" aria-hidden="true">{initials(p.fullName)}</span>
                <div className="sw-person-name">
                  <strong>{p.fullName}</strong>
                  <span>
                    {p.businessName}
                    {p.jobTitle ? ` · ${p.jobTitle}` : ""}
                  </span>
                </div>
                <span className={`sw-status ${p.status}`}>{STATUS_WORDS[p.status]}</span>
              </div>
              <div className="sw-chips">
                {p.whatsappNumber ? <span>WhatsApp {p.whatsappNumber}</span> : <span className="muted">No own WhatsApp yet</span>}
                {p.connections
                  .filter((c) => c !== "whatsapp")
                  .map((c) => (
                    <span key={c}>{CONNECTION[c] ?? c}</span>
                  ))}
              </div>
              <dl className="sw-stats">
                <div>
                  <dt>Chats</dt>
                  <dd>{p.chats}</dd>
                </div>
                <div>
                  <dt>Waiting on them</dt>
                  <dd className={p.waiting ? "crit" : ""}>{p.waiting}</dd>
                </div>
                <div>
                  <dt>Replies today</dt>
                  <dd>{p.repliesToday}</dd>
                </div>
              </dl>
              <p className="sw-meta">
                {Object.entries(p.chatsByChannel)
                  .map(([channel, n]) => `${CHANNEL[channel] ?? channel} ${n}`)
                  .join(" · ") || "No chats yet"}
                {p.openTasks ? ` · ${p.openTasks} task${p.openTasks === 1 ? "" : "s"}${p.overdueTasks ? ` (${p.overdueTasks} late)` : ""}` : ""}
                {p.upcomingBookings ? ` · ${p.upcomingBookings} upcoming` : ""}
              </p>
              <div className="sw-person-foot">
                <span>{p.status === "never-signed-in" ? "Never signed in" : `Active ${ago(p.lastActiveAt)}`}</span>
                <button type="button" onClick={() => setSelected(selected === p.employeeId ? null : p.employeeId)}>
                  {selected === p.employeeId ? "Close" : "Open their work"}
                </button>
              </div>
            </article>
          ))}
        </section>

        {person ? <PersonWork key={person.employeeId} person={person} /> : null}

        <ResponseTimes business={business} />
      </main>
    </div>
  );
}

function PersonWork({ person }: { person: StaffWorkPerson }) {
  const [conversations, setConversations] = useState<StaffConversation[]>([]);
  const [timeline, setTimeline] = useState<StaffTimelineItem[]>([]);
  const [channel, setChannel] = useState("all");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getStaffMemberWork(person.employeeId)
      .then((data) => {
        if (cancelled) return;
        setConversations(data.conversations);
        setTimeline(data.timeline);
      })
      .catch((err) => !cancelled && setError(readableError(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [person.employeeId]);

  const channels = useMemo(() => ["all", ...new Set(conversations.map((c) => c.channel))], [conversations]);
  const shown = channel === "all" ? conversations : conversations.filter((c) => c.channel === channel);

  return (
    <section className="sw-card sw-detail" aria-label={`${person.fullName}'s work`}>
      <div className="sw-detail-chats">
        <div className="sw-detail-head">
          <h2>{person.fullName} · their chats</h2>
          <div className="sw-filter" role="tablist" aria-label="Channel">
            {channels.map((c) => (
              <button
                key={c}
                type="button"
                role="tab"
                aria-selected={channel === c}
                className={channel === c ? "on" : ""}
                onClick={() => setChannel(c)}
              >
                {c === "all" ? "All" : CHANNEL[c] ?? c}
              </button>
            ))}
          </div>
        </div>
        {error ? <p className="sw-error">{error}</p> : null}
        {loading ? <p className="sw-note">Loading their chats…</p> : null}
        {!loading && !shown.length ? <p className="sw-note">No chats here yet.</p> : null}
        {shown.length ? (
          <div className="sw-table-wrap">
            <table className="sw-table">
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col">Channel</th>
                  <th scope="col">Last message</th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <a href={`/inbox?business=${c.businessSlug}&conversation=${c.id}`}>
                        {c.contactName ?? c.contactWaId ?? "Unknown customer"}
                      </a>
                    </td>
                    <td>{CHANNEL[c.channel] ?? c.channel}</td>
                    <td className="sw-preview">
                      {c.lastDirection === "outbound" ? "You: " : ""}
                      {c.lastBody ?? "—"}
                    </td>
                    <td>
                      <span className={`sw-state ${c.waiting ? "crit" : c.status === "resolved" ? "muted" : "ok"}`}>
                        {c.waiting ? `Waiting ${ago(c.lastAt).replace(" ago", "")}` : c.status === "resolved" ? "Closed" : "Answered"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
      <div className="sw-detail-timeline">
        <h2>What they did</h2>
        {!loading && !timeline.length ? <p className="sw-note">Nothing recorded yet.</p> : null}
        <ol className="sw-timeline">
          {timeline.map((t, i) => (
            <li key={`${t.at}-${i}`}>
              <span className="sw-dot" aria-hidden="true" />
              <span>
                {t.conversationId ? (
                  <a href={`/inbox?business=${person.businessSlug}&conversation=${t.conversationId}`}>{t.what}</a>
                ) : (
                  t.what
                )}
                <time dateTime={t.at}>{ago(t.at)}</time>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
