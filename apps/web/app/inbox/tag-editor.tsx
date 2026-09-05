"use client";

import { useState } from "react";

/**
 * The labels on the open conversation, and adding or removing one.
 *
 * Holds the WHOLE set and hands the whole set back on every change, matching the
 * server (a replace, not add/remove) so the two can never disagree about which
 * labels are on the thread. Suggestions are the labels already in use across the
 * loaded inbox, so a business's vocabulary converges without a tag table to
 * manage — type "ra" and last week's "Rate customer" is one keystroke away.
 */
export function TagEditor({
  tags,
  suggestions,
  onChange,
}: {
  tags: string[];
  suggestions: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  const add = (raw: string) => {
    const label = raw.trim().slice(0, 40);
    if (!label) return;
    // De-dupe case-insensitively, keeping the spelling already on the thread.
    if (tags.some((t) => t.toLowerCase() === label.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...tags, label]);
    setDraft("");
  };
  const remove = (label: string) => onChange(tags.filter((t) => t !== label));

  // Suggestions not already on this conversation, matched against what is typed.
  const q = draft.trim().toLowerCase();
  const options = suggestions
    .filter((s) => !tags.some((t) => t.toLowerCase() === s.toLowerCase()))
    .filter((s) => (q ? s.toLowerCase().includes(q) : true))
    .slice(0, 6);

  return (
    <div className="ibx-tags">
      {tags.map((t) => (
        <span key={t} className="ibx-tag">
          {t}
          <button type="button" className="ibx-tag-x" aria-label={`Remove ${t}`} onClick={() => remove(t)}>
            ×
          </button>
        </span>
      ))}
      <span className="ibx-tag-add">
        <input
          className="ibx-tag-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
            } else if (e.key === "Backspace" && !draft && tags.length) {
              remove(tags[tags.length - 1]);
            }
          }}
          placeholder="+ label"
          list="ibx-tag-suggestions"
          aria-label="Add a label"
        />
        {/* A datalist gives native suggestions with no dropdown to build. The
            filtered list is also rendered as quick-add chips below, for reuse. */}
        <datalist id="ibx-tag-suggestions">
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </span>
      {options.length ? (
        <span className="ibx-tag-opts">
          {options.map((s) => (
            <button key={s} type="button" className="ibx-tag-opt" onClick={() => add(s)}>
              {s}
            </button>
          ))}
        </span>
      ) : null}
    </div>
  );
}
