"use client";

import { useCallback, useEffect, useState } from "react";
import {
  claimMyNumber,
  getAvailableNumbers,
  getMyCampaigns,
  getMyChannel,
  readableError,
  releaseMyNumber,
  sendMyCampaign,
  type MyCampaignsView,
  type MyChannel,
} from "@/lib/api";
import { fontVariables } from "@/lib/fonts";
import "../deck.css";
import "../my-clients/my-clients.css";
import "./my-campaigns.css";

/**
 * Messaging your whole book at once, and the number it leaves from.
 *
 * ============================================================
 * THE CONFIRMATION IS THE PRODUCT
 * ============================================================
 *
 * A bulk send is the one action on this platform that reaches many real people
 * at once and cannot be recalled. Everything else here can be corrected by
 * doing it again differently; this cannot.
 *
 * So the screen refuses to be a button. Before anything sends it states, in
 * order: how many people, WHICH people by name, which message, and which number
 * it goes out from — and the send control names the count rather than saying
 * "Send", because "Send" is what somebody clicks without reading and "Message
 * 47 people" is not.
 */
export default function MyCampaignsPage() {
  const [view, setView] = useState<MyCampaignsView | null>(null);
  const [channel, setChannel] = useState<MyChannel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string>("");
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [campaigns, line] = await Promise.all([getMyCampaigns(), getMyChannel()]);
      setView(campaigns);
      setChannel(line);
      setError(null);
    } catch (err) {
      setError(readableError(err, "The console could not be reached."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className={`deck-root ${fontVariables}`}>
        <header className="mc-head">
          <h1>My campaigns</h1>
        </header>
        <p className="mc-empty">{error}</p>
      </div>
    );
  }

  const audience = view?.audience ?? [];
  const template = view?.templates.find((candidate) => candidate.id === chosen);

  return (
    <div className={`deck-root ${fontVariables}`}>
      <header className="mc-head">
        <h1>My campaigns</h1>
        <p>One message to everyone in your own book. Not the business&rsquo;s customers — yours.</p>
      </header>

      <NumberPanel channel={channel} onChanged={load} />

      {view && !view.canBroadcast ? (
        <p className="cmp-blocked">
          Campaigns are switched off for your account. They are on by default, so somebody has
          turned this one off deliberately — ask the owner.
        </p>
      ) : null}

      {view?.canBroadcast ? (
        <section className="cmp-compose">
          <h2>Send one</h2>

          <p className="cmp-facts">
            <strong>{audience.length}</strong>{" "}
            {audience.length === 1 ? "person" : "people"} in your book
            {view.allowance.cap !== null ? (
              <>
                {" "}
                · <strong>{view.allowance.remaining}</strong> of {view.allowance.cap} left this month
              </>
            ) : view.allowance.used > 0 ? (
              // No ceiling set here, so there is nothing to count DOWN from —
              // but "how many have I sent this month" is still worth knowing,
              // and printing a limit nobody chose would be worse than silence.
              <>
                {" "}
                · <strong>{view.allowance.used}</strong> sent this month
              </>
            ) : null}{" "}
            · sending from <strong>{view.sendsFrom}</strong>
          </p>

          {view.dailyCeiling ? (
            <p className="cmp-ceiling">
              WhatsApp lets this number start <strong>{view.dailyCeiling.limit}</strong> new
              conversations a day, shared across every business here, and at least{" "}
              <strong>{view.dailyCeiling.usedToday}</strong> have already gone out today — about{" "}
              <strong>{view.dailyCeiling.remainingToday}</strong> left. A campaign larger than that
              will send until the ceiling and the rest will not arrive today. Nothing here will stop
              you; this is so you are not surprised by the delivery report.
            </p>
          ) : null}

          <label className="cmp-pick">
            <span>Message</span>
            <select value={chosen} onChange={(event) => setChosen(event.target.value)}>
              <option value="">Choose an approved message&hellip;</option>
              {view.templates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name} ({candidate.language})
                </option>
              ))}
            </select>
            <em>
              Only messages WhatsApp has approved for this business appear here. New wording has to
              be approved by Meta before it can be sent to people who have not written in recently.
            </em>
          </label>

          {audience.length === 0 ? (
            <p className="mc-empty">
              Nobody to send to yet. Add clients in <a href="/deck/my-clients">My clients</a> first.
            </p>
          ) : !confirming ? (
            <button
              type="button"
              className="cmp-go"
              disabled={!chosen}
              onClick={() => {
                setRefused(null);
                setConfirming(true);
              }}
            >
              Review before sending
            </button>
          ) : (
            <div className="cmp-confirm">
              <h3>
                This will message {audience.length} {audience.length === 1 ? "person" : "people"}
              </h3>
              {/* Named, not counted. A list somebody scrolls is a list somebody
                  checks; a number is not. */}
              <ul className="cmp-who">
                {audience.map((person) => (
                  <li key={person.waId}>
                    {person.displayName ?? "Unnamed"} <span>+{person.waId}</span>
                  </li>
                ))}
              </ul>
              <p className="cmp-final">
                Sending <strong>{template?.name}</strong> from <strong>{view.sendsFrom}</strong>.
                This cannot be recalled once it starts.
              </p>
              {view.dailyCeiling ? (
                <p className="cmp-final cmp-warn-line">
                  About {view.dailyCeiling.remainingToday} of these {audience.length} will arrive
                  today — the rest run past what WhatsApp allows this number to start in 24 hours.
                </p>
              ) : null}
              {refused ? <p className="mc-error">{refused}</p> : null}
              <div className="cmp-actions">
                <button
                  type="button"
                  className="cmp-go"
                  disabled={sending}
                  onClick={async () => {
                    setSending(true);
                    setRefused(null);
                    try {
                      const result = await sendMyCampaign(chosen);
                      setSent(result.enqueued);
                      setConfirming(false);
                      setChosen("");
                      await load();
                    } catch (err) {
                      setRefused(readableError(err, "Nothing was sent."));
                    } finally {
                      setSending(false);
                    }
                  }}
                >
                  {sending ? "Sending…" : `Message ${audience.length} ${audience.length === 1 ? "person" : "people"}`}
                </button>
                <button type="button" className="cmp-cancel" onClick={() => setConfirming(false)}>
                  Not yet
                </button>
              </div>
            </div>
          )}

          {sent !== null ? (
            <p className="cmp-sent">
              Queued to {sent} {sent === 1 ? "person" : "people"}. Delivery is reported below as
              WhatsApp confirms it — a message accepted is not yet a message delivered.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="cmp-history">
        <h2>What you have sent</h2>
        {view?.campaigns.length ? (
          <table className="mc-table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Message</th>
                <th scope="col">Reached</th>
                <th scope="col">Failed</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {view.campaigns.map((campaign) => (
                <tr key={campaign.id}>
                  <td>{new Date(campaign.createdAt).toLocaleString()}</td>
                  <td>{campaign.templateName ?? "—"}</td>
                  <td className="mc-num">
                    {campaign.sent} of {campaign.total}
                  </td>
                  <td className="mc-num">{campaign.failed || "—"}</td>
                  <td>{campaign.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mc-empty">Nothing yet.</p>
        )}
      </section>
    </div>
  );
}

/**
 * Claiming a number of your own.
 *
 * The list offered is what Meta actually holds on the business account, asked
 * fresh. There is no box for typing a number in, because a number this platform
 * has not found at Meta cannot send anything — and one stored anyway produces a
 * campaign that reports success to a whole client book and reaches nobody.
 */
function NumberPanel({ channel, onChanged }: { channel: MyChannel | null; onChanged: () => void }) {
  const [numbers, setNumbers] = useState<
    Array<{ phoneNumberId: string; displayNumber: string; verifiedName: string; isShared: boolean }>
  >([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!channel) return null;

  return (
    <section className={`mc-channel mc-channel-${channel.state}`}>
      <h2>The number you send from</h2>

      {channel.state === "own-number" && channel.ownNumber ? (
        <p>
          <strong>{channel.ownNumber.displayNumber}</strong> is yours — clients see it, and replies
          come to you.{" "}
          <button
            type="button"
            className="cmp-link"
            onClick={async () => {
              await releaseMyNumber().catch(() => undefined);
              onChanged();
            }}
          >
            Give it back
          </button>
        </p>
      ) : (
        <p>
          You send from the company&rsquo;s shared number
          {channel.sharedNumber ? <strong> {channel.sharedNumber.displayNumber}</strong> : null}. Your
          clients see the company, not you.
        </p>
      )}

      {/* The one belief worth correcting on this screen, stated wherever the
          question is being asked. */}
      <p className="mc-note">
        The WhatsApp on your phone cannot be connected here — the app has no way to be read by
        software, and the tools that claim otherwise get the business banned. A number of your own
        has to be a second business number added to the company&rsquo;s WhatsApp account in Meta
        Business Manager. Once the owner has added and verified it, it appears in the list below.
      </p>

      {!open ? (
        <button
          type="button"
          className="cmp-link"
          onClick={async () => {
            setOpen(true);
            setError(null);
            try {
              const result = await getAvailableNumbers();
              setNumbers(result.numbers);
            } catch (err) {
              setError(readableError(err, "Could not ask WhatsApp which numbers exist."));
            }
          }}
        >
          Show the numbers on this account
        </button>
      ) : (
        <div className="cmp-numbers">
          {error ? <p className="mc-error">{error}</p> : null}
          {numbers.length === 0 && !error ? <p className="mc-note">Asking WhatsApp&hellip;</p> : null}
          <ul>
            {numbers.map((number) => (
              <li key={number.phoneNumberId}>
                <span className="mc-num">{number.displayNumber}</span> — {number.verifiedName}
                {number.isShared ? (
                  <em> the company&rsquo;s shared number, not claimable</em>
                ) : (
                  <button
                    type="button"
                    className="cmp-link"
                    onClick={async () => {
                      try {
                        await claimMyNumber(number.phoneNumberId);
                        setOpen(false);
                        onChanged();
                      } catch (err) {
                        setError(readableError(err, "Could not claim it."));
                      }
                    }}
                  >
                    Make this mine
                  </button>
                )}
              </li>
            ))}
          </ul>
          {numbers.length === 1 && numbers[0]?.isShared ? (
            <p className="mc-note">
              This account has only the one shared number, so there is nothing to claim yet. The
              owner adds another in Meta Business Manager under WhatsApp Manager → Phone numbers. It
              cannot be a number already signed in to the WhatsApp app.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
