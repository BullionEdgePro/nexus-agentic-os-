"use client";

import { useEffect, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import { getTeam, readableError, type TeamMember } from "@/lib/api";
import { fontVariables } from "@/lib/fonts";
import "../deck.css";
import "./team.css";

/**
 * The team, as a colleague sees it — who is here and who is on shift now.
 *
 * Read-only by design: managing the roster is the owner's. The roster the API
 * gives a staff member carries names, titles and presence, not colleagues'
 * contact details or sign-in history (employees.ts), so there is nothing here
 * that could show them.
 */
export function TeamDirectory({ slug, myId }: { slug: BusinessSlug; myId: string | null }) {
  const [team, setTeam] = useState<TeamMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTeam(slug)
      .then(({ employees }) => setTeam(employees.filter((e) => e.isActive)))
      .catch((err) => setError(readableError(err, "Could not load your team.")));
  }, [slug]);

  const online = team?.filter((m) => m.presence.status === "online").length ?? 0;

  return (
    <div className={`deck-root team-root ${fontVariables}`}>
      <header className="team-head">
        <div>
          <div className="eyebrow">Team</div>
          <h1>Your team</h1>
          <p className="team-lede">
            Everyone who answers this business&apos;s customers, and who is on shift right now. Your own hours and
            calendar are under <a href="/deck/my-settings">Settings</a>.
          </p>
        </div>
      </header>

      {error ? (
        <p className="team-msg bad">{error}</p>
      ) : !team ? (
        <span className="nx-skel" style={{ width: "40%" }} />
      ) : team.length === 0 ? (
        <p className="team-empty">Nobody on the team yet.</p>
      ) : (
        <>
          <p className="dir-summary">
            <span className="dir-live" aria-hidden="true" /> {online} of {team.length} on shift now
          </p>
          <ul className="dir-grid">
            {team.map((m) => {
              const status = m.presence.status;
              return (
                <li key={m.id} className={`dir-card${m.id === myId ? " me" : ""}`}>
                  <span className={`dir-av s-${status}`} aria-hidden="true">
                    {m.fullName.charAt(0).toUpperCase()}
                  </span>
                  <span className="dir-who">
                    <b>
                      {m.fullName}
                      {m.id === myId ? <em> · you</em> : null}
                    </b>
                    <small>{m.jobTitle ?? "Team member"}</small>
                  </span>
                  <span className={`dir-status s-${status}`}>{statusWord(status)}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

function statusWord(status: string): string {
  switch (status) {
    case "online":
      return "On shift";
    case "busy":
      return "Busy";
    case "away":
      return "Away";
    default:
      return "Off shift";
  }
}
