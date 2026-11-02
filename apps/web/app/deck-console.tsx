"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { OverviewMetrics } from "@nexus/shared";
import { getOverview, getStaffWork, type StaffWorkAttention } from "@/lib/api";
import { fontVariables } from "@/lib/fonts";
import { TENANTS } from "@/lib/tenants";
import { SystemHealth } from "./system-health";
import { AreaChart, ChartCard, NumberTile } from "./kit";
import { WaitingCards } from "./front/waiting-cards";
import "./deck/deck.css";
import "./kit/kit.css";

/* ---------------- static presentation data ---------------- */
type Stat = { k: string; v: string; unit?: string; d: string; cls: "up" | "flat"; spark: number[]; hi?: boolean };
/**
 * THE SHAPE OF THE DASHBOARD WITH NOTHING IN IT.
 *
 * These six cards used to carry invented figures — "128 active conversations",
 * "87% AI resolution", "1,402 messages today", "$5.10 est." — shown whenever
 * the platform had no traffic OR the API could not be reached. This page is
 * behind the login: it is the owner's own dashboard, and those numbers were
 * presented to them as their business's.
 *
 * Somebody had already noticed half of it. The activity feed below carries the
 * comment "Empty on purpose. This used to hold five invented conversations",
 * and the fabricated conversations were removed while the fabricated statistics
 * above them were left.
 *
 * The same fix has been applied to /deck/quality once already, for the same
 * reason: it drew zeros on a fetch failure until it was changed to refuse to
 * draw any number it did not receive. An outage that renders as a healthy
 * dashboard is the single failure mode this platform keeps finding in new
 * clothes.
 *
 * So: the labels stay, because an empty dashboard should still say what it
 * would show. The values are an em dash and the sparklines are empty, and the
 * caption below each one says which of the two silences this is — nothing has
 * happened yet, or nobody could ask.
 */
const NO_DATA: Stat[] = [
  { k: "Active conversations", v: "—", d: "", cls: "flat", spark: [], hi: true },
  { k: "AI resolution", v: "—", unit: "%", d: "", cls: "flat", spark: [] },
  { k: "Messages today", v: "—", d: "", cls: "flat", spark: [] },
  { k: "Avg first response", v: "—", unit: "s", d: "", cls: "flat", spark: [] },
  { k: "Governance holds", v: "—", d: "", cls: "flat", spark: [] },
  { k: "Tokens used", v: "—", d: "", cls: "flat", spark: [] },
];

/** The caption under every card, which is the only place the reason fits. */
const emptyStats = (reason: string): Stat[] => NO_DATA.map((stat) => ({ ...stat, d: reason }));

type TenantMeta = {
  slug: string;
  ref: string;
  nm: string;
  rl: string;
  st: "live" | "warn";
  msg: string;
  /**
   * The real message count, kept as a NUMBER as well as a sentence.
   *
   * The switchboard fires a signal along every dendrite, and it used to fire
   * along all five at the same rate whether the business had ten messages or
   * none. Motion is a claim: a link that pulses says traffic is flowing, and on
   * four of these it was flowing nowhere. `-1` means the API has not answered,
   * which is different again from zero and must not animate either.
   */
  count: number;
  ang: number;
};
// Derived from the one shared list. `msg` is only what shows before the API
// answers — real counts replace it — and it reads "—" rather than a plausible
// number so a console that failed to load data cannot be mistaken for a quiet
// one.
const TENANT_META: TenantMeta[] = TENANTS.map((t) => ({
  slug: t.slug,
  ref: t.ref,
  nm: t.name,
  rl: t.role,
  st: t.status === "live" ? "live" : "warn",
  msg: t.note,
  count: -1,
  ang: t.angle,
}));

/**
 * Empty for the same reason the feed is.
 *
 * This held a plausible-looking intent mix — inventory 38, bookings 27, order
 * status 18 — for a platform whose real distribution is roughly half people
 * selling TO the businesses. A shape that looks like a healthy retail funnel is
 * a worse kind of wrong than a blank panel, because nobody questions it.
 */
