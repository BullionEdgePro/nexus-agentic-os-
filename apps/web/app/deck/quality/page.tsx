"use client";

import { useCallback, useEffect, useState } from "react";
import { BusinessTabs } from "@/lib/business-tabs";
import type { BusinessSlug } from "@nexus/shared";
import {
  getQuality,
  refreshQuality,
  askCopilot,
  getCopilotCapabilities,
  type QualityDay,
  type QualitySummary,
  type CopilotAnswer,
  type EscalationHotspot, readableError } from "@/lib/api";
import { fontVariables } from "@/lib/fonts";
import { TENANTS } from "@/lib/tenants";
import { BrainSection } from "./brain-section";
import "../deck.css";
import "../activity/activity.css";
import "./quality.css";

/**
 * How well the agent is actually doing.
 *
 * Nothing on this page is the AI's opinion of itself. Every number is a human
 * action the system already recorded — someone took a conversation over, someone
 * replied straight after the agent, or nobody intervened. That is the difference
 * between measuring quality and measuring confidence, and it is the reason this
 * page can be trusted when it says something is going wrong.
 */
export default function QualityPage() {
  const [business, setBusiness] = useState<BusinessSlug>("zipicka");
  const [trend, setTrend] = useState<QualityDay[]>([]);
  const [summary, setSummary] = useState<QualitySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /**
   * A LOAD that failed, kept apart from an ACTION that failed.
   *
   * The render below refuses to draw anything when this is set, because the
   * alternative is the previous business's numbers under the new one's name.
   * An action failure — a recompute, a send, a save — must NOT do that: the
   * screen it happened on is still correct, and blanking it would lose the
   * context the message is about.
   */
  const [loadError, setLoadError] = useState("");
  const [question, setQuestion] = useState("");
  // WHAT IT CAN ACTUALLY ANSWER.
  //
  // This box refuses anything it cannot answer from real data, which is the
  // right behaviour and reads as a broken feature if you never knew what to
  // ask. The list comes from the server, derived from the same questions the
  // router matches against, so the screen cannot advertise something the
  // answerer would then decline.
  const [canAnswer, setCanAnswer] = useState<string[]>([]);
  const [asking, setAsking] = useState(false);
  const [reply, setReply] = useState<CopilotAnswer | null>(null);
  const [hotspots, setHotspots] = useState<EscalationHotspot[]>([]);

  const load = useCallback(async (slug: BusinessSlug) => {
    setLoading(true);
    setError("");
    setLoadError("");
    try {
      const data = await getQuality(slug, 30);
      setTrend(data.trend);
      setSummary(data.summary);
      setHotspots(data.hotspots ?? []);
    } catch (err) {
      setLoadError(readableError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(business);
  }, [business, load]);

  useEffect(() => {
    getCopilotCapabilities(business)
      .then((data) => setCanAnswer(data.capabilities))
      // Failing soft is right here and only because of what is lost: the box
      // still works, it just stops advertising. There is no claim to get wrong.
      .catch(() => setCanAnswer([]));
  }, [business]);

  async function handleRefresh() {
    setBusy(true);
    setError("");
    try {
      await refreshQuality();
      await load(business);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleAsk(event: React.FormEvent) {
    event.preventDefault();
    if (!question.trim()) return;
    setAsking(true);
    setReply(null);
    try {
      setReply(await askCopilot(business, question.trim()));
    } catch (err) {
      setError(readableError(err));
    } finally {
      setAsking(false);
    }
  }

  const peak = Math.max(1, ...trend.map((day) => day.conversations));
  const hasTraffic = (summary?.aiAnswered ?? 0) > 0;

  return (
    <div className={`deck-root ${fontVariables}`}>
      <div className="act-root">

        <header className="act-head">
          <h1>Agent quality</h1>
        </header>
        <p className="act-lede">
          Measured by what people did, not by what the agent thought of its own answers. A
          conversation counts as escalated when a human joined it, and contained when nobody had to.
        </p>

        <BusinessTabs
          value={business}
          onChange={(slug) => {
            // These screens are meaningless without one business chosen, so they
            // hold a plain BusinessSlug and never render the All tab. The guard
            // says that rather than casting the empty case away.
            if (slug) setBusiness(slug);
          }}
          includeAll={false}
        />

        {loadError ? (
          /*
           * WHEN THE LOAD FAILS, NOTHING BELOW IS DRAWN.
           *
           * This line used to appear ABOVE the data, and the data was
           * whatever the last successful load had put in state. Switch
           * business, have the request fail, and this page showed the
           * PREVIOUS business's numbers under the new one's name — one
           * tenant's figures attributed to another, arriving through the
           * UI rather than the database that spent a whole feature
           * preventing exactly that.
           *
           * Clearing the data instead would have been worse: the page
           * would fall through to its empty state and say "nothing to
           * report" when the truth is "nobody could ask". Those are the
           * two silences the operators panel was fixed for this morning.
           */
          <p className="act-msg">{loadError}</p>
        ) : null}

        {loadError ? null : loading ? (
          <div className="act-empty">Loading…</div>
        ) : !hasTraffic ? (
          <div className="act-empty">
            <strong>No conversations to measure.</strong>
            <br />
            This business has not handled any customer messages in the last 30 days, so there is no
            quality to report — which is different from perfect quality.
            <br />
            <button className="q-refresh" onClick={handleRefresh} disabled={busy}>
              {busy ? "Recomputing…" : "Recompute now"}
            </button>
          </div>
        ) : (
          <>
            <section className="q-cards">
              <Stat
                label="Handled without a human"
                value={pct(summary?.containmentRate)}
                note={`${summary?.aiAnswered ?? 0} conversations the agent answered`}
                tone={toneFor(summary?.containmentRate, 0.7, 0.5)}
              />
              <Stat
                label="A human had to join"
                value={pct(summary?.escalationRate)}
                note={`${summary?.escalated ?? 0} escalated`}
                tone={toneFor(summary?.escalationRate, 0.3, 0.5, true)}
              />
              <Stat
                label="Answered then corrected"
                value={String(summary?.corrections ?? 0)}
                note="a person replied directly after the agent"
                tone="plain"
              />
              <Stat
                label="Output tokens"
                value={compact(summary?.outputTokens ?? 0)}
                note="over the window — quality is never read without cost"
                tone="plain"
              />
            </section>

            <h2 className="act-sub-head">Daily</h2>
            <div className="q-chart" role="img" aria-label="Conversations per day, escalated portion shaded">
              {trend.map((day) => (
                <div className="q-col" key={day.day} title={`${day.day}: ${day.conversations} conversations, ${day.escalated} escalated`}>
                  <div className="q-bar" style={{ height: `${(day.conversations / peak) * 100}%` }}>
                    <div
                      className="q-bar-esc"
                      style={{
                        height: day.conversations
                          ? `${(day.escalated / day.conversations) * 100}%`
                          : "0%",
                      }}
                    />
                  </div>
                  {/* An in-progress day must not read as a collapse in volume. */}
                  <span className={`q-day${day.isComplete ? "" : " partial"}`}>
                    {day.day.slice(8)}
                  </span>
                </div>
              ))}
            </div>
            <p className="q-legend">
              <span className="q-key q-key-ai" /> handled by the agent
              <span className="q-key q-key-esc" /> a human joined
              <span className="q-partial-note">Today is still in progress and counts only so far.</span>
            </p>

            <button className="q-refresh" onClick={handleRefresh} disabled={busy}>
              {busy ? "Recomputing…" : "Recompute now"}
            </button>
          </>
        )}

        {hotspots.length > 0 ? (
          <>
            <h2 className="act-sub-head">What reaches a person most</h2>
            <div className="act-table">
              <table>
                <thead>
                  <tr>
                    <th>Kind of enquiry</th>
                    <th>Conversations</th>
                    <th>Reached a person</th>
                    <th>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {hotspots.map((spot) => (
                    <tr key={spot.intent}>
                      <td>{spot.intent}</td>
                      <td>{spot.conversations}</td>
                      <td className={spot.escalated ? "" : "act-zero"}>{spot.escalated}</td>
                      <td>{Math.round(spot.escalationRate * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Framed as a ranking, not a verdict. Some enquiries should reach
                a person every time — a live dispute at a law firm ought to, and
                an agent that stopped escalating them would be worse. */}
            <p className="q-hotspot-note">
              A high share is not automatically a fault — some enquiries should reach a person. But
              where it looks wrong, the usual cause is that the agent has nothing to answer from.{" "}
              <a href="/deck/knowledge">Check what it knows</a>.
            </p>
          </>
        ) : null}

        <section className="q-ask">
          <h2 className="act-sub-head">Ask about this business</h2>
          {canAnswer.length > 0 ? (
            <div className="q-can">
              <span>It can answer:</span>
              <ul>
                {canAnswer.map((what) => (
                  /* Clickable, because the shortest path from "what can I ask"
                     to an answer is not retyping the sentence. */
                  <li key={what}>
                    <button type="button" onClick={() => setQuestion(what)}>
                      {what}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <form onSubmit={handleAsk}>
            <input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="How often did a human have to step in last month?"
              maxLength={500}
              aria-label="Ask a question about this business"
            />
            <button type="submit" disabled={asking || !question.trim()}>
              {asking ? "Thinking…" : "Ask"}
            </button>
          </form>

          {reply ? (
            <div className={`q-reply${reply.matched ? "" : " unmatched"}`}>
              <p className="q-answer">{reply.answer}</p>
              {reply.rows.length > 0 ? (
                <div className="act-table q-reply-table">
                  <table>
                    <thead>
                      <tr>
                        {Object.keys(reply.rows[0]).map((key) => (
                          <th key={key}>{humanise(key)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {reply.rows.map((row, index) => (
                        <tr key={index}>
                          {Object.values(row).map((value, cell) => (
                            <td key={cell} className={value == null ? "act-zero" : ""}>
                              {value ?? "—"}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {/* Saying what we understood lets the reader catch a
                  misinterpretation, rather than trusting a number answering a
                  question they did not ask. */}
              {reply.matched ? (
                <p className="q-understood">Answered as: {reply.understood.toLowerCase()}</p>
              ) : null}
            </div>
          ) : null}

          <p className="q-ask-note">
            Questions are matched to a fixed set of reviewed queries — the model never writes
            database queries of its own, so it cannot reach another business&apos;s data or invent a
            figure. If nothing matches, it says so instead of guessing.
          </p>
        </section>

        <p className="act-caveat">
          <strong>What these numbers are not.</strong> Escalation is a signal, not a verdict — some
          conversations should reach a person, and an agent that never escalates is more likely
          avoiding handoffs than solving problems. Read it alongside cost: an agent that escalates
          less because it writes longer answers is not better, only more expensive. And messages an
          employee sends from their own phone are invisible here, so a conversation resolved that
          way looks contained.
        </p>

        {/* The platform-wide version of everything above, from the same
            conversation_metrics rows and the same hourly job. Placed last
            because a business's own numbers are what an operator came for. */}
        <BrainSection />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone: "good" | "warn" | "bad" | "plain";
}) {
  return (
    <div className={`q-card q-${tone}`}>
      <span className="q-label">{label}</span>
      <strong className="q-value">{value}</strong>
      <span className="q-note">{note}</span>
    </div>
  );
}

/** Null means "nothing to divide", which must not render as 0%. */
function pct(rate: number | null | undefined): string {
  if (rate == null) return "—";
  return `${Math.round(rate * 100)}%`;
}

function toneFor(
  rate: number | null | undefined,
  good: number,
  bad: number,
  inverted = false
): "good" | "warn" | "bad" | "plain" {
  if (rate == null) return "plain";
  const value = inverted ? 1 - rate : rate;
  const goodAt = inverted ? 1 - good : good;
  const badAt = inverted ? 1 - bad : bad;
  if (value >= goodAt) return "good";
  if (value <= badAt) return "bad";
  return "warn";
}

function humanise(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
