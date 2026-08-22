"use client";

import { useCallback, useEffect, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import { getActivity, type EmployeeActivity, type ActivityEvent, readableError } from "@/lib/api";
import { fontVariables } from "@/lib/fonts";
import { TENANTS } from "@/lib/tenants";
import "../deck.css";
import "./activity.css";

/**
 * "As an admin I just want to check everything my employees do while working."
 *
 * Two views of the same records: a roll of every person with their totals, and
 * a timeline of what happened most recently. The API is operator-gated, so an
 * employee who navigates here gets a 401 rather than their colleagues' numbers.
 *
 * The caveat at the foot is deliberate. This page can honestly report what the
 * platform recorded, and the honest answer includes what it did not record —
 * an owner who reads "3 conversations" as "3 conversations, total" will draw a
 * wrong conclusion about someone who is working hard on their own phone.
 */
export default function ActivityPage() {
  const [rows, setRows] = useState<EmployeeActivity[]>([]);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [business, setBusiness] = useState<BusinessSlug | "">("");
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

  const load = useCallback(async (slug: BusinessSlug | "") => {
    setLoading(true);
    setError("");
    setLoadError("");
    try {
      const data = await getActivity(slug || undefined);
      setRows(data.employees);
      setEvents(data.events);
    } catch (err) {
      setLoadError(readableError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(business);
  }, [business, load]);

  return (
    <div className={`deck-root ${fontVariables}`}>
      <div className="act-root">

        <header className="act-head">
          <h1>Team activity</h1>
        </header>
        <p className="act-lede">
          Every employee across the platform, and what the system recorded them doing — customers
          assigned, conversations they took onto their own phone, and leads they logged.
        </p>

        <div className="act-tabs">
          <button aria-pressed={business === ""} onClick={() => setBusiness("")}>
            All businesses
          </button>
          {TENANTS.map((tenant) => (
            <button
              key={tenant.slug}
              aria-pressed={business === tenant.slug}
              onClick={() => setBusiness(tenant.slug as BusinessSlug)}
            >
              {tenant.ref}
            </button>
          ))}
        </div>

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

        {loadError ? null : loading ? (
          <div className="act-empty">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="act-empty">
            No employees on the roster yet. Add them from <a href="/deck/team">Team</a>.
          </div>
        ) : (
          <div className="act-table">
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Assigned</th>
                  <th>On own phone</th>
                  <th>Leads</th>
                  <th>Best score</th>
                  <th>Last active</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.employeeId}>
                    <td>
                      <span className="act-who">
                        <span className="act-name">{row.fullName}</span>
                        <span className="act-sub">
                          {row.organizationName}
                          {row.jobTitle ? ` · ${row.jobTitle}` : ""}
                        </span>
                      </span>
                    </td>
                    <td className={row.assignedConversations ? "" : "act-zero"}>
                      {row.assignedConversations}
                    </td>
                    <td className={row.handoffs ? "" : "act-zero"}>{row.handoffs}</td>
                    <td className={row.leadsLogged ? "" : "act-zero"}>{row.leadsLogged}</td>
                    <td className={row.bestLeadScore == null ? "act-zero" : ""}>
                      {row.bestLeadScore ?? "—"}
                    </td>
                    <td className={row.lastActiveAt ? "" : "act-zero"}>{ago(row.lastActiveAt)}</td>
                    <td>{statusFlag(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h2 className="act-sub-head">Recent activity</h2>
        {events.length === 0 ? (
          <div className="act-empty">
            Nothing logged yet. Entries appear here when an employee records a lead from a
            conversation they handled on their own phone.
          </div>
        ) : (
          <div className="act-feed">
            {events.map((event, index) => (
              <div className="act-event" key={`${event.at}-${index}`}>
                <span className="act-when">{stamp(event.at)}</span>
                <span className="act-detail">
                  <b>{event.employeeName ?? "Unattributed"}</b> logged a lead — {event.detail}
                </span>
                <span className="act-score">{event.score == null ? "" : `${event.score}/100`}</span>
              </div>
            ))}
          </div>
        )}

        <p className="act-caveat">
          <strong>What this can and cannot see.</strong> Everyone works from the one shared WhatsApp
          number, so the platform records the moment an employee takes a customer onto their own
          phone — but not the messages they exchange there. Leads appear here because the employee
          logged them. Read “assigned” as responsibility rather than effort: someone quiet with ten
          customers may be carrying more than someone busy with two.
        </p>
      </div>
    </div>
  );
}

function statusFlag(row: EmployeeActivity) {
  if (!row.isActive) return <span className="act-flag warn">Removed</span>;
  // Someone who has never signed in cannot have done any of this, and the
  // likeliest cause is an access code that was issued and never delivered.
  if (!row.hasSignIn) return <span className="act-flag warn">No sign-in issued</span>;
  if (!row.lastLoginAt) return <span className="act-flag">Never signed in</span>;
  return <span className="act-flag">Active</span>;
}

function stamp(iso: string) {
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ago(iso: string | null) {
  if (!iso) return "never";
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString();
}
