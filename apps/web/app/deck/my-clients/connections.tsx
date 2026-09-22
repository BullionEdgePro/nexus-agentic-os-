"use client";

import { useEffect, useState } from "react";
import {
  getConnections,
  startGmailConnect,
  startFacebookConnect,
  startInstagramConnect,
  getClientMail,
  sendClientEmail,
  disconnectGmail,
  connectWhatsAppCoexistence,
  disconnectWhatsApp,
  type ClientMail,
  readableError,
  type ConnectionProvider,
  type SocialConnection,
} from "@/lib/api";

/**
 * Accounts a staff member has actually connected — Gmail for their client mail,
 * and their own WhatsApp Business number via Coexistence.
 *
 * THE PANEL SAYS WHAT EACH ONE IS NOT. Connecting Gmail reads, to most people,
 * as handing over their whole mailbox — it does not, and that has to be said
 * before anybody clicks. So each provider states what it offers AND what it
 * cannot do, in one line each, from the server rather than from copy written
 * here — one place for that to be true, and no chance of it drifting.
 *
 * (Facebook Page and Instagram messaging are handled as inbox CHANNELS on the
 * Channels screen, not here — those answer messages, they do not just link an
 * account. TikTok was removed.)
 */
export function ConnectionsPanel() {
  const [connections, setConnections] = useState<SocialConnection[] | null>(null);
  const [providers, setProviders] = useState<ConnectionProvider[]>([]);
  const [mail, setMail] = useState<{ messages: ClientMail[]; note: string | null } | null>(null);
  const [replyTo, setReplyTo] = useState<ClientMail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const data = await getConnections();
      setConnections(data.connections);
      setProviders(data.providers);
      setError(null);

      if (data.connections.some((c) => c.provider === "gmail" && c.usable)) {
        getClientMail()
          .then((m) => setMail({ messages: m.messages, note: m.note }))
          .catch((err) => setNotice(readableError(err, "Gmail could not be read just now.")));
      }
    } catch (err) {
      const message = readableError(err, "Could not load your connections.");
      // The owner has no personal accounts here. That is a fact about the role,
      // not a failure, so it is shown as a note rather than an error.
      if (/owner has no personal account/i.test(message)) setConnections([]);
      else setError(message);
    }
  };

  useEffect(() => {
    void load();
    // A returning OAuth redirect carries its outcome in the URL. Read once,
    // then stripped, so a refresh does not repeat a stale "connected" banner.
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    if (connected) {
      setNotice(connected);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const gmail = providers.find((p) => p.id === "gmail");
  const whatsapp = providers.find((p) => p.id === "whatsapp");
  const facebook = providers.find((p) => p.id === "facebook");
  const instagram = providers.find((p) => p.id === "instagram");
  const mailbox = connections?.find((c) => c.provider === "gmail") ?? null;
  const whatsappConn = connections?.find((c) => c.provider === "whatsapp") ?? null;
  // Business-level (the API folds these in), so each Meta card can show it is connected.
  const facebookConn = connections?.find((c) => c.provider === "facebook") ?? null;
  const instagramConn = connections?.find((c) => c.provider === "instagram") ?? null;

  if (connections === null || (!gmail && !whatsapp && !facebook && !instagram)) return null;

  return (
    <section className="cnx">
      <h2>Your accounts</h2>

      {notice ? <p className="cnx-note">{notice}</p> : null}
      {error ? <p className="mc-error">{error}</p> : null}

      {gmail ? (
        <div className="cnx-card">
          <div className="cnx-head">
            <div>
              <strong>Gmail</strong>
              {mailbox ? <span className="cnx-on">{mailbox.displayName ?? "connected"}</span> : null}
            </div>
            {mailbox ? (
              <button
                type="button"
                className="cnx-off"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await disconnectGmail().catch(() => undefined);
                  setMail(null);
                  await load();
                  setBusy(false);
                }}
              >
                Disconnect
              </button>
            ) : gmail.configured ? (
              <button
                type="button"
                className="cnx-go"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    const { url } = await startGmailConnect();
                    window.location.href = url;
                  } catch (err) {
                    setError(readableError(err, "Could not start the Google sign-in."));
                    setBusy(false);
                  }
                }}
              >
                Connect Gmail
              </button>
            ) : null}
          </div>

          <p className="cnx-offers">{gmail.offers}</p>
          {/* The most important line on this screen. A mailbox holds a person's
              bank, their doctor, their arguments — and "connect Gmail" reads as
              handing all of it over. It does not, and that has to be said
              before anybody clicks, not after. */}
          <p className="cnx-cannot">{gmail.cannot}</p>

          {!gmail.configured ? <p className="cnx-needs">Not set up on this server yet. {gmail.needs}</p> : null}
          {mailbox && !mailbox.usable ? (
            <p className="cnx-needs">The stored sign-in can no longer be read — connect it again.</p>
          ) : null}
          {mailbox?.lastError ? <p className="cnx-needs">Last read failed: {mailbox.lastError}</p> : null}

          {mail?.note ? <p className="cnx-note">{mail.note}</p> : null}

          {mail?.messages.length ? (
            <ul className="cnx-mail">
              {mail.messages.map((message) => (
                <li key={message.id} className={message.unread ? "cnx-unread" : undefined}>
                  <span className="cnx-subject">{message.subject ?? "(no subject)"}</span>
                  <span className="cnx-who">{message.from ?? message.to ?? ""}</span>
                  {message.snippet ? <span className="cnx-snippet">{message.snippet}</span> : null}
                  {addressIn(message.from) || addressIn(message.to) ? (
                    <button
                      type="button"
                      className="cnx-reply"
                      onClick={() => setReplyTo(replyTo?.id === message.id ? null : message)}
                    >
                      {replyTo?.id === message.id ? "Cancel" : "Reply"}
                    </button>
                  ) : null}
                  {replyTo?.id === message.id ? (
                    <Composer
                      to={addressIn(message.from) ?? addressIn(message.to) ?? ""}
                      subject={message.subject ? `Re: ${message.subject.replace(/^re:\s*/i, "")}` : ""}
                      onDone={(said) => {
                        setReplyTo(null);
                        setNotice(said);
                      }}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : mailbox && mail && !mail.note ? (
            <p className="cnx-note">Nothing recent to or from your clients.</p>
          ) : null}
        </div>
      ) : null}

      {whatsapp ? (
        <WhatsAppCard
          provider={whatsapp}
          connection={whatsappConn}
          busy={busy}
          setBusy={setBusy}
          onNotice={setNotice}
          onError={setError}
          onChange={load}
        />
      ) : null}

      {/* Facebook and Instagram are separate connects — each rides its own
          Facebook-Login flow and asks only for its channel's permissions. */}
      {facebook ? (
        <MetaConnectCard
          provider={facebook}
          connection={facebookConn}
          buttonLabel="Connect Page"
          busy={busy}
          onConnect={startFacebookConnect}
          onBusy={setBusy}
          onError={setError}
        />
      ) : null}

      {instagram ? (
        <MetaConnectCard
          provider={instagram}
          connection={instagramConn}
          buttonLabel="Connect Instagram"
          busy={busy}
          onConnect={startInstagramConnect}
          onBusy={setBusy}
          onError={setError}
        />
      ) : null}
    </section>
  );
}

/**
 * One Meta channel's connect card — Facebook Page or Instagram.
 *
 * The two are deliberately separate: connecting the Page must not make a person
 * grant Instagram access, and vice versa. The button only shows when the server
 * reports the shared Meta app configured; `needs` states the Meta App Review gate
 * either way. The redirect leaves the page, so a failure to even START is the only
 * thing shown here — the outcome is reported on the /deck/channels page it returns to.
 */
function MetaConnectCard({
  provider,
  connection,
  buttonLabel,
  busy,
  onConnect,
  onBusy,
  onError,
}: {
  provider: ConnectionProvider;
  connection: SocialConnection | null;
  buttonLabel: string;
  busy: boolean;
  onConnect: () => Promise<{ url: string }>;
  onBusy: (b: boolean) => void;
  onError: (m: string | null) => void;
}) {
  return (
    <div className="cnx-card">
      <div className="cnx-head">
        <div>
          <strong>{provider.name}</strong>
          {/* Connected state, the same chip Gmail and WhatsApp show, so a staff
              member can see at a glance the Page/IG is wired up. */}
          {connection ? (
            <span className="cnx-on">{connection.displayName ?? "connected"}</span>
          ) : null}
        </div>
        {provider.configured ? (
          <button
            type="button"
            className="cnx-go"
            disabled={busy}
            onClick={async () => {
              onBusy(true);
              onError(null);
              try {
                const { url } = await onConnect();
                window.location.href = url;
              } catch (err) {
                onError(readableError(err, `Could not start the ${provider.name} sign-in.`));
                onBusy(false);
              }
            }}
          >
            {connection ? "Reconnect" : buttonLabel}
          </button>
        ) : null}
      </div>

      <p className="cnx-offers">{provider.offers}</p>
      <p className="cnx-cannot">{provider.cannot}</p>
      {/* A stored token that can no longer be read means the connection is stale —
          say so, since the card otherwise reads as healthy. */}
      {connection && !connection.usable ? (
        <p className="cnx-needs">The stored sign-in can no longer be read — reconnect it.</p>
      ) : null}
      {provider.needs ? <p className="cnx-needs">{provider.needs}</p> : null}
    </div>
  );
}

/**
 * Connecting a staff member's own WhatsApp Business number via Coexistence.
 *
 * ============================================================
 * WHY THIS ONE IS A POPUP, NOT A REDIRECT
 * ============================================================
 *
 * TikTok and Gmail leave the page for their provider and come back. Meta's
 * Embedded Signup runs in a popup opened by its own JS SDK: the staff member
 * completes it on their phone, and the SDK hands back — right here in the page —
 * a one-time code, while a window message carries the WABA and phone-number ids
 * it created. The three are posted to the server together. Nothing is stored
 * client-side and no token is ever seen here.
 *
 * The card refuses to open the popup unless the server reported the provider as
 * configured (a real app id and Embedded Signup configuration exist), so on a
 * server without them it reads as "not enabled yet" rather than failing when
 * clicked.
 */
function WhatsAppCard({
  provider,
  connection,
  busy,
  setBusy,
  onNotice,
  onError,
  onChange,
}: {
  provider: ConnectionProvider;
  connection: SocialConnection | null;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onNotice: (m: string) => void;
  onError: (m: string) => void;
  onChange: () => Promise<void>;
}) {
  return (
    <div className="cnx-card">
      <div className="cnx-head">
        <div>
          <strong>WhatsApp Business</strong>
          {connection ? <span className="cnx-on">{connection.displayName ?? "connected"}</span> : null}
        </div>
        {connection ? (
          <button
            type="button"
            className="cnx-off"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await disconnectWhatsApp().catch(() => undefined);
              await onChange();
              setBusy(false);
            }}
          >
            Disconnect
          </button>
        ) : provider.configured ? (
          <button
            type="button"
            className="cnx-go"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              onError("");
              try {
                const result = await launchWhatsAppSignup(provider);
                const { number } = await connectWhatsAppCoexistence(result);
                onNotice(`WhatsApp connected — ${number}. Messages to it now appear in your conversations.`);
                await onChange();
              } catch (err) {
                onError(readableError(err, "WhatsApp could not be connected."));
              } finally {
                setBusy(false);
              }
            }}
          >
            Connect WhatsApp
          </button>
        ) : null}
      </div>

      <p className="cnx-offers">{provider.offers}</p>
      {/* Said every time. The 'Business app, not personal' line is the whole
          reason this is possible at all, and the thing people most misread. */}
      <p className="cnx-cannot">{provider.cannot}</p>

      {!provider.configured ? <p className="cnx-needs">{provider.needs}</p> : null}
      {connection && !connection.usable ? (
        <p className="cnx-needs">The stored connection can no longer be read — connect it again.</p>
      ) : null}
      {connection?.lastError ? <p className="cnx-needs">Last sync failed: {connection.lastError}</p> : null}
    </div>
  );
}

