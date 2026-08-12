"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { OverviewMetrics } from "@nexus/shared";
import { initDeckFx } from "@/lib/deck-fx";
import { getOverview } from "@/lib/api";
import { fontVariables } from "@/lib/fonts";
import { TENANTS } from "@/lib/tenants";
import "./deck/deck.css";

/* ---------------- static presentation data ---------------- */
type Stat = { k: string; v: string; unit?: string; d: string; cls: "up" | "flat"; spark: number[]; hi?: boolean };
const STATS: Stat[] = [
  { k: "Active conversations", v: "128", d: "+12 vs 1h", cls: "up", spark: [8, 10, 9, 13, 12, 16, 15, 19], hi: true },
  { k: "AI resolution", v: "87", unit: "%", d: "+3.1 pts", cls: "up", spark: [70, 74, 72, 78, 80, 83, 85, 87] },
  { k: "Messages today", v: "1,402", d: "+18% vs avg", cls: "up", spark: [40, 55, 50, 70, 66, 82, 95, 110] },
  { k: "Avg first response", v: "2.4", unit: "s", d: "−0.6s faster", cls: "up", spark: [5, 4.4, 4, 3.6, 3.1, 2.9, 2.6, 2.4] },
  { k: "Governance holds", v: "6", d: "3 PII · 3 risk", cls: "flat", spark: [2, 4, 3, 5, 4, 6, 5, 6] },
  { k: "Tokens used", v: "214", unit: "k", d: "$5.10 est.", cls: "flat", spark: [120, 150, 140, 175, 190, 200, 208, 214] },
];

type TenantMeta = { slug: string; ref: string; nm: string; rl: string; st: "live" | "warn"; msg: string; ang: number };
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
  ang: t.angle,
}));

const INTENTS = [
  { n: "Inventory inquiry", v: 38 },
  { n: "Appointment booking", v: 27 },
  { n: "Order status", v: 18 },
  { n: "General question", v: 12 },
  { n: "Escalation", v: 5 },
];

// Empty on purpose. This used to hold five invented conversations shown under
// a "Live feed" heading whenever the API had not answered — fabricated customer
// messages that read as real traffic, including Juris Prime quoting freezone
// licence timelines months after that turned out to be the wrong business
// entirely. A deck that invents conversations is worse than one that admits it
// has none.
const FEED: Array<{ ini: string; nm: string; t: string; tag: string; tags: string; msg: string }> = [];

