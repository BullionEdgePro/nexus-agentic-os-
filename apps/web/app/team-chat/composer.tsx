"use client";

import { useRef, useState } from "react";
import type { TeamColleague } from "@/lib/api";
import type { TeamThreadState } from "@/lib/use-team-thread";
import { play } from "@/lib/sound";
import { formatClock } from "@/lib/team-chat/waveform";
import { EmojiPanel } from "./emoji-panel";
import { VoiceRecorder } from "./voice-recorder";
import { AttachButton, AttachSheet, DropZone } from "./attach";

/**
 * The one message box for team chat (2 Nov 2026), on the Team chat page and in
 * the dock beside the inbox: 😊 emoji, 📎 attach, the text, and one round
 * button that is 🎤 while the box is empty and ➤ once there is text — the
 * WhatsApp shape. @mentions and the reply being written live here too.
 *
 * The parent mounts it with key={thread id}, so each chat gets a fresh box: a
 * draft, a reply or a recording never follows you into another chat.
 */
type Message = TeamThreadState["messages"][number];

function quoteOf(message: Message): string {
  if (message.file?.kind === "voice") return `🎤 Voice note ${formatClock(message.file.durationMs ?? 0)}`;
  if (message.file?.kind === "photo") return `📷 ${message.body || "Photo"}`;
  if (message.file?.kind === "file") return `📄 ${message.file.name}`;
  return [...message.body].slice(0, 120).join("");
}

const extensionOf = (mime: string) => (mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm");

export function TeamComposer({
  thread,
  colleagues,
  placeholder,
  compact = false,
}: {
  thread: TeamThreadState;
  /** Who may be @mentioned here: everyone in a room, the other person in a direct chat. */
  colleagues: TeamColleague[];
  placeholder: string;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [mentionIds, setMentionIds] = useState<Record<string, string>>({});
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [attached, setAttached] = useState<File[] | null>(null);
  const box = useRef<HTMLTextAreaElement | null>(null);

  if (!thread.canPost) return null;

  function send() {
    const body = draft.trim();
    const mentions = Object.entries(mentionIds)
      .filter(([name]) => body.includes(`@${name}`))
      .map(([, id]) => id);
    if (!thread.send(body, mentions)) return;
    play("pop");
    setDraft("");
    setMentionIds({});
    setEmojiOpen(false);
  }

  // "@" at the end of the draft offers colleagues.
  const mentionQuery = /(?:^|\s)@([\p{L}\p{N} ]{0,30})$/u.exec(draft)?.[1] ?? null;
  const suggestions =
    mentionQuery === null
      ? []
      : colleagues.filter((c) => c.fullName.toLowerCase().startsWith(mentionQuery.toLowerCase())).slice(0, 6);
  function pickMention(colleague: TeamColleague) {
    setDraft((text) => text.replace(/@([\p{L}\p{N} ]{0,30})$/u, `@${colleague.fullName} `));
    setMentionIds((ids) => ({ ...ids, [colleague.fullName]: colleague.id }));
    box.current?.focus();
  }

  /** An emoji goes where the caret is, and the caret moves past it. */
  function insertEmoji(emoji: string) {
    const el = box.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    const next = draft.slice(0, start) + emoji + draft.slice(end);
    setDraft(next);
    thread.notifyTyping();
    requestAnimationFrame(() => {
      if (!el) return;
      const at = start + emoji.length;
      el.setSelectionRange(at, at);
      // On a phone, focusing would raise the keyboard over the emoji panel.
      if (window.matchMedia("(pointer: fine)").matches) el.focus();
    });
  }

  return (
    <DropZone onFiles={(files) => setAttached(files)}>
    <div className={`tc-composer${compact ? " compact" : ""}`}>
      {attached ? (
        <AttachSheet
          files={attached}
          onClose={() => setAttached(null)}
          onSend={(ready, caption) => {
            let sent = false;
            ready.forEach((item, index) => {
              // The caption goes with the first, as WhatsApp sends an album.
              if (thread.sendFile(item, index === 0 ? caption : "")) sent = true;
            });
            if (sent) play("pop");
            setAttached(null);
          }}
        />
      ) : null}
      {emojiOpen ? <EmojiPanel onPick={insertEmoji} onClose={() => setEmojiOpen(false)} /> : null}
      {thread.replyingTo ? (
        <div className="tc-reply-strip">
          <div>
            <b>{thread.replyingTo.authorName}</b>
            <span>{thread.replyingTo.deletedAt ? "Message removed" : quoteOf(thread.replyingTo)}</span>
          </div>
          <button type="button" aria-label="Cancel reply" onClick={() => thread.setReplyingTo(null)}>
            ×
          </button>
        </div>
      ) : null}
      <form
        className="tc-compose"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        {suggestions.length > 0 ? (
          <ul className="tc-suggest" role="listbox" aria-label="Mention a colleague">
            {suggestions.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => pickMention(c)}>
                  @{c.fullName}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="tc-field">
          <button
            type="button"
            className="tc-icon-btn"
            aria-label={emojiOpen ? "Close emoji" : "Emoji"}
            aria-expanded={emojiOpen}
            onClick={() => setEmojiOpen((open) => !open)}
          >
            {emojiOpen ? "⌨️" : "😊"}
          </button>
          <textarea
            ref={box}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              thread.notifyTyping();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (suggestions.length > 0) pickMention(suggestions[0]!);
                else send();
              }
            }}
            placeholder={placeholder}
            rows={1}
            maxLength={4000}
            aria-label="Message"
          />
          <AttachButton onFiles={(files) => setAttached(files)} />
        </div>
        {draft.trim() ? (
          <button type="submit" className="tc-round" aria-label="Send">
            ➤
          </button>
        ) : (
          <VoiceRecorder
            disabled={false}
            onSend={(note) => {
              if (
                thread.sendFile({
                  kind: "voice",
                  blob: note.blob,
                  name: `voice-note.${extensionOf(note.mime)}`,
                  durationMs: note.durationMs,
                  waveform: note.waveform,
                })
              ) {
                play("pop");
              }
            }}
          />
        )}
      </form>
    </div>
    </DropZone>
  );
}
