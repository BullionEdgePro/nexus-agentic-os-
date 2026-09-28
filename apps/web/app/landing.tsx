"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { fontVariables } from "@/lib/fonts";
import { TENANTS } from "@/lib/tenants";
import "./deck/deck.css";
import "./landing.css";

// ============================================================
// The public front page — "Clear Sky".
// ============================================================
//
// Laid out after the team-inbox platforms the owner measures Nexus against
// (DoubleTick): an editorial serif headline over mono spec labels, a product
// that is SHOWN working rather than described, a tabbed tour of what it does,
// and the sign-in at the foot. Everything claimed here is something the
// platform does today; nothing is a roadmap item wearing present tense.
//
// Motion is the product demonstrating itself: messages arriving in the mock
// inbox, a pulse travelling the switchboard, circuit traces carrying signal.
// All of it stops under prefers-reduced-motion.

const BrandMark = () => (
  <span className="lp-mark" aria-hidden="true">
    <svg viewBox="0 0 32 32" fill="none">
      <path d="M16 2 3 9v14l13 7 13-7V9L16 2Z" stroke="currentColor" strokeWidth="1.6" />
      <path d="M16 9 9 12.5v7L16 23l7-3.5v-7L16 9Z" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="16" cy="16" r="2.2" fill="currentColor" />
    </svg>
  </span>
);

// Derived from the one shared list, not restated — this page and the console
// draw the same five businesses, and copies drift.
const PLATE_NODES = TENANTS.map((t) => ({
  ref: t.ref,
  nm: t.name,
  rl: t.role,
  ang: t.angle,
  live: t.status === "live",
}));

type TourKey = "manage" | "reach" | "automate" | "analyse" | "govern";

const TOUR: { key: TourKey; label: string; kicker: string; title: string; points: string[] }[] = [
  {
    key: "manage",
    label: "Manage",
    kicker: "Manage conversations",
    title: "A shared team inbox for every chat, across every business",
    points: [
      "Folders that answer one question each — My chats, Unread, Awaiting reply, SLA breached",
      "Assign, collaborate, label and resolve; a customer writing again reopens the thread",
      "Every handover, call and note on one timeline beside the messages",
    ],
  },
  {
    key: "reach",
    label: "Reach",
    kicker: "Reach customers",
    title: "Links, QR codes and campaigns that start the conversation",
    points: [
      "A click-to-chat link and QR code for every business and every salesperson",
      "Campaigns to your own clients from the business number, with a monthly allowance",
      "Scheduled messages that go out when the customer is awake",
    ],
  },
  {
    key: "automate",
    label: "Automate",
    kicker: "Automate the busywork",
    title: "An AI agent that answers in seconds and knows when to stop",
    points: [
      "Five businesses share one number — each enquiry is routed to the right one",
      "Replies grounded in each business's own knowledge, in English or Arabic",
      "The moment a person replies, the AI pauses for 24 hours on that chat",
    ],
  },
  {
    key: "analyse",
    label: "Analyse",
    kicker: "Understand what customers say",
    title: "Every conversation read, scored and turned into a pipeline",
    points: [
      "Intent and lead score on every thread, and a stage your team moves by hand",
      "Reply-time targets per business, with the breaches counted, not guessed",
      "A forecast that says so when there is not enough data to forecast",
    ],
  },
  {
    key: "govern",
    label: "Govern",
    kicker: "Stay in control",
    title: "Nothing reaches a customer that has not been checked",
    points: [
      "Every AI reply is scanned for personal data and checked by a grounding judge",
      "The law firm is held to a stricter bar than the shop",
      "Each business's data is isolated at the database, not just hidden on screen",
    ],
  },
];