const INTENTS: { n: string; v: number }[] = [];

// Empty on purpose. This used to hold five invented conversations shown under
// a "Live feed" heading whenever the API had not answered — fabricated customer
// messages that read as real traffic, including Juris Prime quoting freezone
// licence timelines months after that turned out to be the wrong business
// entirely. A deck that invents conversations is worse than one that admits it
// has none.
const FEED: Array<{ ini: string; nm: string; t: string; tag: string; tags: string; msg: string }> = [];

/* ---------------- live-metric mappers (fall back to sample when empty) ---------------- */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();
}
function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}
function prettyIntent(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function liveStats(m: OverviewMetrics): Stat[] {
  const tokens = m.tokensUsed;
  return [
    { k: "Active conversations", v: String(m.activeConversations), d: "open + pending", cls: "flat", spark: [], hi: true },
    // No unit on a value that does not exist: "—%" read as a broken screen.
    { k: "AI resolution", v: m.aiResolutionPct != null ? String(m.aiResolutionPct) : "—", unit: m.aiResolutionPct != null ? "%" : undefined, d: m.aiResolutionPct != null ? "last 7 days" : "No data this week", cls: "flat", spark: [] },
    { k: "Messages today", v: m.messagesToday.toLocaleString(), d: "since midnight", cls: "flat", spark: [] },
    { k: "Avg first response", v: m.avgFirstResponseMs != null ? (m.avgFirstResponseMs / 1000).toFixed(1) : "—", unit: m.avgFirstResponseMs != null ? "s" : undefined, d: m.avgFirstResponseMs != null ? "last 7 days" : "No data this week", cls: "flat", spark: [] },
    { k: "Governance holds", v: String(m.governanceHolds), d: "last 24h", cls: "flat", spark: [] },
    { k: "Tokens used", v: tokens >= 1000 ? (tokens / 1000).toFixed(1) : String(tokens), unit: tokens >= 1000 ? "k" : undefined, d: "last 7 days", cls: "flat", spark: [] },
  ];
}
function liveIntents(m: OverviewMetrics): { n: string; v: number }[] {
  const total = m.intents.reduce((a, b) => a + b.count, 0) || 1;
  return m.intents.map((it) => ({ n: prettyIntent(it.intent), v: Math.round((it.count / total) * 100) }));
}
function liveFeed(m: OverviewMetrics) {
  return m.feed.map((f) => {
    const isHuman = f.senderType === "human_agent";
    const isAi = f.senderType === "ai_agent";
    return {
      ini: initials(f.org),
      nm: f.org,
      t: timeAgo(f.createdAt),
      tag: isHuman ? "h" : "ai",
      tags: isHuman ? "Human" : isAi ? "AI" : "System",
      msg: f.body,
    };
  });
}

/**
 * The admin's front page — the operations overview.
 *
 * It sits inside ConsoleShell (app/page.tsx) like every other signed-in screen,
 * so the dock, the ⌘K search, the assistant and the account menu all come from
 * the shell. This file is only the page (1 Nov 2026).
 */
export default function DeckConsole() {
  const boardRef = useRef<HTMLDivElement>(null);

  const [tenants, setTenants] = useState<TenantMeta[]>(TENANT_META);
  const [overview, setOverview] = useState<OverviewMetrics | null>(null);
  // Distinguishes "the API said there is nothing" from "the API did not answer".
  const [unreachable, setUnreachable] = useState(false);
  const [nodes, setNodes] = useState<{ meta: TenantMeta; x: number; y: number }[]>([]);
  const [links, setLinks] = useState<
    { d: string; dur: number; width: number; alive: boolean; slug: string }[]
  >([]);
  /** Faint arcs between neighbouring businesses — they share one number. */
  const [web, setWeb] = useState<string[]>([]);
  const [clock, setClock] = useState("");
  // The customers waiting longest, for the front page's coloured cards (Cream
  // pages 2a). A failed load is said as such, never as "nobody is waiting".
  const [waiting, setWaiting] = useState<
    { list: StaffWorkAttention["oldestWaiting"]; total: number; at: number } | "failed" | null
  >(null);
  useEffect(() => {
    getStaffWork()
      .then(({ attention }) =>
        setWaiting({ list: attention.oldestWaiting ?? [], total: attention.waitingTotal ?? 0, at: Date.now() })
      )
      .catch(() => setWaiting("failed"));
  }, []);

  // The header's counts and account now live in header-menus.tsx, beside the
  // panels that explain them. A badge whose number is fetched here and whose
  // meaning is rendered there is two files that have to agree about one fact.

  // live overview from the API (falls back to sample data on any error)
  useEffect(() => {
    getOverview()
      .then(({ metrics }) => {
        setOverview(metrics);
        setTenants(
          TENANT_META.map((meta) => {
            const t = metrics.tenants.find((x) => x.slug === meta.slug);
            if (!t) return meta;
            return {
              ...meta,
              nm: t.name || meta.nm,
              count: metrics.hasData ? t.messageCount : -1,
              msg: metrics.hasData ? `${t.messageCount} msgs` : meta.msg,
            };
          })
        );
      })
      .catch(() => {
        // RECORDED, NOT SWALLOWED. This used to keep the static sample on any
        // error, so an unreachable API rendered as a busy, healthy business.
        // The two silences have to be told apart: "nothing has happened yet" is
        // news about the platform, "nobody could ask" is news about this page.
        setUnreachable(true);
      });
  }, []);

  const live = overview?.hasData ?? false;
  const displayStats =
    live && overview
      ? liveStats(overview)
      : emptyStats(
          unreachable
            ? "could not reach the API"
            : overview
              ? "no traffic yet"
              : "loading…"
        );
  const displayIntents = live && overview && overview.intents.length ? liveIntents(overview) : INTENTS;
  const displayFeed = live && overview && overview.feed.length ? liveFeed(overview) : FEED;

  // switchboard geometry (measured, responsive)
  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const layout = () => {
      const bw = el.clientWidth;
      const bh = el.clientHeight;
      const cx = bw / 2;
      const cy = bh / 2;
      // ELLIPTICAL, NOT CIRCULAR. A radius from min(w, h) throws away the
      // width the board actually has, and stacked the five cards on top of the
      // nucleus and each other.
      const rx = bw * 0.34;
      const ry = bh * 0.36;
      const ns = tenants.map((meta) => {
        const a = (meta.ang * Math.PI) / 180;
        return { meta, x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry };
      });
      setNodes(ns);

      // A DENDRITE, NOT A WIRE. The curve bows away from the straight line by a
      // fraction of its own length, so five of them fan out of the nucleus
      // instead of meeting it as spokes on a wheel.
      const curve = (x2: number, y2: number, bow: number) => {
        const mx = (cx + x2) / 2;
        const my = (cy + y2) / 2;
        // Perpendicular to the run, so the bow is always sideways.
        const nx = -(y2 - cy);
        const ny = x2 - cx;
        const len = Math.hypot(nx, ny) || 1;
        return `M${cx} ${cy} Q${mx + (nx / len) * bow} ${my + (ny / len) * bow} ${x2} ${y2}`;
      };

      setLinks(
        ns.map((n, i) => ({
          slug: n.meta.slug,
          // Bow proportional to the run, so the arc reads at any board size.
          d: curve(n.x, n.y, (i % 2 === 0 ? 1 : -1) * Math.hypot(n.x - cx, n.y - cy) * 0.3),
          // Busier businesses fire faster. Quiet ones do not fire at all.
          dur: n.meta.count > 0 ? Math.max(1.6, 4.4 - n.meta.count * 0.18) : 0,
          width: n.meta.count > 0 ? Math.min(2.4, 1 + n.meta.count * 0.08) : 0.8,
          alive: n.meta.count > 0,
        }))
      );

      // Ring arcs, node to node. Five businesses share one WhatsApp number, so
      // the picture should say they are connected to each other and not only to
      // the middle -- which is the thing the routing actually has to get right.
      setWeb(
        ns.map((n, i) => {
          const next = ns[(i + 1) % ns.length];
          const mx = (n.x + next.x) / 2;
          const my = (n.y + next.y) / 2;
          // Bowed AWAY from the nucleus, so the ring encloses the picture
          // instead of lying under the dendrites it is meant to sit behind.
          const dx = mx - cx;
          const dy = my - cy;
          const len = Math.hypot(dx, dy) || 1;
          return `M${n.x} ${n.y} Q${mx + (dx / len) * 34} ${my + (dy / len) * 34} ${next.x} ${next.y}`;
        })
      );
    };
    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tenants]);

  // clock
  useEffect(() => {
    const tick = () =>
      setClock(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      clearInterval(id);
    };
  }, []);


  /**
   * The conversations chart.
   *
   * It was drawn from [46, 58, 52, 74, 68, 88, 102] — a rising seven-day
   * trend, hardcoded, rendered unconditionally, on a platform that has had
   * seventeen conversations in its entire existence. Not a fallback: there
   * was no path on which it drew anything else.
   *
   * There is no series to replace it with. `/api/metrics/overview` returns
   * aggregates and no history, so the honest chart is an empty one — the same
   * answer the stat cards above already give with their empty sparklines.
   * When a real series exists, pass it here and this draws it.
   */
  //
  // Since 2 Nov 2026 a real series exists: conversations per day from the
  // nightly rollup (`conversationsByDay`), and the kit's AreaChart draws it —
  // or, with fewer than two days, says there are not enough days yet.
  const days = useMemo(
    () => (overview?.conversationsByDay ?? []).map((d) => ({ label: dayLabel(d.day), value: d.conversations })),
    [overview]
  );

  return (
    <div className={`deck-root ${fontVariables}`}>
      {/* .app / .main stay: the overview's card styles are keyed off them.
          Inside the shell, .app is a plain block (console-shell.css). */}
      <div className="app">
        {/* A div, not <main>: the shell already holds the page's one <main>. */}
        <div className="main">
          <div className="page-head">
            <div>
              <div className="eyebrow">Command deck · Live</div>
              <h1>Operations overview</h1>
            </div>
            <div className="meta">
              <span className="pill">
                <span className={`dot ${live ? "live" : "warnd"}`} />
                {live ? "Live data" : "Sample data"}
              </span>
              <span className="pill">
                <span className="dot live" />
                Webhook connected
              </span>
              {/* Whether the SWEEPS are alive, not just the data — a stopped
                  operator looks exactly like a quiet platform without this. */}
              <SystemHealth />
            </div>
          </div>

          {/* Where an owner goes from here — each a real screen. */}
          <nav className="kit-pills adm-quick" aria-label="Quick actions">
            {QUICK.map((q) => (
              <a key={q.href} href={q.href} className="kit-pill" title={q.hint}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d={q.d} />
                </svg>
                {q.label}
              </a>
            ))}
          </nav>

          <div className="kit-tiles adm-tiles">
            {displayStats.map((s) => (
              <NumberTile key={s.k} label={s.k} value={s.v} unit={s.unit} note={s.d} icon={STAT_ICON[s.k]} spark={s.spark} />
            ))}
          </div>

          {/* The video's "hot deals", as the customers waiting longest. */}
          <section className="adm-waiting" aria-labelledby="adm-waiting-h">
            <div className="adm-section-head">
              <h2 id="adm-waiting-h">Customers waiting</h2>
              <span>Longest first, every business</span>
            </div>
            {waiting === "failed" ? (
              <p className="chart-empty">Who is waiting could not be loaded. Open Staff work to see it.</p>
            ) : waiting ? (
              <WaitingCards waiting={waiting.list} total={waiting.total} now={waiting.at} />
            ) : (
              <p className="chart-empty">Loading who is waiting…</p>
            )}
          </section>

          <div className="grid-2">
            <div className="card glass">
              <div className="card-h">
                <h3>
                  <span className="ic">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <circle cx="12" cy="12" r="3" />
                      <circle cx="5" cy="5" r="2" />
                      <circle cx="19" cy="5" r="2" />
                      <circle cx="5" cy="19" r="2" />
                      <circle cx="19" cy="19" r="2" />
                      <path d="M7 7l3 3m4 0 3-3M7 17l3-3m4 0 3 3" />
                    </svg>
                  </span>
                  Switchboard router
                </h3>
                <span className="pill">
                  <span className="dot live" />
                  Routing
                </span>
              </div>
              <div className="switchboard" ref={boardRef}>
                <svg className="sb-net">
                  <defs>
                    {/* A dendrite is brighter where it leaves the nucleus and
                        fades towards the business, which is the direction a
                        routed message actually travels. */}
                    <linearGradient id="sb-dendrite" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="var(--signal)" stopOpacity=".30" />
                      <stop offset="100%" stopColor="var(--signal)" stopOpacity=".10" />
                    </linearGradient>
                    {/* The carrying one. A business with traffic should be the
                        thing your eye finds first, and the four without it
                        should recede rather than compete. */}
                    <linearGradient id="sb-dendrite-on" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="var(--signal)" stopOpacity="1" />
                      <stop offset="100%" stopColor="var(--signal)" stopOpacity=".45" />
                    </linearGradient>
                  </defs>

                  {/* The ring: every business connected to its neighbours, not
                      only to the middle. Faint on purpose — it says "one number
                      serves all of these", which is context rather than news. */}
                  {web.map((d, i) => (
                    <path key={`w${i}`} d={d} className="sb-web" fill="none" />
                  ))}

                  {links.map((l) => (
                    <g key={l.slug}>
                      <path
                        d={l.d}
                        fill="none"
                        stroke={l.alive ? "url(#sb-dendrite-on)" : "url(#sb-dendrite)"}
                        strokeWidth={l.alive ? l.width : 1}
                        strokeLinecap="round"
                        className={l.alive ? "sb-axon on" : "sb-axon"}
                      />
                      {/*
                        A SIGNAL ONLY WHERE THERE IS TRAFFIC.
                        Motion is a claim. This used to fire along all five
                        links at the same rate whether the business had ten
                        messages or none — four of them animating a flow that
                        was flowing nowhere. Quiet businesses now get a still,
                        dimmer dendrite, which is the honest picture and also
                        makes the one that IS busy the thing your eye finds.
                      */}
                      {l.alive ? (
                        <circle r="2.6" fill="var(--signal)" className="sb-pulse">
                          <animateMotion dur={`${l.dur}s`} repeatCount="indefinite" path={l.d} />
                          <animate
                            attributeName="opacity"
                            values="0;1;1;0"
                            keyTimes="0;.15;.75;1"
                            dur={`${l.dur}s`}
                            repeatCount="indefinite"
                          />
                        </circle>
                      ) : null}
                    </g>
                  ))}
                  {/* The synapse. Small, and the only mark that sits exactly
                      where a dendrite meets a business — which is the join the
                      whole routing question is about. */}
                  {nodes.map((n) => (
                    <circle
                      key={`s${n.meta.slug}`}
                      cx={n.x}
                      cy={n.y}
                      r={n.meta.count > 0 ? 4 : 3}
                      className={n.meta.count > 0 ? "sb-syn on" : "sb-syn"}
                    />
                  ))}
                </svg>
                <div className="core">
                  <div>
                    <b>NEXUS</b>
                    <span>Switchboard</span>
                  </div>
                </div>
                {nodes.map((n) => (
                  <div className="node" key={n.meta.slug} style={{ left: n.x, top: n.y }}>
                    <div className="ref">{n.meta.ref}</div>
                    <div className="nm">{n.meta.nm}</div>
                    <div className="rl">{n.meta.rl}</div>
                    <div className="st">
                      <span className={`dot ${n.meta.st === "warn" ? "warnd" : "live"}`} />
                      {n.meta.msg}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card glass">
              <div className="card-h">
                <h3>
                  <span className="ic">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4Z" />
                    </svg>
                  </span>
                  Governance
                </h3>
                <span className="pill mono" style={{ color: "var(--muted)" }}>
                  Last 24h
                </span>
              </div>
              {/* THE THIRD ROUND OF THIS IN ONE FILE.

                  The header above records that invented conversations were
                  removed and invented statistics were left; the statistics
                  were then fixed and THESE were left. Four hardcoded
                  governance figures on the owner's own dashboard: "3 held",
                  "low · 94%", "6 escalated" attributed by name to Juris Prime
                  Legal, and "100%" coverage — with meters drawn to match.

                  Production has had ZERO escalations. The 94% was never
                  measured by anything.

                  Only one of the four has a real number behind it today, so
                  only one of them shows one. The rest keep their labels,
                  because an empty dashboard should still say what it would
                  show, and carry an em dash because that is what is true. */}
              <GovRow
                label="Held by governance"
                sub="PII scan and grounding judge, replies withheld"
                val={live && overview ? String(overview.governanceHolds) : null}
                pct={0}
                color="var(--good)"
                tone="var(--good)"
              />
              <GovRow
                label="Hallucination judge"
                sub="Runs on every reply; no breakdown is published yet"
                val={null}
                pct={0}
                color="var(--good)"
                tone="var(--warn)"
              />
              <GovRow
                label="Escalated to human"
                sub="Not counted here yet — see Agent quality"
                val={null}
                pct={0}
                color="var(--crit)"
                tone="var(--crit)"
              />
              <GovRow
                label="Reply never dropped"
                sub="Silence guarantee — measured by the operators, not here"
                val={null}
                pct={0}
                color="var(--good)"
                tone="var(--signal)"
              />
            </div>
          </div>

          <div className="grid-3">
            {/* The pill once said "+18%" in green, permanently, against a
                platform whose entire history was seventeen conversations: a
                growth figure nothing computed. The figure here is the count of
                open conversations the API sent, and the line is real days. */}
            <ChartCard
              title="Conversations"
              figure={live && overview ? String(overview.activeConversations) : undefined}
              note={live && overview ? "open now · each day, last 14 days" : undefined}
            >
              {/* Which of the two silences this is: an unreachable platform is
                  said as such, never drawn as an empty chart. */}
              {unreachable ? (
                <p className="chart-empty">Nothing to draw: the platform could not be reached.</p>
              ) : (
                <AreaChart points={days} ariaLabel="Conversations per day, last 14 days" />
              )}
            </ChartCard>

            <div className="card glass">
              <div className="card-h">
                <h3>
                  <span className="ic">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 7v5l3 3" />
                    </svg>
                  </span>
                  Intent mix
                </h3>
                <span className="pill mono" style={{ color: "var(--muted)" }}>
                  classified
                </span>
              </div>
              {displayIntents.map((it) => (
                <div className="bar-row" key={it.n}>
                  <div className="bar-top">
                    <span>{it.n}</span>
                    <b>{it.v}%</b>
                  </div>
                  <div className="kit-hbar">
                    <i style={{ width: `${it.v}%` }} />
                  </div>
                </div>
              ))}
            </div>

            <div className="card glass">
              <div className="card-h">
                <h3>
                  <span className="ic">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8Z" />
                    </svg>
                  </span>
                  Live feed
                </h3>
                <span className="pill">
                  <span className="dot live" />
                  Now
                </span>
              </div>
              <div className="feed">
                {displayFeed.length === 0 && (
                  <p className="feed-empty">
                    No live data yet — this fills in as conversations arrive.
                  </p>
                )}
                {displayFeed.map((f, i) => (
                  <div className="feed-item" key={i}>
                    <div className="feed-av">{f.ini}</div>
                    <div className="feed-b">
                      <div className="top">
                        <b>{f.nm}</b>
                        <span className={`tag ${f.tag}`}>{f.tags}</span>
                        <time>{f.t}</time>
                      </div>
                      <p>{f.msg}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="foot">
            <span>NEXUS AGENTIC OS · nexusagenticos.com</span>
            <span>Session · operator@nexusagenticos.com · {clock}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The owner's next moves from the overview — every one a real screen. */
const QUICK: { href: string; label: string; hint: string; d: string }[] = [
  { href: "/inbox", label: "Conversations", hint: "Every chat, every channel", d: "M4 5h16v11H8l-4 4V5Z" },
  { href: "/deck/operators", label: "Needs attention", hint: "What is wrong right now", d: "M12 3 2 20h20L12 3Zm0 6v5m0 3h.01" },
  { href: "/deck/broadcasts", label: "Broadcast", hint: "A campaign or a customer list", d: "M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1Zm13-3a5 5 0 0 1 0 8" },
  { href: "/deck/team", label: "Team & inbox rules", hint: "People, rotas, auto-assign", d: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 10a7 7 0 0 1 14 0m1-10a3 3 0 1 0 0-6m5 16a5 5 0 0 0-4-4.9" },
  { href: "/deck/activity", label: "Staff work", hint: "Every chat and action, per person", d: "M3 12h4l3 8 4-16 3 8h4" },
];

/** An icon for each KPI tile — by the label the tile already carries. */
const STAT_ICON: Record<string, string> = {
  "Active conversations": "M4 5h16v11H8l-4 4V5Z",
  "AI resolution": "M12 3v3m0 12v3M3 12h3m12 0h3M6 6l2 2m8 8 2 2M6 18l2-2m8-8 2-2M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
  "Messages today": "M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z",
  "Avg first response": "M12 8v5l3 2M12 22a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z",
  "Governance holds": "M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4Z",
  "Tokens used": "M4 7h16M4 12h16M4 17h10",
};

function GovRow({
  label,
  sub,
  val,
  valColor,
  pct,
  color,
  tone,
}: {
  label: string;
  sub: string;
  /** Null when the platform did not send one. Never a plausible stand-in. */
  val: string | null;
  valColor?: string;
  /** Ignored when val is null — a full meter under an em dash is still a claim. */
  pct: number;
  color: string;
  tone: string;
}) {
  return (
    <div className="gov-row">
      <div className="lbl">
        <span className="ic" style={{ borderColor: "var(--hairline)" }}>
          <svg viewBox="0 0 24 24" fill="none" stroke={tone} strokeWidth="1.8">
            <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4Z" />
          </svg>
        </span>
        <div>
          {label}
          <small>{sub}</small>
        </div>
      </div>
      <div style={{ textAlign: "right" }}>
        <b className="mono" style={val !== null && valColor ? { color: valColor } : undefined}>
          {val ?? "—"}
        </b>
        {/* THE METER IS A CLAIM TOO. A bar drawn to 94% beside an em dash
            reads as "94%" to anybody glancing, which is most people. */}
        <div className="meter">
          {val === null ? null : <i style={{ width: `${pct}%`, background: color }} />}
        </div>
      </div>
    </div>
  );
}

/** "Sat 31 Oct" for a `YYYY-MM-DD` day, read in UTC so it never shifts a day. */
function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}
