"use client";

import { useEffect, useState } from "react";
import { getChannels, readableError, type ChannelStatus } from "@/lib/api";
import { fontVariables } from "@/lib/fonts";
import "../deck.css";
import "../activity/activity.css";
import "./channels.css";

/**
 * Where every messaging channel stands — the honest map of the multi-channel inbox.
 *
 * The point of this screen is to never lie about what is connected. A channel is
 * LIVE (it carries messages now), NEEDS SETUP (the code is here, waiting on
 * credentials the owner adds), or AWAITING META (waiting on an approval no code
 * can hurry). Each card says exactly what it would take to switch a channel on,
 * so "we support SMS" is never a promise the send button then breaks.
 */

const STATE_LABEL: Record<ChannelStatus["state"], string> = {
  live: "Live",
  "needs-setup": "Needs setup",
  "awaiting-approval": "Awaiting Meta",
};

const CHANNEL_GLYPH: Record<string, string> = {
  whatsapp: "💬",
  email: "✉️",
  sms: "📱",
  phone: "📞",
  instagram: "📷",
};

export default function ChannelsPage() {
  const [channels, setChannels] = useState<ChannelStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    getChannels()
      .then((data) => live && setChannels(data.channels))
      .catch((err) => live && setError(readableError(err)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  const liveCount = channels.filter((c) => c.state === "live").length;

  return (
    <div className={`deck-root ${fontVariables}`}>
      <div className="act-root">
        <header className="act-head">
          <h1>Channels</h1>
        </header>
        <p className="act-lede">
          The ways a customer can reach a business, and where each one stands. Nothing here
          claims to be connected that is not — a channel goes live the moment its setup is done,
          and says exactly what that setup is until then.
        </p>

        {error ? <p className="act-msg">{error}</p> : null}

        {loading ? (
          <div className="act-empty">Loading…</div>
        ) : (
          <>
            <p className="ch-count">
              {liveCount} of {channels.length} channels live.
            </p>
            <div className="ch-list">
              {channels.map((ch) => (
                <article className={`ch-card ch-${ch.state}`} key={ch.channel}>
                  <div className="ch-top">
                    <span className="ch-glyph" aria-hidden="true">
                      {CHANNEL_GLYPH[ch.channel] ?? "•"}
                    </span>
                    <h2 className="ch-name">{ch.label}</h2>
                    <span className={`ch-pill ch-pill-${ch.state}`}>{STATE_LABEL[ch.state]}</span>
                  </div>
                  <p className="ch-summary">{ch.summary}</p>
                  {ch.requirements.length ? (
                    <ul className="ch-reqs">
                      {ch.requirements.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="ch-ready">Nothing else needed — this channel is carrying messages.</p>
                  )}
                </article>
              ))}
            </div>

            <section className="ch-note">
              <h2 className="act-sub-head">What each state means</h2>
              <ul>
                <li>
                  <strong>Live</strong> — messages send and receive on this channel right now.
                </li>
                <li>
                  <strong>Needs setup</strong> — the channel is built into the platform; it turns
                  on the moment its credentials are added. For SMS and phone that is a Twilio
                  account (a paid provider); for email, a connected Gmail.
                </li>
                <li>
                  <strong>Awaiting Meta</strong> — Instagram messaging needs Meta&apos;s App Review,
                  the same wall as WhatsApp. It is added to the review once the WhatsApp submission
                  clears, because Meta does not allow editing a submission mid-review.
                </li>
              </ul>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