/** Numbers that count up once, when they first scroll into view. */
function CountUp({ to, suffix = "", pad = 0 }: { to: number; suffix?: string; pad?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [n, setN] = useState(to);
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setN(0);
    let raf = 0;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        const start = performance.now();
        const tick = (t: number) => {
          const p = Math.min(1, (t - start) / 1100);
          setN(Math.round(to * (1 - Math.pow(1 - p, 3))));
          if (p < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      },
      { threshold: 0.4 }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [to]);
  return (
    <span ref={ref}>
      {String(n).padStart(pad, "0")}
      {suffix}
    </span>
  );
}

/** Circuit traces flanking the hero, with signal pulses running along them. */
function Circuit({ side }: { side: "left" | "right" }) {
  const paths = [
    "M0 40 H70 L100 70 V160 L130 190 H190",
    "M0 90 H40 L70 120 V260 L100 290 H170",
    "M0 150 H24 L54 180 V330 L84 360 H210",
    "M0 210 H60 L90 240 V300",
    "M0 280 H30 L60 310 V420 L90 450 H150",
    "M0 360 H80 L110 390 V470",
  ];
  return (
    <svg className={`lp-circuit ${side}`} viewBox="0 0 220 500" aria-hidden="true">
      {paths.map((d, i) => (
        <g key={i}>
          <path d={d} className="lp-trace" />
          <path d={d} className="lp-pulse" style={{ animationDelay: `${i * 0.9}s` }} />
        </g>
      ))}
      {[
        [190, 190],
        [170, 290],
        [210, 360],
        [90, 300],
        [150, 450],
        [110, 470],
      ].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="3.2" className="lp-node" style={{ animationDelay: `${i * 0.6}s` }} />
      ))}
    </svg>
  );
}

/** The product, working: a small inbox where a conversation plays out. */
function HeroInbox() {
  return (
    <div className="lp-app" aria-hidden="true">
      <div className="lp-app-bar">
        <span className="lp-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="lp-app-url">app.nexusagenticos.com/inbox</span>
        <span className="lp-app-live">
          <b /> Live
        </span>
      </div>
      <div className="lp-app-stages">
        <span className="on">All</span>
        <span>
          New <em>12</em>
        </span>
        <span>
          Qualified <em>7</em>
        </span>
        <span>
          Won <em>4</em>
        </span>
      </div>
      <div className="lp-app-body">
        <div className="lp-app-list">
          {[
            ["S", "Sara Al Mansoori", "Is the vanity set in stock?", "t1", 2],
            ["R", "Rahul Menon", "Need an attestation quote", "t2", 0],
            ["A", "Aisha K.", "Viewing on Saturday?", "t3", 1],
            ["M", "Mohammed", "Thank you 🙏", "t4", 0],
          ].map(([i, name, msg, tint, n], idx) => (
            <div key={name as string} className={`lp-row${idx === 0 ? " on" : ""}`}>
              <span className={`lp-av ${tint}`}>{i}</span>
              <span className="lp-row-text">
                <b>{name}</b>
                <small>{msg}</small>
              </span>
              {n ? <span className="lp-badge">{n}</span> : null}
            </div>
          ))}
        </div>
        <div className="lp-app-thread">
          <div className="lp-msg in m1">Hi! Is the rose-gold vanity set still in stock? 😊</div>
          <div className="lp-msg out ai m2">
            <span className="lp-tag">✦ AI agent</span>
            Yes — 3 left in Dubai. Want me to reserve one for you?
          </div>
          <div className="lp-msg in m3">Yes please, delivery to Marina</div>
          <div className="lp-typing m4">
            <i />
            <i />
            <i />
          </div>
          <div className="lp-msg out m5">
            <span className="lp-tag human">Aisha · Sales</span>
            Reserved ✅ Delivery tomorrow before 6 pm.
            <span className="lp-ticks">✓✓</span>
          </div>
          <div className="lp-event m6">✓ Resolved by Aisha · 2 min</div>
        </div>
      </div>
    </div>
  );
}