/* ---------------- helpers ---------------- */
function sparkPath(vals: number[], w: number, h: number): string {
  const mn = Math.min(...vals);
  const mx = Math.max(...vals);
  const r = mx - mn || 1;
  return vals
    .map((v, i) => {
      const x = (i / (vals.length - 1)) * w;
      const y = h - ((v - mn) / r) * (h - 4) - 2;
      return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join("");
}

function Spark({ vals }: { vals: number[]; hi?: boolean }) {
  const id = useMemo(() => "sg" + Math.random().toString(36).slice(2, 8), []);
  const p = sparkPath(vals, 64, 26);
  const color = "#1d3fbf";
  return (
    <svg className="spark" viewBox="0 0 64 26" fill="none">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${p} L64 26 L0 26 Z`} fill={`url(#${id})`} opacity=".18" />
      <path d={p} stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

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
    { k: "AI resolution", v: m.aiResolutionPct != null ? String(m.aiResolutionPct) : "—", unit: "%", d: "last 7 days", cls: "flat", spark: [] },
    { k: "Messages today", v: m.messagesToday.toLocaleString(), d: "since midnight", cls: "flat", spark: [] },
    { k: "Avg first response", v: m.avgFirstResponseMs != null ? (m.avgFirstResponseMs / 1000).toFixed(1) : "—", unit: "s", d: "last 7 days", cls: "flat", spark: [] },
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

const BrandMark = () => (
  <span className="brand-mark">
    <svg viewBox="0 0 32 32" fill="none">
      <path d="M16 2 3 9v14l13 7 13-7V9L16 2Z" stroke="#16160f" strokeWidth="1.3" />
      <path d="M16 9 9 12.5v7L16 23l7-3.5v-7L16 9Z" fill="none" stroke="#1d3fbf" strokeWidth="1.2" />
      <circle cx="16" cy="16" r="2" fill="#1d3fbf" />
    </svg>
  </span>
);

export default function DeckConsole() {
  const rootRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const [tenants, setTenants] = useState<TenantMeta[]>(TENANT_META);
  const [overview, setOverview] = useState<OverviewMetrics | null>(null);
  const [nodes, setNodes] = useState<{ meta: TenantMeta; x: number; y: number }[]>([]);
  const [links, setLinks] = useState<{ x1: number; y1: number; x2: number; y2: number; dur: number }[]>([]);
  const [grown, setGrown] = useState(false);
  const [clock, setClock] = useState("");

  // live overview from the API (falls back to sample data on any error)
  useEffect(() => {
    getOverview()
      .then(({ metrics }) => {
        setOverview(metrics);
        setTenants(
          TENANT_META.map((meta) => {
            const t = metrics.tenants.find((x) => x.slug === meta.slug);
            if (!t) return meta;
            return { ...meta, nm: t.name || meta.nm, msg: metrics.hasData ? `${t.messageCount} msgs` : meta.msg };
          })
        );
      })
      .catch(() => {
        /* API unreachable — keep the static sample */
      });
  }, []);

  const live = overview?.hasData ?? false;
  const displayStats = live && overview ? liveStats(overview) : STATS;
  const displayIntents = live && overview && overview.intents.length ? liveIntents(overview) : INTENTS;
  const displayFeed = live && overview && overview.feed.length ? liveFeed(overview) : FEED;

  // visual effects
  useEffect(() => {
    if (rootRef.current) return initDeckFx(rootRef.current);
  }, []);

  // switchboard geometry (measured, responsive)
  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const layout = () => {
      const bw = el.clientWidth;
      const bh = el.clientHeight;
      const cx = bw / 2;
      const cy = bh / 2;
      const R = Math.min(bw, bh) * 0.36;
      const ns = tenants.map((meta) => {
        const a = (meta.ang * Math.PI) / 180;
        return { meta, x: cx + Math.cos(a) * R * 1.15, y: cy + Math.sin(a) * R };
      });
      setNodes(ns);
      setLinks(ns.map((n, i) => ({ x1: cx, y1: cy, x2: n.x, y2: n.y, dur: 2.2 + i * 0.4 })));
    };
    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tenants]);

  // grow bars + clock
  useEffect(() => {
    const raf = requestAnimationFrame(() => setGrown(true));
    const tick = () =>
      setClock(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(id);
    };
  }, []);

  async function signOut() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    router.push("/");
    router.refresh();
  }

  // area chart path (static sample)
  const area = useMemo(() => {
    const vals = [46, 58, 52, 74, 68, 88, 102];
    const w = 320;
    const h = 150;
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    const r = mx - mn || 1;
    const pts = vals.map((v, i) => [(i / (vals.length - 1)) * w, h - ((v - mn) / r) * (h - 22) - 14]);
    const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
    return { line, fill: `${line} L${w} ${h} L0 ${h} Z`, last: pts[pts.length - 1] };
  }, []);

  return (
    <div className={`deck-root ${fontVariables}`} ref={rootRef}>
      <canvas className="bg" />
      <div className="grid-overlay" />
      <div className="vignette" />
      <div className="cur-ring" />
      <div className="cur-dot" />

      <div className="app">
        <header className="topbar">
          <div className="brand">
            <BrandMark />
          </div>
          <button className="tenant-switch">
            <span className="dot live" />
            <b>All tenants</b>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          <div className="search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input placeholder="Search conversations, contacts, agents…" />
            <kbd>⌘K</kbd>
          </div>
          <div className="top-right">
            <button className="icon-btn" title="Governance alerts">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4Z" />
              </svg>
              <span className="badge">6</span>
            </button>
            <button className="icon-btn" title="Notifications">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M6 9a6 6 0 1 1 12 0c0 6 2 7 2 7H4s2-1 2-7Z" />
                <path d="M10 20a2 2 0 0 0 4 0" />
              </svg>
            </button>
            <div className="avatar" title="Operator">
              AA
            </div>
          </div>
        </header>

        <nav className="rail">
          <a className="on" title="Overview">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <rect x="3" y="3" width="8" height="8" rx="1.5" />
              <rect x="13" y="3" width="8" height="5" rx="1.5" />
              <rect x="13" y="10" width="8" height="11" rx="1.5" />
              <rect x="3" y="13" width="8" height="8" rx="1.5" />
            </svg>
            <span className="tip">Overview</span>
          </a>
          <a title="Unified Inbox" href="/inbox">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8Z" />
            </svg>
            <span className="tip">Unified Inbox</span>
          </a>
          <a title="Team" href="/deck/team">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <circle cx="9" cy="8" r="3.1" />
              <path d="M2.5 20c0-3.3 2.9-5.6 6.5-5.6s6.5 2.3 6.5 5.6" />
              <path d="M16.5 5.6a3.1 3.1 0 0 1 0 5.9M18 14.8c2.1.7 3.5 2.5 3.5 5.2" />
            </svg>
            <span className="tip">Team</span>
          </a>
          {/* Team activity, broadcasts. Domain Agents, Governance and Analytics
              used to sit here with no href — they rendered, highlighted on
              hover, and did nothing when clicked, which reads as a broken
              product rather than an unfinished one. They come back when there
              is a page behind them. */}
          <a title="Customer Links" href="/deck/links">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="M10 13a4 4 0 0 0 5.7.4l3-3a4 4 0 0 0-5.7-5.7l-1.7 1.7" />
              <path d="M14 11a4 4 0 0 0-5.7-.4l-3 3a4 4 0 0 0 5.7 5.7l1.7-1.7" />
            </svg>
            <span className="tip">Customer Links</span>
          </a>
          <a title="Follow-ups" href="/deck/tasks">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="M9 5h10M9 12h10M9 19h10" />
              <path d="M3.5 5.2l1.4 1.4L7.6 3.8M3.5 12.2l1.4 1.4 2.7-2.8" />
              <path d="M3.2 18.2h3.6" />
            </svg>
            <span className="tip">Follow-ups</span>
          </a>
          <a title="Knowledge" href="/deck/knowledge">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5V5.5Z" />
              <path d="M8 7.5h7M8 11h5" />
            </svg>
            <span className="tip">Knowledge</span>
          </a>
          <a title="Team Activity" href="/deck/activity">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="M3 12h3.5l2.5-6 3.5 13 2.5-7h6" />
            </svg>
            <span className="tip">Team Activity</span>
          </a>
          <a title="Agent Quality" href="/deck/quality">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="M4 20V10m6 10V4m6 16v-7m4 7H2" />
            </svg>
            <span className="tip">Agent Quality</span>
          </a>
          <a title="Broadcasts" href="/deck/broadcasts">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="M3 11l18-8-8 18-2-8-8-2Z" />
            </svg>
            <span className="tip">Broadcasts</span>
          </a>
          <span className="sep" />
          <a onClick={signOut} title="Sign out">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11" />
            </svg>
            <span className="tip">Sign out</span>
          </a>
        </nav>

        <main className="main">
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
            </div>
          </div>

          <div className="dither" />

          <div className="stats">
            {displayStats.map((s) => (
              <div className={`stat glass${s.hi ? " hi" : ""}`} key={s.k}>
                <div className="k">{s.k}</div>
                <div className="v">
                  {s.v}
                  {s.unit && <small>{s.unit}</small>}
                </div>
                <div className={`d ${s.cls}`}>
                  {s.cls === "up" ? "▲" : "■"} {s.d}
                </div>
                {s.spark.length > 0 && <Spark vals={s.spark} hi={s.hi} />}
              </div>
            ))}
          </div>

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
                <svg>
                  {links.map((l, i) => (
                    <g key={i}>
                      <line
                        x1={l.x1}
                        y1={l.y1}
                        x2={l.x2}
                        y2={l.y2}
                        stroke="rgba(22,22,15,.32)"
                        strokeWidth="1"
                        strokeDasharray="3 4"
                      />
                      <circle r="2.4" fill="#1d3fbf">
                        <animateMotion dur={`${l.dur}s`} repeatCount="indefinite" path={`M${l.x1} ${l.y1} L${l.x2} ${l.y2}`} />
                        <animate attributeName="opacity" values="0;1;0" dur={`${l.dur}s`} repeatCount="indefinite" />
                      </circle>
                    </g>
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
              <GovRow label="PII scan" sub="Deterministic redaction pass" val="3 held" pct={12} color="var(--good)" tone="var(--good)" />
              <GovRow label="Hallucination judge" sub="Claude Haiku · grounding check" val="low · 94%" pct={94} color="linear-gradient(90deg,var(--good),var(--blueprint))" tone="var(--warn)" />
              <GovRow label="Escalated to human" sub="Juris Prime Legal · strict tier" val="6" valColor="var(--crit)" pct={22} color="var(--crit)" tone="var(--crit)" />
              <GovRow label="Reply never dropped" sub="Silence-guarantee coverage" val="100%" valColor="var(--good)" pct={100} color="var(--good)" tone="var(--blueprint)" />
            </div>
          </div>

          <div className="grid-3">
            <div className="card glass">
              <div className="card-h">
                <h3>
                  <span className="ic">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d="M4 20V10m6 10V4m6 16v-7m4 7H2" />
                    </svg>
                  </span>
                  Conversations
                </h3>
                <span className="pill mono" style={{ color: "var(--good)" }}>
                  +18%
                </span>
              </div>
              <svg className="area" viewBox="0 0 320 150" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#1d3fbf" stopOpacity=".22" />
                    <stop offset="1" stopColor="#1d3fbf" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d="M0 75 H320" stroke="rgba(22,22,15,.1)" />
                <path d="M0 120 H320" stroke="rgba(22,22,15,.07)" />
                <path d={area.fill} fill="url(#ag)" />
                <path d={area.line} fill="none" stroke="#1d3fbf" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx={area.last[0]} cy={area.last[1]} r="3.5" fill="#1d3fbf" />
              </svg>
              <div className="foot" style={{ marginTop: 12 }}>
                <span>Mon</span>
                <span>Tue</span>
                <span>Wed</span>
                <span>Thu</span>
                <span>Fri</span>
                <span>Sat</span>
                <span>Sun</span>
              </div>
            </div>

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
                  <div className="bar">
                    <i style={{ width: grown ? `${it.v}%` : "0%" }} />
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
        </main>
      </div>
    </div>
  );
}

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
  val: string;
  valColor?: string;
  pct: number;
  color: string;
  tone: string;
}) {
  return (
    <div className="gov-row">
      <div className="lbl">
        <span className="ic" style={{ borderColor: "var(--line)" }}>
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
        <b className="mono" style={valColor ? { color: valColor } : undefined}>
          {val}
        </b>
        <div className="meter">
          <i style={{ width: `${pct}%`, background: color }} />
        </div>
      </div>
    </div>
  );
}
