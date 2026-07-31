"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { initDeckFx } from "@/lib/deck-fx";
import "../deck/deck.css";

const BrandMark = () => (
  <span className="brand-mark">
    <svg viewBox="0 0 32 32" fill="none">
      <path d="M16 2 3 9v14l13 7 13-7V9L16 2Z" stroke="#38e0ff" strokeWidth="1.3" />
      <path d="M16 9 9 12.5v7L16 23l7-3.5v-7L16 9Z" fill="#2f6dff" fillOpacity=".25" stroke="#7fb0ff" strokeWidth="1.1" />
      <circle cx="16" cy="16" r="2.2" fill="#38e0ff" />
    </svg>
  </span>
);

export default function LoginPage() {
  const rootRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const [email, setEmail] = useState("operator@nexusagenticos.com");
  const [password, setPassword] = useState("demo1234");
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
        body: JSON.stringify({ email: email.trim(), password: password.trim() }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? "Sign-in failed. Please try again.");
        setBusy(false);
        return;
      }
      router.push("/deck");
      router.refresh();
    } catch {
      setError("Network error — please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="deck-root" ref={rootRef}>
      <canvas className="bg" />
      <div className="grid-overlay" />
      <div className="vignette" />
      <div className="cur-ring" />
      <div className="cur-dot" />

      <section className="login">
        <div className="login-brandside">
          <div className="brand">
            <BrandMark />
            <span className="brand-name">
              <b>NEXUS</b> <span>AGENTIC OS</span>
            </span>
          </div>

          <div className="login-hero">
            <div className="eyebrow">Multi-tenant WhatsApp agent platform</div>
            <h1>
              One console for your <span className="accent">entire agent swarm</span>
            </h1>
            <p>
              Route, govern, and resolve every WhatsApp conversation across five businesses from a
              single command deck — with AI that never leaves a customer in silence.
            </p>
          </div>

          <div className="trust">
            <div className="eyebrow">Operating live for</div>
            <div className="trust-row">
              <span>Zipicka</span>
              <span>Juris Prime</span>
              <span>Juris Prime Legal</span>
              <span>SFS International</span>
              <span>Atif Ali Production</span>
            </div>
          </div>
        </div>

        <div className="login-formside">
          <form className="login-card glass" onSubmit={onSubmit} autoComplete="off">
            <h2>Sign in to your deck</h2>
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
                  placeholder="you@nexusagenticos.com"
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
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 12h14m-6-6 6 6-6 6" />
                </svg>
              )}
            </button>
            <div className="errline">{error}</div>

            <div className="divider">Secured session</div>
            <div className="hint">
              Demo access is pre-filled — just press <b>Enter command deck</b>.
              <br />
              Set <b>NEXUS_OPERATOR_PASSWORD</b> to change the operator credential.
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