/** The five businesses on one number, with signal travelling each live link. */
function RoutingPlate() {
  const boardRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<{ meta: (typeof PLATE_NODES)[number]; x: number; y: number }[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const layout = () => {
      const bw = el.clientWidth;
      const bh = el.clientHeight;
      const cx = bw / 2;
      const cy = bh / 2;
      const R = Math.min(bw, bh) * 0.36;
      setSize({ w: bw, h: bh });
      setNodes(
        PLATE_NODES.map((meta) => {
          const a = (meta.ang * Math.PI) / 180;
          return { meta, x: cx + Math.cos(a) * R * 1.2, y: cy + Math.sin(a) * R };
        })
      );
    };
    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="lp-plate" ref={boardRef}>
      <svg className="lp-plate-svg" width={size.w} height={size.h} aria-hidden="true">
        <defs>
          <radialGradient id="lp-core-glow">
            <stop offset="0" stopColor="var(--sky)" stopOpacity=".35" />
            <stop offset="1" stopColor="var(--sky)" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx={size.w / 2} cy={size.h / 2} r={Math.min(size.w, size.h) * 0.3} fill="url(#lp-core-glow)" />
        <circle
          cx={size.w / 2}
          cy={size.h / 2}
          r={Math.min(size.w, size.h) * 0.36}
          className="lp-orbit"
        />
        {nodes.map((n, i) => (
          <g key={n.meta.ref}>
            <line x1={size.w / 2} y1={size.h / 2} x2={n.x} y2={n.y} className="lp-link" />
            {n.meta.live ? (
              <line
                x1={size.w / 2}
                y1={size.h / 2}
                x2={n.x}
                y2={n.y}
                className="lp-link-pulse"
                style={{ animationDelay: `${i * 0.7}s` }}
              />
            ) : null}
          </g>
        ))}
      </svg>
      <div className="lp-core">
        <b>NEXUS</b>
        <span>Switchboard</span>
      </div>
      {nodes.map((n) => (
        <div className="lp-node-card" key={n.meta.ref} style={{ left: n.x, top: n.y }}>
          <span className="ref">{n.meta.ref}</span>
          <span className="nm">{n.meta.nm}</span>
          <span className="rl">{n.meta.rl}</span>
        </div>
      ))}
    </div>
  );
}

/** A small moving illustration for each tour tab. */
function TourArt({ which }: { which: TourKey }) {
  switch (which) {
    case "manage":
      return (
        <div className="lp-art lp-art-manage" aria-hidden="true">
          {["My chats", "Unread", "Awaiting reply", "SLA breached"].map((f, i) => (
            <div key={f} className={`lp-folder${i === 2 ? " on" : ""}`} style={{ animationDelay: `${i * 0.12}s` }}>
              <span>{f}</span>
              <em>{[4, 2, 7, 1][i]}</em>
            </div>
          ))}
          <div className="lp-assign">
            <span className="lp-av t2">R</span> Assigned to <b>Rahul</b>
          </div>
        </div>
      );
    case "reach":
      return (
        <div className="lp-art lp-art-reach" aria-hidden="true">
          <div className="lp-qr">
            {Array.from({ length: 49 }, (_, i) => (
              <i key={i} className={(i * 7 + (i % 5) * 3) % 3 === 0 || [0, 1, 7, 8, 5, 6, 12, 13, 35, 36, 42, 43].includes(i) ? "on" : ""} />
            ))}
          </div>
          <div className="lp-link-pill">wa.me/971504805436 → Zipicka</div>
          <div className="lp-send-burst">
            <span />
            <span />
            <span />
          </div>
        </div>
      );
    case "automate":
      return (
        <div className="lp-art lp-art-automate" aria-hidden="true">
          <div className="lp-flow">
            <span className="lp-step">Message in</span>
            <span className="lp-arrow" />
            <span className="lp-step hot">Routed</span>
            <span className="lp-arrow" />
            <span className="lp-step">AI replies</span>
          </div>
          <div className="lp-msg out ai static">
            <span className="lp-tag">✦ AI agent</span>
            مرحباً! Your apostille is ready for pickup tomorrow.
          </div>
        </div>
      );
    case "analyse":
      return (
        <div className="lp-art lp-art-analyse" aria-hidden="true">
          <div className="lp-bars">
            {[38, 62, 45, 80, 56, 92, 70].map((h, i) => (
              <i key={i} style={{ height: `${h}%`, animationDelay: `${i * 0.08}s` }} />
            ))}
          </div>
          <div className="lp-score">
            Lead score <b>86</b> · <span>High intent</span>
          </div>
        </div>
      );
    case "govern":
      return (
        <div className="lp-art lp-art-govern" aria-hidden="true">
          <div className="lp-shield">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" />
              <path d="m8.5 12 2.5 2.5 4.5-5" />
            </svg>
          </div>
          <ul className="lp-checks">
            <li>PII scan passed</li>
            <li>Grounded in knowledge base</li>
            <li>Business policy: strict</li>
          </ul>
        </div>
      );
  }
}

