"use client";

import { useEffect, useState } from "react";
import { getMyLink, readableError, updateMe, type MyLink } from "@/lib/api";

/**
 * The link a staff member puts on their own socials, and the number it hands
 * customers to.
 *
 * ============================================================
 * THE INSTRUCTION THAT COULD NOT BE FOLLOWED
 * ============================================================
 *
 * This panel used to tell somebody with no number on file to "open the account
 * menu at the top right". There is no account menu at the top right. It is
 * rendered by `deck-console`, which is the OPERATOR's console; `ConsoleShell`,
 * which is what an employee gets, has a rail and no header at all.
 *
 * So staff could not add the one field that makes their link work, and both
 * places that mentioned it sent them somewhere that does not exist. The API had
 * accepted `whatsappNumber` from an employee the whole time — the gap was only
 * ever a control.
 *
 * It is HERE rather than behind a settings screen because this is where a
 * person finds out it is missing. A screen that explains a problem and then
 * sends you elsewhere to fix it loses most people at the doorway.
 *
 * ============================================================
 * WHY THE PANEL ARGUES FOR ITSELF
 * ============================================================
 *
 * A staff member reading this can already paste their own WhatsApp link into an
 * Instagram bio and wonder why they should use ours. The answer is not "policy"
 * and the panel gives the real one: their own link produces a lead nobody can
 * see — no record, no answer while they sleep, nothing to hand over when they
 * leave, and no way to know which post worked.
 */
export function MyLinkPanel() {
  const [link, setLink] = useState<MyLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () =>
    getMyLink()
      .then(setLink)
      .catch((err) => setError(readableError(err, "Could not load your link.")));

  useEffect(() => {
    void load();
  }, []);

  if (error) return <p className="mc-empty">{error}</p>;
  if (!link) return null;

  return (
    <section className="lnk">
      <h2>Your link</h2>

      {link.url ? (
        <>
          <p className="lnk-what">
            Put this on your Instagram, TikTok, LinkedIn, email signature — anywhere you already send
            people. Whoever taps it messages the company number, the assistant answers them and
            passes them straight to your WhatsApp, and they land in <strong>your</strong> client book
            at the same moment.
          </p>

          <div className="lnk-box">
            <code>{link.url}</code>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(link.url as string);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch {
                  // Clipboard refused — a permission, a non-secure origin, an
                  // older browser. The link is on screen and selectable, so this
                  // is a convenience that failed, not a broken feature.
                  setCopied(false);
                }
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>

          <NumberSetter link={link} onSaved={load} />

          <p className="lnk-stats">
            {link.performance.conversations === 0 ? (
              <>Nobody has used it yet.</>
            ) : (
              <>
                <strong>{link.performance.conversations}</strong>{" "}
                {link.performance.conversations === 1 ? "conversation" : "conversations"} from{" "}
                <strong>{link.performance.clients}</strong>{" "}
                {link.performance.clients === 1 ? "person" : "people"} have come through it.
              </>
            )}
          </p>

          <details className="lnk-why">
            <summary>Why not just post my own WhatsApp number?</summary>
            <p>
              You can, and some of your customers will always reach you that way. What you lose is
              everything around it: nobody covers you when you are asleep or on leave, there is no
              record if a customer says something was promised, the work cannot be handed over if
              you move on, and neither you nor anyone else can tell which post actually brought
              business in. This link keeps all of that and still ends with the customer in your
              WhatsApp.
            </p>
          </details>
        </>
      ) : (
        <p className="mc-empty">{link.unavailableReason}</p>
      )}
    </section>
  );
}

/**
 * Setting the number customers get handed to.
 *
 * Two states, and the difference matters more than it looks. With a number, the
 * only useful control is a way to CHECK it — a number is stored exactly as
 * typed, so it is either well formed or refused, and well formed is not the
 * same as yours. One wrong digit is a valid number belonging to a stranger, and
 * the way anybody would find out is a customer arriving in that stranger's
 * chat. Without one, the field is right here, because this is the screen where
 * the person learns it is missing.
 */
function NumberSetter({ link, onSaved }: { link: MyLink; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(link.personalNumber ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await updateMe({ whatsappNumber: value.trim() ? value.trim() : null });
      setEditing(false);
      onSaved();
    } catch (err) {
      // The API's message is written for a person — "that is not a phone number
      // a customer could dial" — so it is shown rather than replaced.
      setError(readableError(err, "Could not save that number."));
    } finally {
      setSaving(false);
    }
  }

  if (editing || !link.handoverPossible) {
    return (
      <form className="lnk-num" onSubmit={save}>
        <label>
          <span>Your WhatsApp number</span>
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="971501234567"
            inputMode="tel"
            aria-label="Your WhatsApp number"
          />
          <em>Country code, digits only. This is the number customers get handed to.</em>
        </label>
        <div className="lnk-num-actions">
          <button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          {editing ? (
            <button
              type="button"
              className="lnk-cancel"
              onClick={() => {
                setValue(link.personalNumber ?? "");
                setEditing(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          ) : null}
        </div>
        {error ? <p className="mc-error">{error}</p> : null}
        {!link.handoverPossible && !editing ? (
          <p className="lnk-warn">
            Until this is set, customers who come through your link cannot be handed to you — the
            assistant will help them itself instead.
          </p>
        ) : null}
      </form>
    );
  }

  return (
    <>
      <p className="lnk-note">
        The assistant answers their question and, in that same first reply, gives them a one-tap link
        to your own WhatsApp on {link.personalNumber} — every time, without waiting for them to ask.
        The conversation moves to your phone; nothing is installed and nothing reads your messages.
        It is offered once per conversation, not in every message, so it reads as an introduction
        rather than a brush-off.
      </p>
      <p className="lnk-note">
        <a href={`https://wa.me/${link.personalNumber}`} target="_blank" rel="noreferrer">
          Check this opens a chat with you
        </a>{" "}
        — one wrong digit is still a valid number, belonging to somebody else.{" "}
        <button type="button" className="lnk-inline" onClick={() => setEditing(true)}>
          Change it
        </button>
      </p>
    </>
  );
}