// Meta's JS SDK, loaded once and only when a staff member actually connects.
const FB_SDK_ID = "facebook-jssdk";
const FB_SDK_SRC = "https://connect.facebook.net/en_US/sdk.js";

interface FacebookSdk {
  init(params: { appId: string; version: string; cookie?: boolean; xfbml?: boolean }): void;
  login(
    callback: (response: { authResponse?: { code?: string } | null }) => void,
    options: Record<string, unknown>
  ): void;
}

type FbWindow = Window & { FB?: FacebookSdk; fbAsyncInit?: () => void };

/** Load and initialise the SDK, resolving the FB object once it is ready. */
function loadFacebookSdk(appId: string, version: string): Promise<FacebookSdk> {
  return new Promise((resolve, reject) => {
    const w = window as FbWindow;
    if (w.FB) {
      resolve(w.FB);
      return;
    }
    w.fbAsyncInit = () => {
      w.FB!.init({ appId, version, cookie: true, xfbml: false });
      resolve(w.FB!);
    };
    if (document.getElementById(FB_SDK_ID)) return; // already loading; fbAsyncInit resolves
    const script = document.createElement("script");
    script.id = FB_SDK_ID;
    script.src = FB_SDK_SRC;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => reject(new Error("Could not load Meta's sign-in. Check your connection and try again."));
    document.body.appendChild(script);
  });
}

