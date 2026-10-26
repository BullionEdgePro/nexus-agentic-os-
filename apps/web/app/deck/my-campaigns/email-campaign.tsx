"use client";

import { useState } from "react";
import { readableError, type EmailCampaignSide } from "@/lib/api";
import { describePlan } from "./describe-plan";
import "./email-campaign.css";

/**
 * Writing and sending an email campaign (26 Oct 2026). Used by My campaigns (a
 * staff member's own book) and by Campaigns (a whole business), so both say the
 * same things in the same order before anything goes out:
 *
 *   who it reaches · which mailbox · how it is paced · what it looks like
 *
 * Email needs no Meta approval, so it is written here rather than picked from a
 * list — which makes the preview and the test the safety net instead.
 */
export interface EmailCampaignFormProps {
  side: EmailCampaignSide;
  /** "your book" / "Zipicka" — completes "everyone in … who can be emailed". */
  audienceLabel: string;
  /** Named recipients for the confirmation; omitted, it shows the count only. */
  audience?: Array<{ displayName: string | null; email: string }>;
  /** Whose name fills {name} in the preview. */
  sampleName: string | null;
  initialSubject?: string;
  defaultTestTo?: string;
  onSend: (input: { subject: string; body: string }) => Promise<{ enqueued: number; plan: number[] }>;
  onTest?: (input: { subject: string; body: string; to: string }) => Promise<unknown>;
  onPolish?: (text: string) => Promise<string>;
  onSent?: () => void;
}

const firstName = (name: string | null) => (name ?? "").trim().split(/\s+/)[0] || "there";
const fill = (text: string, name: string | null) => text.split("{name}").join(firstName(name));
const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;


/**
 * Resume and Stop on a campaign row. A paused campaign used to be paused for
 * ever; now it can be finished either way. Stop asks once — it cannot be undone.
 */
