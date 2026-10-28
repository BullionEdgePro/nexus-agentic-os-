"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  claimMyNumber,
  getAvailableNumbers,
  getMyCampaigns,
  getMyChannel,
  readableError,
  releaseMyNumber,
  sendMyCampaign,
  sendMyCampaignTest,
  sendMyEmailCampaign,
  sendMyEmailCampaignTest,
  polishCampaignText,
  controlMyCampaign,
  getMyCampaignTestStatus,
  type CampaignTestStatus,
  type MyCampaignsView,
  type MyChannel,
  type ReadinessCheck,
} from "@/lib/api";
import { fontVariables } from "@/lib/fonts";
import "../deck.css";
import "../my-clients/my-clients.css";
import "./my-campaigns.css";
import { CampaignControls, EmailCampaignForm } from "./email-campaign";
import { MyTemplates } from "./my-templates";
import { ImportCustomers } from "../customers/import-customers";
import "../customers/customers.css";

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
/** What each campaign state means to the person who sent it. */
const STATUS_WORDS: Record<string, string> = {
  sending: "Sending",
  completed: "Finished",
  failed: "Failed — nothing was delivered",
  paused: "Paused — most were refused, or the mailbox stopped working",
  stopped: "Stopped",
};

export default function MyCampaignsPage() {
  const [view, setView] = useState<MyCampaignsView | null>(null);
  const [channel, setChannel] = useState<MyChannel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string>("");
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<number | null>(null);
  // Trying the message on one number first: the campaign itself goes to everyone.
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  // Accepted is not delivered (28 Oct 2026): after a test, ask what WhatsApp did
  // with it until there is an answer, instead of saying "Sent" and stopping.
  const [testId, setTestId] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<CampaignTestStatus | null>(null);
  const [testTimedOut, setTestTimedOut] = useState(false);
  const testStarted = useRef(0);

  useEffect(() => {
    if (!testId) return;
    let cancelled = false;
    testStarted.current = Date.now();
    setTestTimedOut(false);
    const ask = async () => {
      try {
        const status = await getMyCampaignTestStatus(testId);
        if (cancelled) return;
        setTestStatus(status);
        if (status.state === "delivered" || status.state === "read" || status.state === "failed") return;
      } catch {
        // Not known yet, or the receipt store is unreachable: keep asking.
      }
      if (!cancelled && Date.now() - testStarted.current < 120_000) timer = setTimeout(ask, 3000);
      else if (!cancelled) setTestTimedOut(true);
    };
    let timer = setTimeout(ask, 2000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [testId]);
  // WhatsApp or email (26 Oct 2026): one campaign, one channel, never both.
  const [tab, setTab] = useState<"whatsapp" | "email">("whatsapp");
  const [emailSubject, setEmailSubject] = useState<string | undefined>(undefined);

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
  const email = view?.email;
  const ready = (view?.readiness ?? []).every((check) => check.ok === true);
  const template = view?.templates.find((candidate) => candidate.id === chosen);

  return (
    <div className={`deck-root ${fontVariables}`}>
      <header className="mc-head">
        <h1>My campaigns</h1>
        <p>One message to everyone in your own book. Not the business&rsquo;s customers — yours.</p>
      </header>

      <div className="ecf-tabs" role="tablist" aria-label="Send by">
        <button type="button" role="tab" aria-selected={tab === "whatsapp"} className={tab === "whatsapp" ? "on" : ""} onClick={() => setTab("whatsapp")}>
          WhatsApp<b>{audience.length}</b>
        </button>
        <button type="button" role="tab" aria-selected={tab === "email"} className={tab === "email" ? "on" : ""} onClick={() => setTab("email")}>
          Email<b>{email?.reachable ?? 0}</b>
        </button>
      </div>

      {tab === "email" ? (
        view && !view.canBroadcast ? (
          <p className="cmp-blocked">Campaigns are switched off for your account — ask the owner.</p>
        ) : email ? (
          <section className="cmp-compose">
            <h2>Send one by email</h2>
            <EmailCampaignForm
              key={emailSubject ?? "blank"}
              side={email}
              audienceLabel="your book"
              audience={email.audience}
              sampleName={email.audience[0]?.displayName ?? null}
              initialSubject={emailSubject}
              defaultTestTo={email.fromOwn && email.from ? email.from : ""}
              onSend={(input) => sendMyEmailCampaign(input)}
              onTest={(input) => sendMyEmailCampaignTest(input)}
              onPolish={async (text) => (await polishCampaignText(text)).text}
              onSent={() => void load()}
            />
          </section>
        ) : null
      ) : null}

      {tab === "whatsapp" ? <NumberPanel channel={channel} onChanged={load} /> : null}

      {tab === "whatsapp" && view?.readiness ? <Readiness checks={view.readiness} /> : null}

      {tab === "whatsapp" && view && !view.canBroadcast ? (
        <p className="cmp-blocked">
          Campaigns are switched off for your account. They are on by default, so somebody has
          turned this one off deliberately — ask the owner.
        </p>
      ) : null}

      {tab === "whatsapp" && view?.canBroadcast ? (
        <section className="cmp-compose">
          <h2>Send one on WhatsApp</h2>

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

          {view.healthWarning ? <p className="cmp-ceiling">{view.healthWarning}</p> : null}

          {/* Clients come in from a file too (28 Oct 2026): straight into this
              person's own book, which is exactly who a campaign reaches. */}
          {view.book ? (
            <ImportCustomers
              business={view.book.businessSlug}
              businessName=""
              ownBook={{ employeeId: view.book.employeeId }}
              onImported={() => void load()}
            />
          ) : null}

          {view.dailyCeiling ? (
            <p className="cmp-ceiling">
              WhatsApp lets this number start <strong>{view.dailyCeiling.limit}</strong> new
              conversations a day, and at least{" "}
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
                  {messageName(candidate.name)} ({candidate.language})
                </option>
              ))}
            </select>
            <em>
              Only messages WhatsApp has approved appear here: the business&rsquo;s, and your own once
              approved. New wording has to be approved by Meta before it can be sent to people who have
              not written in recently.
            </em>
          </label>

          <MyTemplates
            templates={view.myTemplates ?? []}
            sampleName={audience[0]?.displayName ?? null}
            onChanged={() => void load()}
          />

          {chosen ? (
            <div className="cmp-test">
              <label>
                <span>Try it on your own WhatsApp first</span>
                <input
                  type="tel"
                  inputMode="tel"
                  placeholder="+971 50 123 4567"
                  value={testTo}
                  onChange={(event) => {
                    setTestTo(event.target.value);
                    setTestResult(null);
                    setTestId(null);
                    setTestStatus(null);
                  }}
                />
              </label>
              <button
                type="button"
                disabled={testing || !testTo.trim()}
                onClick={async () => {
                  setTesting(true);
                  setTestResult(null);
                  setTestId(null);
                  setTestStatus(null);
                  try {
                    const { messageId } = await sendMyCampaignTest(chosen, testTo.trim());
                    setTestResult({ ok: true, text: "WhatsApp accepted it. Waiting to hear whether it reached the phone…" });
                    setTestId(messageId);
                  } catch (err) {
                    setTestResult({ ok: false, text: readableError(err) });
                  } finally {
                    setTesting(false);
                  }
                }}
              >
                {testing ? "Sending test…" : "Send a test"}
              </button>
              {testResult && !(testResult.ok && (testTimedOut || (testStatus && testStatus.state !== "accepted"))) ? (
                <p className={testResult.ok ? "cmp-test-ok" : "mc-error"}>{testResult.text}</p>
              ) : null}
              {testResult?.ok && (testStatus || testTimedOut) ? (
                <TestOutcome status={testStatus ?? { state: "accepted", reason: null, at: "" }} timedOut={testTimedOut} />
              ) : null}
              <em>One copy to that number only. Nobody in your book gets it, and it is not counted anywhere.</em>
            </div>
          ) : null}

          {audience.length === 0 ? (
            <p className="mc-empty">
              Nobody to send to yet. Add clients from a file above, or one at a time in{" "}
              <a href="/deck/my-clients">My clients</a>.
            </p>
          ) : !confirming ? (
            <button
              type="button"
              className="cmp-go"
              disabled={!chosen || !ready}
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
                Sending <strong>{template ? messageName(template.name) : null}</strong> from <strong>{view.sendsFrom}</strong>.
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
          {/* The other half of the book. A WhatsApp campaign never reaches the
              people who only ever emailed — say so, and make the email one a click. */}
          {sent !== null && email && email.reachable > 0 && !email.fromError ? (
            <p className="ecf-nudge">
              {email.reachable} {email.reachable === 1 ? "client" : "clients"} in your book can be reached by
              email. Send them an email version?
              <button
                type="button"
                className="cmp-link"
                onClick={() => {
                  setEmailSubject(`A message from ${email.senderName.split(/\s+/)[0] ?? "us"}`);
                  setTab("email");
                }}
              >
                Write the email
              </button>
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
                <th scope="col">By</th>
                <th scope="col">Message</th>
                <th scope="col">Sent</th>
                <th scope="col">Delivered</th>
                <th scope="col">Failed</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {view.campaigns.map((campaign) => (
                <tr key={campaign.id}>
                  <td>{new Date(campaign.createdAt).toLocaleString()}</td>
                  <td className="ecf-channel">{campaign.channel === "email" ? "Email" : "WhatsApp"}</td>
                  <td>{campaign.channel === "email" ? campaign.emailSubject : campaign.templateName ? messageName(campaign.templateName) : "—"}</td>
                  <td className="mc-num">
                    {campaign.sent} of {campaign.total}
                    {campaign.notSent && (campaign.status === "stopped" || campaign.status === "paused") ? (
                      <span className="ecf-channel"> · {campaign.notSent} not sent</span>
                    ) : null}
                  </td>
                  <td className="mc-num">{campaign.delivered || "—"}</td>
                  <td className="mc-num">
                    {campaign.failed || "—"}
                    {campaign.topFailures.length ? (
                      <ul className="cmp-why">
                        {campaign.topFailures.map((failure) => (
                          <li key={failure.reason}>
                            {failure.count} × {failure.reason}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </td>
                  <td>
                    {STATUS_WORDS[campaign.status] ?? campaign.status}
                    <CampaignControls
                      status={campaign.status}
                      act={(action) => controlMyCampaign(campaign.id, action)}
                      onDone={() => void load()}
                    />
                  </td>
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
 * A staff member's own message by the name they gave it, not Meta's. The same
 * rule as staffTemplateLabel in @nexus/shared, which the console can only
 * import types from.
 */
function messageName(metaName: string): string {
  const own = /^staff_[0-9a-f]{8}_/;
  return own.test(metaName) ? `Yours: ${metaName.replace(own, "").replace(/_/g, " ")}` : metaName;
}

/** What WhatsApp did with the test, in words. */
function TestOutcome({ status, timedOut }: { status: CampaignTestStatus; timedOut: boolean }) {
  if (status.state === "failed") {
    return (
      <p className="mc-error">
        WhatsApp did not deliver it: {status.reason ?? "no reason given."} Nothing reached that phone, and a
        campaign with this message would fail the same way.
      </p>
    );
  }
  if (status.state === "delivered" || status.state === "read") {
    return <p className="cmp-test-ok">{status.state === "read" ? "Delivered and read." : "Delivered to that WhatsApp."}</p>;
  }
  if (timedOut) {
    return (
      <p className="cmp-ceiling">
        WhatsApp accepted it but has not confirmed delivery after two minutes. The phone may be off or offline; if
        it is on and nothing came, WhatsApp is holding it back — send the test once more to see its reason.
      </p>
    );
  }
  return (
    <p className="cmp-test-ok">
      {status.state === "sent" ? "On its way — waiting for the phone to receive it…" : "WhatsApp accepted it. Waiting to hear whether it reached the phone…"}
    </p>
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
/**
 * The four things a campaign needs, each with the one thing to do about it.
 * The same checks the server refuses a send on, so a green list here is a send
 * that will be accepted.
 */
function Readiness({ checks }: { checks: ReadinessCheck[] }) {
  const done = checks.filter((check) => check.ok === true).length;
  return (
    <section className="cmp-ready" aria-label="Ready to send">
      <h2>
        Ready to send <span className={done === checks.length ? "cmp-ready-all" : ""}>{done} of {checks.length}</span>
      </h2>
      <ul>
        {checks.map((check) => (
          <li key={check.key} className={check.ok === true ? "ok" : check.ok === null ? "unknown" : "no"}>
            <span className="cmp-ready-dot" aria-hidden="true" />
            <span>
              {check.detail}
              {check.ok !== true && check.fix ? <em>{check.fix}</em> : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

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
