"use client";

import { useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import { readableError, rewriteBulkDraft, writeBulkDrafts, type BulkMessageKind } from "@/lib/api";
import { previewTemplate } from "../my-campaigns/my-templates";

/**
 * ✨ Write with AI (30 Oct 2026).
 *
 * A one-line brief and three choices in, three drafts out, each shown the way
 * the client will read it (their first name filled in). "Use this" puts a
 * draft in the editor; the editor's own text can be made shorter, more formal
 * or Arabic. The AI only ever suggests: the editor is the admin's, and the
 * page's review step still comes before anything is sent.
 */

type Change = "shorter" | "formal" | "arabic";

function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<[T, string]>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="ai-choice" role="radiogroup" aria-label={label}>
      {options.map(([key, words]) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={value === key}
          className={`ct-chip ${value === key ? "on" : ""}`}
          onClick={() => onChange(key)}
        >
          {words}
        </button>
      ))}
    </div>
  );
}

export function AiWriter({
  business,
  kind,
  sampleName,
  current,
  onUse,
  language: languageProp,
  onLanguageChange,
}: {
  business: BusinessSlug;
  kind: BulkMessageKind;
  /** The first chosen client's name, so a draft reads as it will arrive. */
  sampleName: string | null;
  /** What the editor holds now: the text Shorter / More formal / Arabic act on. */
  current: string;
  onUse: (text: string) => void;
  /**
   * The message's language when the page owns it (a new approved message is
   * submitted in ONE language, so the writer and the submission must agree).
   */
  language?: "en" | "ar";
  onLanguageChange?: (language: "en" | "ar") => void;
}) {
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState("");
  const [tone, setTone] = useState<"friendly" | "professional">("friendly");
  const [length, setLength] = useState<"short" | "detailed">("short");
  const [ownLanguage, setOwnLanguage] = useState<"en" | "ar">("en");
  const language = languageProp ?? ownLanguage;
  const setLanguage = (next: "en" | "ar") => (onLanguageChange ? onLanguageChange(next) : setOwnLanguage(next));
  const [drafts, setDrafts] = useState<string[]>([]);
  const [busy, setBusy] = useState<"write" | Change | null>(null);
  const [error, setError] = useState("");

  async function write() {
    setBusy("write");
    setError("");
    setDrafts([]);
    try {
      const data = await writeBulkDrafts(business, { kind, brief: brief.trim(), tone, length, language });
      setDrafts(data.drafts);
    } catch (err) {
      setError(readableError(err, "The AI is not available right now — write the message yourself."));
    } finally {
      setBusy(null);
    }
  }

  async function change(change: Change) {
    setBusy(change);
    setError("");
    try {
      const data = await rewriteBulkDraft(business, { kind, text: current, change });
      onUse(data.text);
      // The message is Arabic now; a page that owns the language must know.
      if (change === "arabic") onLanguageChange?.("ar");
    } catch (err) {
      setError(readableError(err, "The AI is not available right now — write the message yourself."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="ai-writer">
      {!open ? (
        <button type="button" className="bk-ghost ai-open" onClick={() => setOpen(true)}>
          ✨ Write with AI
        </button>
      ) : (
        <div className="ai-panel">
          <label className="ai-brief">
            <span>What is the message about?</span>
            <textarea
              rows={2}
              maxLength={500}
              value={brief}
              placeholder="Weekend viewings at Dubai Hills — reply to book a slot"
              onChange={(event) => setBrief(event.target.value)}
            />
            <em>
              {brief.length}/500 · The AI writes from this and nothing else, so give it any price, date or offer you want
              in the message.
            </em>
          </label>
          <div className="ai-choices">
            <Choice label="Tone" options={[["friendly", "Friendly"], ["professional", "Professional"]]} value={tone} onChange={setTone} />
            <Choice label="Length" options={[["short", "Short"], ["detailed", "Detailed"]]} value={length} onChange={setLength} />
            <Choice label="Language" options={[["en", "English"], ["ar", "Arabic"]]} value={language} onChange={setLanguage} />
          </div>
          <div className="ai-actions">
            <button type="button" className="cmp-go" disabled={busy !== null || !brief.trim()} onClick={() => void write()}>
              {busy === "write" ? "Writing 3 drafts…" : "Write 3 drafts"}
            </button>
            <button type="button" className="bk-ghost" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          {drafts.length ? (
            <div className="ai-drafts">
              {drafts.map((draft, index) => (
                <div className="ai-draft" key={`${index}-${draft.slice(0, 12)}`}>
                  <p className="ai-bubble" dir="auto">
                    {previewTemplate(draft, sampleName)}
                  </p>
                  <div className="ai-draft-foot">
                    <span>{draft.length} characters</span>
                    <button type="button" className="bk-ghost" onClick={() => onUse(draft)}>
                      Use this
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}

      {current.trim() ? (
        <div className="ai-rewrite" role="group" aria-label="Change the message with AI">
          <span>✨ Change the message:</span>
          {(
            [
              ["shorter", "Shorter"],
              ["formal", "More formal"],
              ["arabic", "Arabic version"],
            ] as Array<[Change, string]>
          ).map(([key, words]) => (
            <button key={key} type="button" className="bk-ghost" disabled={busy !== null} onClick={() => void change(key)}>
              {busy === key ? "Changing…" : words}
            </button>
          ))}
        </div>
      ) : null}

      {error ? <p className="mc-error">{error}</p> : null}
    </div>
  );
}