export default function Landing() {
  const router = useRouter();
  // Starts empty. These fields used to be pre-filled with demo credentials,
  // which was harmless while this page sat behind a redirect and unhelpful the
  // moment it became the public front page: it advertised a working-looking
  // password to every visitor, and in production — where NEXUS_OPERATOR_PASSWORD
  // is set — pressing the button with it would simply fail.
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showCode, setShowCode] = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // The tour turns its own pages until somebody takes over — hovering, focusing
  // or choosing a tab stops it, and reduced motion never starts it.
  const [tour, setTour] = useState<TourKey>("manage");
  const [tourHeld, setTourHeld] = useState(false);
  useEffect(() => {
    if (tourHeld || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => {
      setTour((cur) => TOUR[(TOUR.findIndex((x) => x.key === cur) + 1) % TOUR.length].key);
    }, 6500);
    return () => clearInterval(t);
  }, [tourHeld]);
  const active = TOUR.find((t) => t.key === tour) ?? TOUR[0];

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!/.+@.+\..+/.test(email.trim())) {
      setError("Enter a valid email to continue.");
      return;
    }
    if (password.trim().length < 4) {
      setError("That access code looks too short — check the one your manager sent you.");
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

  const marquee = ["WhatsApp", "Instagram DMs", "Facebook Messenger", "Email", "Call log", ...TENANTS.map((t) => t.name)];

  return (
    <div className={`deck-root lp ${fontVariables}`}>
      <div className="lp-sky" aria-hidden="true">
        <span className="lp-bloom b1" />
        <span className="lp-bloom b2" />
        <span className="lp-bloom b3" />
      </div>

      <nav className="lp-nav">
        <a className="lp-brand" href="/">
          <BrandMark />
          <span>
            Nexus <small>Agentic OS</small>
          </span>
        </a>
        <div className="lp-nav-links">
          <a href="#tour">Product</a>
          <a href="#switchboard">Switchboard</a>
          <a href="#journey">How it works</a>
          <a href="/links">Customer links</a>
        </div>
        <div className="lp-nav-cta">
          <a href="/admin" className="lp-link-quiet">
            Admin
          </a>
          <a href="#signin" className="btn">
            Sign in
          </a>
        </div>
      </nav>

      <header className="lp-hero">
        <Circuit side="left" />
        <Circuit side="right" />
        <div className="lp-hero-copy">
          <span className="lp-pill">
            <b /> Built on the official WhatsApp Business Platform
          </span>
          <h1>
            The agentic inbox for <em>every</em> WhatsApp conversation
          </h1>
          <p>
            One console for every number, every business and every customer — an AI agent that
            answers in seconds, and a team inbox that never lets anyone wait unseen.
          </p>
          <div className="lp-cta">
            <a href="#signin" className="btn">
              Enter the console
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M5 12h14m-6-6 6 6-6 6" />
              </svg>
            </a>
            <a href="#tour" className="btn ghost">
              See it work
            </a>
          </div>
        </div>
        <div className="lp-hero-visual">
          <HeroInbox />
          <div className="lp-float f1">
            <b>⏸ AI steps back</b>
            <span>the moment you reply</span>
          </div>
          <div className="lp-float f2">
            <b>✓ PII scan</b>
            <span>every AI reply</span>
          </div>
        </div>
      </header>

      <section className="lp-marquee" aria-label="Channels and businesses">
        <span className="lp-marquee-k">One console for</span>
        <div className="lp-marquee-track">
          <div className="lp-marquee-run">
            {[...marquee, ...marquee].map((m, i) => (
              <span key={i} className="lp-chip">
                {m}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-problems">
        <div className="lp-section-head">
          <span className="lp-kicker">Why teams outgrow a phone</span>
          <h2>WhatsApp on a phone is a black box</h2>
        </div>
        <div className="lp-problem-grid">
          {[
            ["One number, a whole team", "Chats live on one handset, so nobody else can see them or help."],
            ["Customers wait unseen", "Nothing says who has been waiting, or for how long."],
            ["Leads never reach the CRM", "What was promised in a chat is lost when the chat scrolls away."],
            ["No control over what is said", "No review, no record, no way to stop a wrong answer going out."],
          ].map(([h, p], i) => (
            <article key={h} className="lp-problem" style={{ animationDelay: `${i * 0.08}s` }}>
              <span className="lp-problem-n">{String(i + 1).padStart(2, "0")}</span>
              <h3>{h}</h3>
              <p>{p}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="lp-tour" id="tour" onMouseEnter={() => setTourHeld(true)} onFocus={() => setTourHeld(true)}>
        <div className="lp-tabs" role="tablist" aria-label="What Nexus does">
          {TOUR.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tour === t.key}
              className={`lp-tab${tour === t.key ? " on" : ""}${tourHeld ? " held" : ""}`}
              onClick={() => {
                setTour(t.key);
                setTourHeld(true);
              }}
            >
              {t.label}
              <span className="lp-tab-bar" />
            </button>
          ))}
        </div>
        <div className="lp-tour-body" key={active.key}>
          <div className="lp-tour-copy">
            <span className="lp-kicker">{active.kicker}</span>
            <h2>{active.title}</h2>
            <ul>
              {active.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
          <TourArt which={active.key} />
        </div>
      </section>

      <section className="lp-switch" id="switchboard">
        <div className="lp-section-head">
          <span className="lp-kicker">The switchboard</span>
          <h2>Five businesses. One number. Every enquiry to the right desk.</h2>
          <p>
            Each message is classified by what it actually asks — in English or Arabic — and when the
            signal is ambiguous, the switchboard asks the customer instead of guessing.
          </p>
        </div>
        <RoutingPlate />
      </section>

      <section className="lp-stats">
        <div className="lp-stat">
          <b>
            <CountUp to={PLATE_NODES.length} pad={2} />
          </b>
          <span>Businesses routed from one WhatsApp number</span>
        </div>
        <div className="lp-stat">
          <b>
            <CountUp to={24} suffix="h" />
          </b>
          <span>AI pause the moment a human agent replies</span>
        </div>
        <div className="lp-stat">
          <b>
            <CountUp to={2} />
            /2
          </b>
          <span>Checks every AI reply clears — PII scan and grounding judge</span>
        </div>
        <div className="lp-stat">
          <b>
            <CountUp to={4} />
          </b>
          <span>Channels in one inbox — WhatsApp, Instagram, Messenger, email</span>
        </div>
      </section>

      <section className="lp-journey" id="journey">
        <div className="lp-section-head">
          <span className="lp-kicker">How a message travels</span>
          <h2>From the customer&apos;s phone to a resolved conversation</h2>
        </div>
        <ol className="lp-steps">
          {[
            ["Arrives", "On WhatsApp, Instagram, Messenger or email — into one inbox."],
            ["Routed", "The switchboard works out which business it is for."],
            ["Answered", "The AI replies from that business's knowledge, after two checks."],
            ["Handed over", "A person takes it the moment it needs one — and the AI steps back."],
          ].map(([h, p], i) => (
            <li key={h} className="lp-step-card" style={{ animationDelay: `${i * 0.1}s` }}>
              <span className="lp-step-n">{i + 1}</span>
              <h3>{h}</h3>
              <p>{p}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="lp-signin" id="signin">
        <div className="lp-signin-copy">
          <span className="lp-kicker">For the team</span>
          <h2>Your inbox is waiting.</h2>
          <p>
            Staff sign in with the access code their manager issued. Every business below answers
            through Nexus today.
          </p>
          <div className="lp-tenants">
            {PLATE_NODES.map((t) => (
              <div className="lp-tenant" key={t.ref}>
                <span className={t.live ? "lp-dot live" : "lp-dot"} />
                <b>{t.nm}</b>
                <span>{t.rl}</span>
                <em>{t.live ? "live" : "onboarding"}</em>
              </div>
            ))}
          </div>
        </div>

        <form className="lp-auth" onSubmit={onSubmit} autoComplete="off">
          <h3>Staff sign-in</h3>
          <p className="lp-auth-sub">nexusagenticos.com</p>

          <label className="lp-field" htmlFor="email">
            <span>Email</span>
            <span className="lp-inp">
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
            </span>
          </label>

          {/*
            THE LABEL SAID "PASSWORD" WHILE THE HELP TEXT DIRECTLY BENEATH IT
            SAID "sign in with the access code your manager issued you".

            Staff do not have passwords. They are issued a one-time access code
            (create-employee.ts), stored only as a hash. A field labelled
            "Password" invites somebody to type a password they were never
            given, fail, and ask for a reset that does not exist.

            `type="password"` stays — that is about masking the characters, not
            about what the credential is called.
          */}
          <label className="lp-field" htmlFor="pass">
            <span>Access code</span>
            <span className="lp-inp">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <rect x="4" y="10" width="16" height="10" rx="2" />
                <path d="M8 10V7a4 4 0 0 1 8 0v3" />
              </svg>
              <input
                id="pass"
                type={showCode ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="XXXXX-XXXXX"
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
              />
              {/*
                An access code is transcribed from a message, not remembered —
                revealing it is the difference between a two-second fix and a
                support conversation. type="button" is load-bearing: a bare
                <button> inside a form would submit the half-typed code.
              */}
              <button
                type="button"
                className="lp-reveal"
                onClick={() => setShowCode((v) => !v)}
                aria-label={showCode ? "Hide access code" : "Show access code"}
                aria-pressed={showCode}
                title={showCode ? "Hide" : "Show"}
              >
                {showCode ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                    <path d="M3 3l18 18" />
                    <path d="M10.6 5.1A9 9 0 0 1 21 12a17 17 0 0 1-3.1 3.9M6.6 6.6A17 17 0 0 0 3 12a9 9 0 0 0 12.5 4.4" />
                    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </span>
          </label>

          <button
            type="button"
            className={`lp-remember${remember ? " on" : ""}`}
            aria-pressed={remember}
            onClick={() => setRemember((v) => !v)}
          >
            <span className="lp-chk">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <path d="m5 12 5 5L20 6" />
              </svg>
            </span>
            Keep me signed in
          </button>

          <button className="btn lp-submit" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Open my inbox"}
            {!busy && (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M5 12h14m-6-6 6 6-6 6" />
              </svg>
            )}
          </button>
          <p className="lp-err" role="alert">
            {error}
          </p>

          <p className="lp-auth-hint">
            Sign in with the access code your manager issued you.{" "}
            <a href="/admin">Administrator sign-in</a> is separate.
          </p>
        </form>
      </section>

      <footer className="lp-foot">
        <span className="lp-brand small">
          <BrandMark /> Nexus Agentic OS
        </span>
        {/* /links was an unlisted URL — findable only by whoever still had it in
            a message. The people it is for are outside the team, so the address
            has to exist somewhere they can reach without asking. */}
        <a href="/links">Customer links &amp; QR codes</a>
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
        <span className="lp-foot-meta">nexusagenticos.com</span>
      </footer>
    </div>
  );
}
