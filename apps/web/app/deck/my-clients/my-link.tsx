"use client";

import { useEffect, useState } from "react";
import { getMyLink, readableError, type MyLink } from "@/lib/api";

/**
 * The link a staff member puts on their own socials.
 *
 * ============================================================
 * THE THING THIS SCREEN HAS TO EXPLAIN
 * ============================================================
 *
 * A staff member reading this can already paste their own WhatsApp link into an
 * Instagram bio, and will wonder why they should use ours. The answer is not
 * "policy" and the panel says the real one: their own link gives them a lead
 * nobody can see — no record, no answer while they sleep, nothing to hand over
 * when they leave, and no way to know which post worked. This one gets them the
 * same customer, still ends up in their WhatsApp, and keeps all of that.
 *
 * The panel also refuses to overstate itself. If the person has no number on
 * file, no handover is possible, and it says so rather than implying customers
 * will reach them.
 */
export function MyLinkPanel() {
  const [link, setLink] = useState<MyLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getMyLink()
      .then(setLink)
      .catch((err) => setError(readableError(err, "Could not load your link.")));
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
            people. Whoever taps it messages the company number, the assistant answers them, and
            they land in <strong>your</strong> client book straight away.
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
                  // older browser. The link is on the screen and selectable, so
                  // this is a convenience that failed, not a broken feature.
                  setCopied(false);
                }
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>

          {link.handoverPossible ? (
            <p className="lnk-note">
              When a customer who came through your link asks to speak to a person, the assistant
              gives them a one-tap link to your own WhatsApp on {link.personalNumber}. The
              conversation moves to your phone — nothing is installed and nothing reads your
              messages.
            </p>
          ) : (
            <p className="lnk-warn">
              You have no WhatsApp number on file, so a customer who asks for you cannot be handed
              over — the assistant will help them itself instead. Ask the owner to add your number
              to your staff record.
            </p>
          )}

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
