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
            people. Whoever taps it messages the company number, the assistant answers them and
            passes them straight to your WhatsApp, and they land in <strong>your</strong> client
            book at the same moment.
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
              The assistant answers their question and, in that same first reply, gives them a
              one-tap link to your own WhatsApp on {link.personalNumber} — every time, without
              waiting for them to ask. The conversation moves to your phone; nothing is installed
              and nothing reads your messages. It is offered once per conversation, not in every
              message, so it reads as an introduction rather than a brush-off.
            </p>
          ) : null}

          {/* CHECK IT YOURSELF, BECAUSE NOTHING ELSE CAN.
              A number is typed by a person and stored as typed. It is well
              formed or it is refused, but well formed is not the same as
              yours -- one wrong digit is a valid number belonging to a
              stranger, and the way anybody would find out is a customer
              arriving in somebody else's chat. Tapping this opens WhatsApp on
              whatever was saved, so a mistake surfaces in one second rather
              than in a complaint. */}
          {link.handoverPossible ? (
            <p className="lnk-note">
              <a
                href={`https://wa.me/${link.personalNumber}`}
                target="_blank"
                rel="noreferrer"
              >
                Check this opens a chat with you
              </a>{" "}
              — one wrong digit is still a valid number, belonging to somebody else.
            </p>
          ) : (
            <p className="lnk-warn">
              You have no WhatsApp number on file, so customers who come through your link cannot be
              handed to you — the assistant will help them itself instead. Add it yourself: open the
              account menu at the top right and set your WhatsApp number. Nothing else is needed.
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
