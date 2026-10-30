"use client";

import { useState } from "react";
import { readableError, sendQuickMessage } from "@/lib/api";
import { previewTemplate } from "./my-templates";

/**
 * A message in your own words, sent now, with no WhatsApp approval (29 Oct 2026).
 *
 * WhatsApp allows free text only to people who wrote to the number in the last
 * 24 hours; everybody else needs an approved message. So this goes to exactly
 * those people, names them before anything is sent, and says plainly who it
 * cannot reach and why — the rule is Meta's, and pretending otherwise would
 * get the number blocked.
 */
export function QuickMessage({
  ownNumber,
  people,
  bookSize,
  contactIds,
  onSent,
  send,
  where = "your WhatsApp",
}: {
  ownNumber: boolean;
  people: Array<{ displayName: string | null; waId: string; lastInboundAt: string | null }>;
  bookSize: number;
  /** The clients chosen in the Clients tab, when some were (30 Oct 2026). */
  contactIds?: string[];
  onSent: () => void;
  /** How to send; the admin page sends from the number it chose (30 Oct 2026). */
  send?: (text: string) => Promise<{ sent: number; failed: Array<{ name: string; reason: string }> }>;
  /** What "written to …" refers to: "your WhatsApp", or the chosen number. */
  where?: string;
}) {
  const [text, setText] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; failed?: Array<{ name: string; reason: string }> } | null>(
    null
  );

  const count = people.length;
  const others = Math.max(0, bookSize - count);

  return (
    <section className="cmp-compose qm" aria-label="Quick message">
      <h2>Quick message — no approval needed</h2>
      {!ownNumber ? (
        <p className="mc-empty">Quick messages go from your own WhatsApp number. Connect it in Connections first.</p>
      ) : (
        <>
          <p className="cmp-facts">
            <strong>{count}</strong> {count === 1 ? "client has" : "clients have"} written to {where} in the last 24
            hours, so you can send them anything, right now, free.
            {others > 0 ? (
              <>
                {" "}
                {others === 1 ? "The other client needs" : (
                  <>
                    The other <strong>{others}</strong> need
                  </>
                )}{" "}
                an approved message — that is WhatsApp&rsquo;s rule.
              </>
            ) : null}
          </p>

          {count === 0 ? (
            <p className="mc-empty">
              Nobody is inside the 24 hours yet. When a client writes to you, they can get a quick message for the next
              day.
            </p>
          ) : (
            <>
              <label className="qm-field">
                <span>Your message</span>
                <textarea
                  rows={4}
                  maxLength={4096}
                  value={text}
                  placeholder={"Hi {name}, thanks for your message — here are today's options…"}
                  onChange={(event) => {
                    setText(event.target.value);
                    setConfirming(false);
                    setResult(null);
                  }}
                />
                <em>
                  Write <b>{"{name}"}</b> for each client&rsquo;s first name.
                </em>
              </label>

              {text.trim() ? (
                <div className="mt-preview">
                  <span>Preview</span>
                  <p>{previewTemplate(text.trim(), people[0]?.displayName ?? null)}</p>
                </div>
              ) : null}

              {!confirming ? (
                <button type="button" className="cmp-go" disabled={!text.trim()} onClick={() => setConfirming(true)}>
                  Review before sending
                </button>
              ) : (
                <div className="cmp-confirm">
                  <h3>
                    This sends now to {count} {count === 1 ? "person" : "people"}
                  </h3>
                  <ul className="cmp-who">
                    {people.map((person) => (
                      <li key={person.waId}>
                        {person.displayName ?? "Unnamed"} <span>+{person.waId}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="cmp-actions">
                    <button
                      type="button"
                      className="cmp-go"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        setResult(null);
                        try {
                          const outcome = send ? await send(text.trim()) : await sendQuickMessage(text.trim(), contactIds);
                          setResult({
                            ok: outcome.failed.length === 0,
                            text: `Sent to ${outcome.sent} ${outcome.sent === 1 ? "person" : "people"}${
                              outcome.failed.length ? `; ${outcome.failed.length} could not be sent` : ""
                            }. Each one is in that client's conversation.`,
                            failed: outcome.failed,
                          });
                          setConfirming(false);
                          if (outcome.sent > 0) setText("");
                          onSent();
                        } catch (err) {
                          setResult({ ok: false, text: readableError(err, "Nothing was sent.") });
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      {busy ? "Sending…" : `Send now to ${count} ${count === 1 ? "person" : "people"}`}
                    </button>
                    <button type="button" className="cmp-cancel" onClick={() => setConfirming(false)}>
                      Not yet
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {result ? (
            <div>
              <p className={result.ok ? "cmp-test-ok" : "mc-error"}>{result.text}</p>
              {result.failed?.length ? (
                <ul className="cmp-why">
                  {result.failed.map((failure) => (
                    <li key={failure.name}>
                      {failure.name}: {failure.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
