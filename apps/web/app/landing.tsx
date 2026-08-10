"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { initDeckFx } from "@/lib/deck-fx";
import { fontVariables } from "@/lib/fonts";
import { TENANTS } from "@/lib/tenants";
import "./deck/deck.css";

const BrandMark = () => (
  <span className="brand-mark">
    <svg viewBox="0 0 32 32" fill="none">
      <path d="M16 2 3 9v14l13 7 13-7V9L16 2Z" stroke="#16160f" strokeWidth="1.3" />
      <path d="M16 9 9 12.5v7L16 23l7-3.5v-7L16 9Z" fill="none" stroke="#1d3fbf" strokeWidth="1.2" />
      <circle cx="16" cy="16" r="2" fill="#1d3fbf" />
    </svg>
  </span>
);

// Derived from the one shared list, not restated. This page and the console
// draw the same plate, and when the two kept their own copies they drifted —
// a tenant was mislabelled on one of them for weeks.
const PLATE_NODES = TENANTS.map((t) => ({
  ref: t.ref,
  nm: t.name,
  rl: t.role,
  ang: t.angle,
  live: t.status === "live",
}));

function RoutingPlate() {
  const boardRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<{ meta: (typeof PLATE_NODES)[number]; x: number; y: number }[]>([]);
  const [links, setLinks] = useState<{ x1: number; y1: number; x2: number; y2: number }[]>([]);

  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const layout = () => {
      const bw = el.clientWidth;
      const bh = el.clientHeight;
      const cx = bw / 2;
      const cy = bh / 2;
      const R = Math.min(bw, bh) * 0.36;
      const ns = PLATE_NODES.map((meta) => {
        const a = (meta.ang * Math.PI) / 180;
        return { meta, x: cx + Math.cos(a) * R * 1.15, y: cy + Math.sin(a) * R };
      });
      setNodes(ns);
      setLinks(ns.map((n) => ({ x1: cx, y1: cy, x2: n.x, y2: n.y })));
    };
    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="plate">
      <div className="plate-titleblock">
        <span>
          PLATE <b>NEXUS-01</b>
        </span>
        <span>
          REV <b>A</b>
        </span>
        <span>
          SCALE <b>— LIVE</b>
        </span>
        <span>
          NODES <b>{PLATE_NODES.length}</b>
        </span>
      </div>
      <div className="plate-body" ref={boardRef}>
        <svg>
          {links.map((l, i) => (
            <line
              key={i}
              x1={l.x1}
              y1={l.y1}
              x2={l.x2}
              y2={l.y2}
              stroke="rgba(22,22,15,.32)"
              strokeWidth="1"
              strokeDasharray="3 4"
            />
          ))}
        </svg>
        <div className="plate-core">
          <div>
            <b>NEXUS</b>
            <span>Switchboard</span>
          </div>
        </div>
        {nodes.map((n) => (
          <div className="plate-node" key={n.meta.ref} style={{ left: n.x, top: n.y }}>
            <div className="ref">{n.meta.ref}</div>
            <div className="nm">{n.meta.nm}</div>
            <div className="rl">{n.meta.rl}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Landing() {
  const rootRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  // Starts empty. These fields used to be pre-filled with demo credentials,
  // which was harmless while this page sat behind a redirect and unhelpful the
  // moment it became the public front page: it advertised a working-looking
  // password to every visitor, and in production — where NEXUS_OPERATOR_PASSWORD
  // is set — pressing the button with it would simply fail.
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (rootRef.current) return initDeckFx(rootRef.current);
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!/.+@.+\..+/.test(email.trim())) {
      setError("Enter a valid email to continue.");
      return;
    }
    if (password.trim().length < 4) {
      setError("Password must be at least 4 characters.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Staff mode: this form only ever accepts an employee access code.
        // Admins have their own entrance at /admin, and this path never calls
        // the admin verifier — so a bug here cannot mint an admin session.
        body: JSON.stringify({ email: email.trim(), password: password.trim(), mode: "staff" }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? "Sign-in failed. Please try again.");
        setBusy(false);
        return;
      }
      router.refresh();
      router.refresh();
    } catch {
      setError("Network error — please try again.");
      setBusy(false);
    }
  }

  return (
    <div className={`deck-root ${fontVariables}`} ref={rootRef}>
      <canvas className="bg" />
      <div className="grid-overlay" />
      <div className="vignette" />
      <div className="cur-ring" />
      <div className="cur-dot" />

      <nav className="nav">
        <div className="brand">
          <BrandMark />
          <span className="brand-name">
            <b>NEXUS</b> <span>AGENTIC OS</span>
          </span>
        </div>
        <div className="nav-links">
          <a href="#plate">Schematic</a>
          <a href="#stats">Reliability</a>
          <a href="#signin" className="btn ghost" style={{ padding: "9px 16px" }}>
            Sign in
          </a>
        </div>
      </nav>

      <section className="hero" id="plate">
        <div className="hero-copy">
          <div className="eyebrow">Fig. 01 — Switchboard schematic · Live</div>
          <h1>
            One console routes <em>every conversation.</em>
          </h1>
          <div className="hero-sub">
            <p>
              Route, govern, and resolve every WhatsApp conversation across five businesses from a
              single deck — with AI that never leaves a customer in silence.
            </p>
            <div className="cta-row">
              <a href="#signin" className="btn">
                Enter the deck
              </a>
            </div>
          </div>
        </div>

        <RoutingPlate />
      </section>

      <div className="dither" />

      <section className="stat-band" id="stats">
        <div className="stat-band-item">
          <div className="num">05</div>
          <div className="lbl">Independent businesses routed from one Switchboard</div>
        </div>
        <div className="stat-band-item">
          <div className="num">24H</div>
          <div className="lbl">Automatic AI pause the moment a human agent replies</div>
        </div>
        <div className="stat-band-item">
          <div className="num">2/2</div>
          <div className="lbl">Governance checks every AI reply clears — PII scan, hallucination judge</div>
        </div>
      </section>

      <section className="feature-band">
        <div className="feature-inner">
          <div className="eyebrow">What the deck watches</div>
          <h2>Every reply is routed, checked, and logged before it reaches a customer.</h2>
          <div className="feature-grid">
            <div className="feature-card">
              <div className="ref">N-01</div>
              <h3>Switchboard routing</h3>
              <p>
                Five businesses share one WhatsApp number. Each message is classified by what it
                actually asks — in English or Arabic — and when the signal is ambiguous the
                switchboard asks the customer instead of guessing.
              </p>
            </div>
            <div className="feature-card">
              <div className="ref">N-02</div>
              <h3>Governance gate</h3>
              <p>
                Every AI reply is scanned for PII and checked by an independent grounding judge
                before it&rsquo;s allowed to send — the law firm is held to a stricter bar.
              </p>
            </div>
            <div className="feature-card">
              <div className="ref">N-03</div>
              <h3>Never left in silence</h3>
              <p>
                If the AI pipeline fails for any reason, a fallback reply still goes out and the
                conversation is flagged for a human to follow up.
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="dither flip" />

      <section className="signin" id="signin">
        <div className="signin-copy">
          <h2>Built for the operator, not the crowd.</h2>
          <p>
            One operator account per deck. Sign in to watch routing, governance, and resolution
            across every business in real time.
          </p>
          <div className="tenant-list">
            {PLATE_NODES.map((t) => (
              <div className="row" key={t.ref}>
                <span className={t.live ? "dot live" : "dot"} />
                <span className="name">{t.nm}</span>
                <span className="role">{t.rl}</span>
                <span className="state">{t.live ? "live" : "onboarding"}</span>
              </div>
            ))}
          </div>
        </div>

        <form className="auth-card" onSubmit={onSubmit} autoComplete="off">
          <h3>Staff sign-in</h3>
          <div className="sub">nexusagenticos.com</div>

          <div className="field">
            <label htmlFor="email">Email</label>
            <div className="inp">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <path d="m3 7 9 6 9-6" />
              </svg>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your email or staff code"
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="pass">Password</label>
            <div className="inp">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <rect x="4" y="10" width="16" height="10" rx="2" />
                <path d="M8 10V7a4 4 0 0 1 8 0v3" />
              </svg>
              <input
                id="pass"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••"
              />
            </div>
          </div>

          <div className="rowline">
            <label
              onClick={(e) => {
                e.preventDefault();
                setRemember((v) => !v);
              }}
            >
              <span className={`chk${remember ? " on" : ""}`}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <path d="m5 12 5 5L20 6" />
                </svg>
              </span>
              Keep me signed in
            </label>
            <a href="#" onClick={(e) => e.preventDefault()}>
              Forgot?
            </a>
          </div>

          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Initializing…" : "Enter command deck"}
            {!busy && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 12h14m-6-6 6 6-6 6" />
              </svg>
            )}
          </button>
          <div className="errline">{error}</div>

          <div className="divider">Secured session</div>
          <div className="hint">
            Sign in with the access code your manager issued you.{" "}
            <a href="/admin">Administrator sign-in</a> is separate.
          </div>
        </form>
      </section>

      <footer className="site-foot">
        <span>NEXUS AGENTIC OS · nexusagenticos.com</span>
        <span>PLATE NEXUS-01 · REV A</span>
      </footer>
    </div>
  );
}