/**
 * Run Embedded Signup and return the three things the server needs.
 *
 * The `code` comes from the login callback; the WABA and phone-number ids arrive
 * separately as a window message from Meta's popup, so both are captured and only
 * a run that produced all three is treated as a success. No `featureType` is
 * passed, so this is STANDARD onboarding (a dedicated Cloud API number) rather
 * than the coexistence variant, which Meta has not enabled for this business; the
 * config id decides the rest of the flow at Meta's end.
 */
async function launchWhatsAppSignup(provider: ConnectionProvider): Promise<{
  code: string;
  wabaId: string;
  phoneNumberId: string;
}> {
  if (!provider.appId || !provider.configId) {
    throw new Error("WhatsApp connecting is not enabled on this server yet.");
  }
  const FB = await loadFacebookSdk(provider.appId, provider.graphVersion ?? "v21.0");

  return new Promise((resolve, reject) => {
    let captured: { wabaId?: string; phoneNumberId?: string } = {};
    const onMessage = (event: MessageEvent) => {
      if (!/(^|\.)facebook\.com$/.test(new URL(event.origin).hostname)) return;
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (data?.type === "WA_EMBEDDED_SIGNUP" && data?.data) {
          captured = { wabaId: data.data.waba_id, phoneNumberId: data.data.phone_number_id };
        }
      } catch {
        // Not our message; ignore.
      }
    };
    window.addEventListener("message", onMessage);

    FB.login(
      (response) => {
        window.removeEventListener("message", onMessage);
        const code = response?.authResponse?.code;
        if (!code) {
          reject(new Error("WhatsApp sign-in was cancelled."));
          return;
        }
        if (!captured.wabaId || !captured.phoneNumberId) {
          reject(new Error("WhatsApp sign-in did not return a number — please try again."));
          return;
        }
        resolve({ code, wabaId: captured.wabaId, phoneNumberId: captured.phoneNumberId });
      },
      {
        config_id: provider.configId,
        response_type: "code",
        override_default_response_type: true,
        // STANDARD onboarding, not coexistence. The coexistence variant
        // (featureType "whatsapp_business_app_onboarding") is a limited-rollout
        // Meta program, and for this business it dead-ends at "can't onboard
        // customers at the moment" — the account is not enabled for it. Standard
        // Embedded Signup (no featureType) is what App Review + active billing
        // actually unlock, and it onboards a dedicated number to the Cloud API,
        // which is the platform's own model (a dedicated WABA number per staff).
        extras: { setup: {}, sessionInfoVersion: "3" },
      }
    );
  });
}

