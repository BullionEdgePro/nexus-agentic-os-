"use client";

import { useState } from "react";
import { createMyTemplate, readableError, refreshMyTemplates, type MyTemplate } from "@/lib/api";

/**
 * A staff member's own campaign messages (28 Oct 2026).
 *
 * WhatsApp only lets a campaign open with a message it has approved, so writing
 * one here SUBMITS it — it is not sendable until Meta says yes, which takes
 * minutes to a day. The screen says that at every step, because a message that
 * sits in "waiting" with no explanation reads as broken.
 *
 * Each message is this person's alone: colleagues never see it in their list.
 */

const STATUS: Record<string, { word: string; tone: "ok" | "wait" | "no" }> = {
  APPROVED: { word: "Approved — ready to send", tone: "ok" },
  PENDING: { word: "Waiting for WhatsApp to approve", tone: "wait" },
  IN_APPEAL: { word: "Appealed — waiting for WhatsApp", tone: "wait" },
  REJECTED: { word: "Rejected by WhatsApp", tone: "no" },
  PAUSED: { word: "Paused by WhatsApp (people reported it)", tone: "no" },
  DISABLED: { word: "Switched off by WhatsApp", tone: "no" },
};

/** What the message will look like, with {name} filled by a sample name. */
export function previewTemplate(text: string, sampleName: string | null): string {
  return text.replace(/\{name\}/gi, sampleName?.split(/\s+/)[0] || "Sara");
}

export function MyTemplates({
  templates,
  sampleName,
  onChanged,
}: {
  templates: MyTemplate[];
  sampleName: string | null;
  onChanged: () => void;
}) {
  const [writing, setWriting] = useState(false);
  const [label, setLabel] = useState("");
  const [language, setLanguage] = useState<"en" | "ar">("en");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit() {
    setBusy(true);
    setNote(null);
    try {
      await createMyTemplate({ label: label.trim(), language, text });
      setNote({
        ok: true,
        text: "Sent to WhatsApp for approval. It usually takes a few minutes, sometimes up to a day. It appears in the message list above once approved.",
      });
      setLabel("");
      setText("");
      setWriting(false);
      onChanged();
    } catch (err) {
      setNote({ ok: false, text: readableError(err) });
    } finally {
      setBusy(false);
    }
  }

  async function checkAgain() {
    setBusy(true);
    setNote(null);
    try {
      await refreshMyTemplates();
      onChanged();
    } catch (err) {
      setNote({ ok: false, text: readableError(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-own" aria-label="Your own messages">
      <h3>Your own messages</h3>
      {templates.length ? (
        <ul className="mt-list">
          {templates.map((template) => {
            const status = STATUS[template.status] ?? { word: template.status, tone: "wait" as const };
            return (
              <li key={template.id}>
                <span className="mt-name">
                  {template.label} <em>({template.language})</em>
                </span>
                <span className={`mt-status mt-${status.tone}`}>{status.word}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-hint">You have not written one yet. Only you can see and send the ones you write.</p>
      )}

      <div className="mt-actions">
        {!writing ? (
          <button type="button" className="cmp-link" onClick={() => setWriting(true)}>
            Write a new message
          </button>
        ) : null}
        {templates.some((template) => !template.isApproved) ? (
          <button type="button" className="cmp-link" disabled={busy} onClick={() => void checkAgain()}>
            {busy && !writing ? "Asking WhatsApp…" : "Check approval again"}
          </button>
        ) : null}
      </div>

      {writing ? (
        <div className="mt-form">
          <label>
            <span>Name (only you see this)</span>
            <input value={label} maxLength={60} placeholder="November offer" onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label>
            <span>Language</span>
            <select value={language} onChange={(e) => setLanguage(e.target.value === "ar" ? "ar" : "en")}>
              <option value="en">English</option>
              <option value="ar">Arabic</option>
            </select>
          </label>
          <label>
            <span>Message</span>
            <textarea
              rows={5}
              maxLength={1024}
              value={text}
              dir={language === "ar" ? "rtl" : "ltr"}
              placeholder={"Hello {name}, we have new options this month. Reply here and I will send you the details."}
              onChange={(e) => setText(e.target.value)}
            />
            <em>
              Write <b>{"{name}"}</b> where the client&rsquo;s first name goes — not at the very start or end.
              A &ldquo;Stop&rdquo; button is added so people can opt out.
            </em>
          </label>
          {text.trim() ? (
            <div className="mt-preview" dir={language === "ar" ? "rtl" : "ltr"}>
              <span>Preview</span>
              <p>{previewTemplate(text.trim(), sampleName)}</p>
              <button type="button" tabIndex={-1}>
                {language === "ar" ? "إيقاف" : "Stop"}
              </button>
            </div>
          ) : null}
          <div className="mt-actions">
            <button
              type="button"
              className="cmp-go"
              disabled={busy || !label.trim() || !text.trim()}
              onClick={() => void submit()}
            >
              {busy ? "Sending to WhatsApp…" : "Send to WhatsApp for approval"}
            </button>
            <button type="button" className="cmp-cancel" onClick={() => setWriting(false)}>
              Not now
            </button>
          </div>
        </div>
      ) : null}

      {note ? <p className={note.ok ? "cmp-test-ok" : "mc-error"}>{note.text}</p> : null}
    </section>
  );
}