export function CampaignControls({
  status,
  act,
  onDone,
}: {
  status: string;
  act: (action: "resume" | "stop") => Promise<unknown>;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (status !== "paused" && status !== "sending") return null;
  const run = async (action: "resume" | "stop") => {
    if (action === "stop" && !window.confirm("Stop this campaign for good? Nobody it hasn't reached yet will get it.")) return;
    setBusy(true);
    setError(null);
    try {
      await act(action);
      onDone();
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="ecf-controls">
      {status === "paused" ? (
        <button type="button" disabled={busy} onClick={() => void run("resume")}>
          Resume
        </button>
      ) : null}
      <button type="button" disabled={busy} onClick={() => void run("stop")}>
        Stop
      </button>
      {error ? <span className="ecf-error">{error}</span> : null}
    </span>
  );
}

export function EmailCampaignForm(props: EmailCampaignFormProps) {
  const { side } = props;
  const [subject, setSubject] = useState(props.initialSubject ?? "");
  const [body, setBody] = useState("");
  const [polishing, setPolishing] = useState(false);
  const [testTo, setTestTo] = useState(props.defaultTestTo ?? "");
  const [testing, setTesting] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<{ enqueued: number; plan: number[] } | null>(null);

  const written = subject.trim() !== "" && body.trim() !== "";
  const canSend = written && side.reachable > 0 && !side.fromError;

  if (side.fromError) {
    return <p className="ecf-blocked">{side.fromError}</p>;
  }

  return (
    <div className="ecf">
      <p className="ecf-facts">
        <strong>{people(side.reachable)}</strong> in {props.audienceLabel} can be emailed · from{" "}
        <strong>{side.from}</strong>
      </p>
      {side.reachable === 0 ? (
        <p className="ecf-note">
          Nobody here has an email address on file yet, or everyone has unsubscribed. Customers who email
          your mailbox join by themselves.
        </p>
      ) : null}

      <label className="ecf-field">
        <span>Subject</span>
        <input
          value={subject}
          maxLength={200}
          placeholder="Our new arrivals are in, {name}"
          onChange={(e) => {
            setSubject(e.target.value);
            setDone(null);
          }}
        />
      </label>

      <label className="ecf-field">
        <span>
          Message
          <button
            type="button"
            className="ecf-chip"
            onClick={() => setBody((b) => `${b}${b && !b.endsWith(" ") && !b.endsWith("\n") ? " " : ""}{name}`)}
          >
            + {"{name}"}
          </button>
          {props.onPolish ? (
            <button
              type="button"
              className="ecf-chip"
              disabled={polishing || !body.trim()}
              onClick={async () => {
                setPolishing(true);
                setNote(null);
                try {
                  setBody(await props.onPolish!(body));
                } catch (err) {
                  setNote({ ok: false, text: readableError(err) });
                } finally {
                  setPolishing(false);
                }
              }}
            >
              {polishing ? "Polishing…" : "Polish"}
            </button>
          ) : null}
        </span>
        <textarea
          rows={8}
          maxLength={10000}
          value={body}
          placeholder={"Hi {name},\n\nWrite it the way you would to one customer — each person gets their own email."}
          onChange={(e) => {
            setBody(e.target.value);
            setDone(null);
          }}
        />
        <em>{"{name}"} becomes each customer&rsquo;s first name, or &ldquo;there&rdquo; if we don&rsquo;t have one.</em>
      </label>

      {written ? (
        <div className="ecf-preview" aria-label="Preview">
          <p className="ecf-preview-head">
            <span>To {firstName(props.sampleName)}</span>
            <strong>{fill(subject, props.sampleName)}</strong>
          </p>
          <div className="ecf-preview-body">{fill(body, props.sampleName)}</div>
          <p className="ecf-preview-foot">Don&rsquo;t want these emails? Unsubscribe</p>
        </div>
      ) : null}

      {written && props.onTest ? (
        <div className="ecf-test">
          <label>
            <span>Send me a test first</span>
            <input
              type="email"
              value={testTo}
              placeholder="you@example.com"
              onChange={(e) => {
                setTestTo(e.target.value);
                setNote(null);
              }}
            />
          </label>
          <button
            type="button"
            disabled={testing || !testTo.trim()}
            onClick={async () => {
              setTesting(true);
              setNote(null);
              try {
                await props.onTest!({ subject, body, to: testTo.trim() });
                setNote({ ok: true, text: `Test sent to ${testTo.trim()}. Check it looks right before sending to everyone.` });
              } catch (err) {
                setNote({ ok: false, text: readableError(err) });
              } finally {
                setTesting(false);
              }
            }}
          >
            {testing ? "Sending test…" : "Send test"}
          </button>
        </div>
      ) : null}

      {note ? <p className={note.ok ? "ecf-ok" : "ecf-error"}>{note.text}</p> : null}

      {side.reachable > 0 ? <p className="ecf-plan">{describePlan(side.plan)}</p> : null}

      {!confirming ? (
        <button type="button" className="ecf-go" disabled={!canSend} onClick={() => setConfirming(true)}>
          Review before sending
        </button>
      ) : (
        <div className="ecf-confirm">
          <h3>This will email {people(side.reachable)}</h3>
          {props.audience?.length ? (
            <ul className="ecf-who">
              {props.audience.map((person) => (
                <li key={person.email}>
                  {person.displayName ?? "Unnamed"} <span>{person.email}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="ecf-final">
            &ldquo;{subject.trim()}&rdquo; from <strong>{side.from}</strong>, one email each. It can be stopped
            part-way, but an email already sent cannot be recalled.
          </p>
          <div className="ecf-actions">
            <button
              type="button"
              className="ecf-go"
              disabled={sending}
              onClick={async () => {
                setSending(true);
                setNote(null);
                try {
                  const result = await props.onSend({ subject: subject.trim(), body: body.trim() });
                  setDone(result);
                  setConfirming(false);
                  setSubject("");
                  setBody("");
                  props.onSent?.();
                } catch (err) {
                  setNote({ ok: false, text: readableError(err, "Nothing was sent.") });
                } finally {
                  setSending(false);
                }
              }}
            >
              {sending ? "Sending…" : `Email ${people(side.reachable)}`}
            </button>
            <button type="button" className="ecf-cancel" onClick={() => setConfirming(false)}>
              Not yet
            </button>
          </div>
        </div>
      )}

      {done ? (
        <p className="ecf-ok">
          Queued to {people(done.enqueued)}. {describePlan(done.plan)} Progress shows below as each email goes.
        </p>
      ) : null}
    </div>
  );
}
