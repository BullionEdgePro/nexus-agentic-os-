"use client";

import { useEffect, useRef, useState } from "react";
import type { TeamReaction } from "@/lib/api";
import { mineOf } from "@/lib/team-chat/reactions";

/**
 * The reactions under a bubble (2 Nov 2026): each emoji once, with how many
 * used it; tapping shows who, and lets you take yours off.
 */
export function Reactions({
  reactions,
  myKey,
  canReact,
  onToggle,
}: {
  reactions: TeamReaction[];
  myKey: string | null;
  canReact: boolean;
  onToggle: (emoji: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const mine = myKey ? mineOf(reactions, myKey) : null;

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  if (reactions.length === 0) return null;
  const total = reactions.reduce((sum, group) => sum + group.by.length, 0);

  return (
    <div className="tc-reacts" ref={root}>
      <button
        type="button"
        className={`tc-react-chips${mine ? " mine" : ""}`}
        aria-expanded={open}
        aria-label={`${total} reaction${total === 1 ? "" : "s"} — see who`}
        onClick={() => setOpen((v) => !v)}
      >
        {reactions.map((group) => (
          <span key={group.emoji}>{group.emoji}</span>
        ))}
        {total > 1 ? <b>{total}</b> : null}
      </button>
      {open ? (
        <div className="tc-react-who" role="dialog" aria-label="Who reacted">
          {reactions.map((group) => (
            <div key={group.emoji} className="tc-react-group">
              <span className="tc-react-emoji">{group.emoji}</span>
              <span>
                {group.by.map((person) => (person.key === myKey ? "You" : person.name)).join(", ")}
              </span>
              {canReact && mine === group.emoji ? (
                <button
                  type="button"
                  onClick={() => {
                    onToggle(group.emoji);
                    setOpen(false);
                  }}
                >
                  Remove mine
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