/**
 * The address inside a From or To header.
 *
 * Headers arrive as `Name <someone@example.com>` or bare. This is a convenience
 * for prefilling the reply box, NOT a permission check — the server re-reads the
 * client book and refuses anything not in it, which is what actually stops this
 * from sending to a stranger.
 */
function addressIn(header: string | null): string | null {
  if (!header) return null;
  const angled = /<([^>]+)>/.exec(header);
  const candidate = (angled ? angled[1] : header).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(candidate) ? candidate : null;
}

/** Write one email, to somebody already in the client book. */
function Composer({
  to,
  subject: initialSubject,
  onDone,
}: {
  to: string;
  subject: string;
  onDone: (message: string) => void;
}) {
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <form
      className="cnx-compose"
      onSubmit={async (event) => {
        event.preventDefault();
        if (sending) return;
        setSending(true);
        setProblem(null);
        try {
          await sendClientEmail({ to, subject, body });
          onDone(`Sent to ${to}.`);
        } catch (err) {
          setProblem(readableError(err, "It did not send."));
          setSending(false);
        }
      }}
    >
      <p className="cnx-to">To {to}</p>
      <input
        value={subject}
        onChange={(event) => setSubject(event.target.value)}
        placeholder="Subject"
        required
      />
      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={4}
        placeholder="Your message"
        required
      />
      {problem ? <p className="mc-error">{problem}</p> : null}
      <button type="submit" className="cnx-go" disabled={sending}>
        {sending ? "Sending…" : "Send from your mailbox"}
      </button>
      {/* Said on the button rather than beside it. It leaves as them, from their
          real address, and a reply comes back to their inbox rather than here. */}
    </form>
  );
}
