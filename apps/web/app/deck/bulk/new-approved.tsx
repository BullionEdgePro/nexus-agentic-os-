"use client";

import { useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import {
  getBulkTemplateText,
  readableError,
  refreshBulkTemplates,
  rewriteBulkDraft,
  submitBulkTemplate,
  type BulkPendingMessage,
} from "@/lib/api";
import { previewTemplate } from "../my-campaigns/my-templates";
import { templateOptionLabel } from "@/lib/template-option-label";
import { AiWriter } from "./ai-writer";

/**
 * A new approved message, from the Approved tab (30 Oct 2026).
 *
 * Numbers just added have never written, so WhatsApp lets them get an approved
 * message only; this is where an admin gets new wording approved without
 * leaving the campaign. Write it (with AI or by hand), name it, send it to
 * WhatsApp, and watch it under "Waiting for WhatsApp". A refused one shows
 * WhatsApp's reason and can be rewritten by AI with that reason in hand;
 * WhatsApp keeps refused names, so the fixed one goes under a new name.
 */

function sinceSent(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const STATUS_WORDS: Record<string, string> = {
  PENDING: "waiting",
  IN_APPEAL: "under appeal",
  REJECTED: "refused",
  PAUSED: "paused by WhatsApp",
  DISABLED: "disabled by WhatsApp",
};

export function NewApproved({
  business,
  numberId,
  pending,
  sampleName,
  chosen,
  onChanged,
  onCampaignsChanged,
}: {
  business: BusinessSlug;
  numberId: string;
  pending: BulkPendingMessage[];
  sampleName: string | null;
  /** The customers ticked on the page: offered "then send to them" (3 Nov 2026). */
  chosen: string[];
  /** Reload the number; with an id, that message was just approved and is chosen. */
  onChanged: (approvedTemplateId?: string) => void;
  /** Reload Recent campaigns: one started waiting, or went out (review, 3 Nov 2026). */
  onCampaignsChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [language, setLanguage] = useState<"en" | "ar">("en");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"submit" | "check" | string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  /** `andSend`: also send it to the ticked customers once WhatsApp approves it (3 Nov 2026). */
  async function submit(andSend: boolean) {
    setBusy("submit");
    setNote(null);
    try {
      const sent = await submitBulkTemplate(business, numberId, {
        label: label.trim(),
        language,
        text: text.trim(),
        sendTo: andSend ? chosen : undefined,
      });
      setNote({
        ok: true,
        text: sent.waiting
          ? `Sent to WhatsApp for approval. Once approved — usually within minutes, sometimes a day — it goes to ${sent.waiting.recipients} ${sent.waiting.recipients === 1 ? "customer" : "customers"} by itself. It is under Recent campaigns, where you can cancel it until then.`
          : `Sent to WhatsApp as ${sent.name}. Approval usually takes minutes, sometimes a day; it appears in the list above once approved.`,
      });
      setLabel("");
      setText("");
      setOpen(false);
      onChanged();
      if (sent.waiting) onCampaignsChanged();
    } catch (err) {
      setNote({ ok: false, text: readableError(err, "It was not sent to WhatsApp.") });
    } finally {
      setBusy(null);
    }
  }

  async function checkAgain() {
    setBusy("check");
    setNote(null);
    try {
      const fresh = await refreshBulkTemplates(business, numberId);
      const released = fresh.released ?? [];
      const held = fresh.held ?? [];
      const going = released.reduce((sum, campaign) => sum + campaign.recipients, 0);
      if (released.length || held.length) onCampaignsChanged();
      const approved = fresh.templates.find((template) => pending.some((waiting) => waiting.name === template.name));
      const named = approved ? templateOptionLabel(approved.name, approved.language) : "your message";
      // Gone to the customers ticked when it was written: said so, and not chosen
      // above, where the same customers still ticked would send it to them again.
      if (going) {
        setNote({ ok: true, text: `WhatsApp approved ${named}. It is going to ${going} ${going === 1 ? "customer" : "customers"} now.` });
        onChanged();
      } else if (held.length) {
        setNote({ ok: false, text: `WhatsApp approved ${named}, but it has not gone out yet: ${held[0].reason}` });
        onChanged();
      } else {
        if (approved) setNote({ ok: true, text: `WhatsApp approved ${named}. It is chosen above.` });
        onChanged(approved?.id);
      }
    } catch (err) {
      setNote({ ok: false, text: readableError(err, "WhatsApp could not be reached just now. Try Check again in a minute.") });
    } finally {
      setBusy(null);
    }
  }

  /** Read the refused wording back, have AI fix it with WhatsApp's reason, and open it under a new name. */
  async function fixWithAi(message: BulkPendingMessage) {
    setBusy(message.id);
    setNote(null);
    try {
      const wording = await getBulkTemplateText(business, numberId, message.id);
      const body = (wording.text?.body ?? "").replace(/\{\{1\}\}/g, "{name}");
      const fixed = await rewriteBulkDraft(business, {
        kind: "approved",
        text: body,
        change: "fix",
        reason: message.reason ?? undefined,
      });
      setText(fixed.text);
      setLabel(`${message.label} 2`);
      setLanguage(message.language === "ar" ? "ar" : "en");
      setOpen(true);
    } catch (err) {
      setNote({ ok: false, text: readableError(err, "The AI is not available right now — write the message yourself.") });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="na">
      {pending.length ? (
        <div className="na-waiting">
          <div className="na-waiting-head">
            <strong>Waiting for WhatsApp</strong>
            <button type="button" className="bk-ghost" disabled={busy !== null} onClick={() => void checkAgain()}>
              {busy === "check" ? "Checking…" : "Check again"}
            </button>
          </div>
          <ul>
            {pending.map((message) => (
              <li key={message.id} className={`na-item na-${message.status.toLowerCase()}`}>
                <span>
                  <strong>{message.label}</strong> · {message.language} · sent {sinceSent(message.createdAt)} ·{" "}
                  {STATUS_WORDS[message.status] ?? message.status.toLowerCase()}
                </span>
                {message.reason ? <em>{message.reason}</em> : null}
                {message.status === "REJECTED" ? (
                  <button type="button" className="bk-ghost" disabled={busy !== null} onClick={() => void fixWithAi(message)}>
                    {busy === message.id ? "Fixing…" : "Ask AI to fix it"}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!open ? (
        <button type="button" className="bk-ghost ai-open" onClick={() => setOpen(true)}>
          ✨ Write a new approved message
        </button>
      ) : (
        <div className="na-form">
          <AiWriter
            business={business}
            kind="approved"
            sampleName={sampleName}
            current={text}
            onUse={setText}
            language={language}
            onLanguageChange={setLanguage}
          />
          <label className="na-field">
            <span>Message</span>
            <textarea
              rows={5}
              maxLength={1024}
              dir="auto"
              value={text}
              placeholder={"Hello {name}, viewings at Dubai Hills are open this weekend. Reply here to book your slot."}
              onChange={(event) => setText(event.target.value)}
            />
            <em>
              {text.length}/1024 · Write <b>{"{name}"}</b> for each client&rsquo;s first name. WhatsApp will not approve a
              message that starts or ends with it. A Stop button is added for people who want no more messages.
            </em>
          </label>
          {text.trim() ? (
            <p className="ai-bubble" dir="auto">
              {previewTemplate(text.trim(), sampleName)}
            </p>
          ) : null}
          <div className="na-row">
            <label className="na-field na-label">
              <span>Short name</span>
              <input maxLength={60} value={label} placeholder="Weekend viewings" onChange={(event) => setLabel(event.target.value)} />
            </label>
            <div className="ai-choice" role="radiogroup" aria-label="Language">
              {(
                [
                  ["en", "English"],
                  ["ar", "Arabic"],
                ] as Array<["en" | "ar", string]>
              ).map(([key, words]) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={language === key}
                  className={`ct-chip ${language === key ? "on" : ""}`}
                  onClick={() => setLanguage(key)}
                >
                  {words}
                </button>
              ))}
            </div>
          </div>
          <div className="ai-actions">
            {chosen.length ? (
              <>
                <button
                  type="button"
                  className="cmp-go"
                  disabled={busy !== null || !label.trim() || !text.trim()}
                  onClick={() => void submit(true)}
                >
                  {busy === "submit"
                    ? "Sending to WhatsApp…"
                    : `Send for approval, then send to ${chosen.length} ${chosen.length === 1 ? "customer" : "customers"}`}
                </button>
                <button
                  type="button"
                  className="bk-ghost"
                  disabled={busy !== null || !label.trim() || !text.trim()}
                  onClick={() => void submit(false)}
                >
                  Only send for approval
                </button>
              </>
            ) : (
              <button
                type="button"
                className="cmp-go"
                disabled={busy !== null || !label.trim() || !text.trim()}
                onClick={() => void submit(false)}
              >
                {busy === "submit" ? "Sending to WhatsApp…" : "Send to WhatsApp for approval"}
              </button>
            )}
            <button type="button" className="bk-ghost" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          {chosen.length ? (
            <p className="ai-sample">
              WhatsApp checks every new message first, usually within minutes, sometimes a day. Once it is approved it goes to
              the {chosen.length === 1 ? "customer" : `${chosen.length} customers`} you ticked by itself, and you can cancel it
              under Recent campaigns until then.
            </p>
          ) : null}
        </div>
      )}

      {note ? <p className={note.ok ? "cmp-test-ok" : "mc-error"}>{note.text}</p> : null}
    </div>
  );
}
