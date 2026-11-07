"use client";

import { pocketMatches, portalProblemSentence, type Board, type BoardUnit, type PocketMatch, type PocketShare } from "@nexus/shared";
import { readiness } from "./portals-section";

/**
 * A unit's Pocket section (7 Nov 2026): the switch that keeps it off-market, the
 * buyers on the board it fits, each private link and what happened to it. A
 * link is offered only when the unit would be ready for the portals — the rule
 * the server refuses with — and only for buyers this viewer can see.
 * Spec: docs/superpowers/specs/2026-11-07-pocket-listings-design.md §2, §3, §7
 */

const time = (iso: string, timezone: string) => {
  const d = new Date(iso);
  return `${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: timezone })}, ${d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: timezone,
  })}`;
};
const day = (iso: string, timezone: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: timezone });

/** What happened to a link, in the agent's words. */
export function shareState(share: PocketShare, now: number, timezone: string): string {
  if (share.revokedAt) return "Revoked";
  if (!share.active || Date.parse(share.expiresAt) <= now) return `Expired ${day(share.expiresAt, timezone)}`;
  if (share.interestedAt) return `Interested ${time(share.interestedAt, timezone)}`;
  if (share.viewCount > 0 && share.lastViewedAt) return `Opened ${share.viewCount}× · last ${time(share.lastViewedAt, timezone)}`;
  return `Sent ${day(share.createdAt, timezone)} · not opened yet`;
}

/** How a buyer fits the unit's price. */
export function matchLine(m: Pick<PocketMatch, "fit" | "overBy">): string {
  if (m.fit === "fits") return "Fits the budget";
  if (m.fit === "over") return `Over budget by AED ${Math.round(m.overBy ?? 0).toLocaleString("en-US")}`;
  return "Budget not known";
}

export function PocketSection({
  unit,
  board,
  canEdit,
  timezone,
  now,
  onSwitch,
  onShare,
  onRevoke,
}: {
  unit: BoardUnit;
  board: Board;
  canEdit: boolean;
  timezone: string;
  now: number;
  onSwitch: (on: boolean) => void;
  onShare: (dealId: string) => void;
  onRevoke: (shareId: string) => void;
}) {
  const pocket = unit.pocket ?? { on: false, since: null, shares: [] };
  const missing = pocket.on ? portalProblemSentence(readiness(unit, board), "Before it can be shared") : null;
  const matches = pocket.on && !missing ? pocketMatches(unit, board.deals) : [];
  return (
    <section className="wf-window-part">
      <h3>Pocket</h3>
      <label className="wf-board-flag">
        <input type="checkbox" role="switch" checked={pocket.on} disabled={!canEdit} onChange={(e) => onSwitch(e.target.checked)} /> Pocket
        listing
      </label>
      <p className="wf-board-empty">Off-market: shared privately, never on the portals.</p>
      {missing ? <p className="wf-board-portal-needs">{missing}</p> : null}
      {pocket.on && !missing ? (
        <>
          <h4 className="wf-board-pocket-heading">Share privately</h4>
          {matches.length === 0 ? <p className="wf-board-empty">No buyers on your board for this kind of unit yet.</p> : null}
          <ul className="wf-board-pocket-list">
            {matches.map((m) => (
              <li key={m.deal.id} className="wf-board-pocket-row">
                <span dir="auto">
                  {`${m.deal.contact.name ?? "A customer"} · ${matchLine(m)}${m.shared ? " · Shared" : ""}`}
                </span>
                {canEdit && !m.shared ? (
                  <button type="button" className="kit-pill" onClick={() => onShare(m.deal.id)}>
                    Share
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {pocket.shares.length > 0 ? (
        <ul className="wf-board-pocket-list">
          {pocket.shares.map((s) => (
            <li key={s.id} className="wf-board-pocket-row">
              <span dir="auto">{`${s.contactName ?? "A customer"} — ${shareState(s, now, timezone)}`}</span>
              {canEdit && s.active && !s.revokedAt ? (
                <button type="button" className="kit-pill quiet" onClick={() => onRevoke(s.id)}>
                  Revoke
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export type SharedLink = { url: string; message: string; whatsappUrl: string | null };

/** After Share: the message to send, from the agent's own WhatsApp, or to copy. */
export function ShareWindow({ link, onCopy }: { link: SharedLink; onCopy: (text: string, what: string) => void }) {
  return (
    <div className="wf-window wf-board-detail">
      <p className="wf-window-tag">Pocket</p>
      <h2>Private link</h2>
      <p className="wf-board-pocket-message" dir="auto">
        {link.message}
      </p>
      <div className="wf-board-move-row">
        {link.whatsappUrl ? (
          <a className="kit-pill" href={link.whatsappUrl} target="_blank" rel="noopener noreferrer">
            Send on WhatsApp
          </a>
        ) : null}
        <button type="button" className="kit-pill quiet" onClick={() => onCopy(link.message, "Message")}>
          Copy message
        </button>
        <button type="button" className="kit-pill quiet" onClick={() => onCopy(link.url, "Link")}>
          Copy link
        </button>
      </div>
      <p className="wf-board-empty">
        The link works for 14 days. Anyone who has it can open it — send it to this buyer only. Revoke it from the card at any time.
      </p>
    </div>
  );
}
