"use client";

import { useEffect, useState } from "react";
import type { TeamThreadState } from "@/lib/use-team-thread";
import { EmojiPanel } from "./emoji-panel";

/**
 * What a held (or hovered) message offers (2 Nov 2026), as in WhatsApp: a bar of
 * quick reactions with ＋ for any emoji, then Reply, Copy, and Remove on your
 * own messages.
 */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

type Message = TeamThreadState["messages"][number];

export function MessageMenu({
  message,
  mine,
  myReaction,
  onReact,
  onReply,
  onRemove,
  onClose,
}: {
  message: Message;
  mine: boolean;
  myReaction: string | null;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !picking) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, picking]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(message.body);
      setCopied(true);
      setTimeout(onClose, 600);
    } catch {
      onClose();
    }
  }

  return (
    <div className={`tc-menu${mine ? " mine" : ""}`} role="menu" aria-label="Message options">
      {picking ? (
        <EmojiPanel
          onPick={(emoji) => {
            onReact(emoji);
            onClose();
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
      <div className="tc-react-bar" role="group" aria-label="React">
        {QUICK_REACTIONS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className={myReaction === emoji ? "on" : undefined}
            aria-label={myReaction === emoji ? `Remove ${emoji}` : `React ${emoji}`}
            onClick={() => {
              onReact(emoji);
              onClose();
            }}
          >
            {emoji}
          </button>
        ))}
        <button type="button" className="tc-react-more" aria-label="More emoji" onClick={() => setPicking(true)}>
          ＋
        </button>
      </div>
      <div className="tc-menu-items">
        <button type="button" role="menuitem" onClick={() => { onReply(); onClose(); }}>
          <span aria-hidden="true">↩</span> Reply
        </button>
        {message.body ? (
          <button type="button" role="menuitem" onClick={() => void copy()}>
            <span aria-hidden="true">⧉</span> {copied ? "Copied" : "Copy"}
          </button>
        ) : null}
        {mine && !message.deletedAt ? (
          <button type="button" role="menuitem" className="bad" onClick={() => { onRemove(); onClose(); }}>
            <span aria-hidden="true">🗑</span> Remove
          </button>
        ) : null}
      </div>
    </div>
  );
}
