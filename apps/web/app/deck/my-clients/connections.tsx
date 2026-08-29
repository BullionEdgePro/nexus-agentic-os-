"use client";

import { useEffect, useState } from "react";
import {
  getConnections,
  startTikTokConnect,
  getTikTokInsights,
  disconnectTikTok,
  readableError,
  type ConnectionProvider,
  type SocialConnection,
  type TikTokInsights,
} from "@/lib/api";

/**
 * Social accounts a staff member has connected.
 *
 * ============================================================
 * THE PANEL SAYS WHAT IT IS NOT
 * ============================================================
 *
 * "Connect TikTok" reads, to almost anybody, as "and then I will see my TikTok
 * messages here". TikTok publishes no direct-message API to anybody, so that
 * expectation can only ever end in somebody hunting for an inbox that does not
 * exist and concluding the connection is broken.
 *
 * So each provider states what it offers AND what it cannot do, in one line
 * each, from the server rather than from copy written here — one place for that
 * to be true, and no chance of it drifting into marketing.
 *
 * ============================================================
 * WHY THIS IS WORTH CONNECTING AT ALL
 * ============================================================
 *
 * The referral link lives in that TikTok bio. Until now nobody could see
 * whether the account carrying it was reaching anyone — so "12 conversations
 * came through your link" had no denominator. Follower count and recent video
 * views put one next to it.
 */
export function ConnectionsPanel() {
  const [connections, setConnections] = useState<SocialConnection[] | null>(null);
  const [providers, setProviders] = useState<ConnectionProvider[]>([]);
  const [insights, setInsights] = useState<TikTokInsights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const data = await getConnections();
      setConnections(data.connections);
      setProviders(data.providers);
      setError(null);

      if (data.connections.some((c) => c.provider === "tiktok" && c.usable)) {
        // Best-effort. A connected account whose insights fail to load is still
        // connected, and the panel should say the first thing before the second.
        getTikTokInsights()
          .then(setInsights)
          .catch((err) => setNotice(readableError(err, "TikTok could not be read just now.")));
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

  const tiktok = providers.find((p) => p.id === "tiktok");
  const connected = connections?.find((c) => c.provider === "tiktok") ?? null;

  if (connections === null || !tiktok) return null;

  return (
    <section className="cnx">
      <h2>Your accounts</h2>

      {notice ? <p className="cnx-note">{notice}</p> : null}
      {error ? <p className="mc-error">{error}</p> : null}

      <div className="cnx-card">
        <div className="cnx-head">
          <div>
            <strong>TikTok</strong>
            {connected ? (
              <span className="cnx-on">
                {connected.displayName ?? "connected"}
              </span>
            ) : null}
          </div>
          {connected ? (
            <button
              type="button"
              className="cnx-off"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await disconnectTikTok().catch(() => undefined);
                setInsights(null);
                await load();
                setBusy(false);
              }}
            >
              Disconnect
            </button>
          ) : tiktok.configured ? (
            <button
              type="button"
              className="cnx-go"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const { url } = await startTikTokConnect();
                  window.location.href = url;
                } catch (err) {
                  setError(readableError(err, "Could not start the TikTok sign-in."));
                  setBusy(false);
                }
              }}
            >
              Connect TikTok
            </button>
          ) : null}
        </div>

        <p className="cnx-offers">{tiktok.offers}</p>
        {/* Said every time, connected or not. It is the expectation this panel
            exists to correct. */}
        <p className="cnx-cannot">{tiktok.cannot}</p>

        {!tiktok.configured ? (
          <p className="cnx-needs">
            Not set up on this server yet. {tiktok.needs}
          </p>
        ) : null}

        {connected && !connected.usable ? (
          <p className="cnx-needs">
            The stored sign-in can no longer be read — connect it again.
          </p>
        ) : null}

        {connected?.lastError ? (
          <p className="cnx-needs">Last read failed: {connected.lastError}</p>
        ) : null}

        {insights ? (
          <div className="cnx-stats">
            {insights.profile.followerCount !== null ? (
              <div>
                <dt>Followers</dt>
                <dd>{insights.profile.followerCount.toLocaleString()}</dd>
              </div>
            ) : null}
            <div>
              <dt>Recent videos</dt>
              <dd>{insights.videos.length}</dd>
            </div>
            <div>
              <dt>Views on those</dt>
              <dd>
                {insights.videos
                  .reduce((total, video) => total + (video.viewCount ?? 0), 0)
                  .toLocaleString()}
              </dd>
            </div>
          </div>
        ) : null}

        {insights && !insights.canReadVideos ? (
          <p className="cnx-note">
            Video figures are not available — this connection was granted profile access only.
          </p>
        ) : null}

        {insights?.videos.length ? (
          <ul className="cnx-videos">
            {insights.videos.map((video) => (
              <li key={video.id}>
                <span className="cnx-title">{video.title ?? "Untitled"}</span>
                <span className="cnx-nums">
                  {(video.viewCount ?? 0).toLocaleString()} views
                  {video.likeCount !== null ? ` · ${video.likeCount.toLocaleString()} likes` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
