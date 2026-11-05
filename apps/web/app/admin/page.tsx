"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fontVariables } from "@/lib/fonts";
import { PUBLIC_THEME_BOOT, forgetSystemTheme } from "@/lib/theme";
import { ThemeToggle } from "../theme-toggle";
import "../deck/deck.css";
import "./admin.css";

/**
 * The admin entrance.
 *
 * Deliberately its own page rather than a second mode on the public form. An
 * admin session sees every tenant's customer conversations; an employee session
 * sees one business. Those are different enough that the two credentials should
 * not share a form, a submit handler, or a failure message — and the staff path
 * never calls the admin verifier, so a bug there cannot mint an admin session.
 *
 * No marketing, no tenant plate, no product pitch. This is a back door for the
 * people who run the platform, and it should look like one.
 */
export default function AdminSignIn() {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Kept for 30 days on this device and renewed while used (5 Nov 2026), as on
  // the staff sign-in. Off for a shared computer.
  const [remember, setRemember] = useState(true);

  useEffect(() => {
    document.title = "Admin sign-in · Nexus Agentic OS";
  }, []);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password, mode: "admin", remember }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "That email and password don't match.");
        return;
      }
      forgetSystemTheme();
      router.push("/");
      router.refresh();
    } catch {
      setError("Could not reach the platform. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`deck-root admin-root ${fontVariables}`} ref={rootRef}>
      <script dangerouslySetInnerHTML={{ __html: PUBLIC_THEME_BOOT }} />
      {/* Two parts (spec 2026-11-02-storefront-cream-design.md §3): a panel in
          the console dock's near-black, three of its glass tiles a quiet nod to
          what is inside, beside the paper card that does the work. The panel is
          decoration — the card's h1 stays the page's heading. */}
      <div className="admin-shell">
        <aside className="admin-side" aria-hidden="true">
          <span className="admin-mark">
            <svg viewBox="0 0 32 32" fill="none">
              <path d="M16 2 3 9v14l13 7 13-7V9L16 2Z" stroke="currentColor" strokeWidth="1.6" />
              <path d="M16 9 9 12.5v7L16 23l7-3.5v-7L16 9Z" stroke="currentColor" strokeWidth="1.4" />
              <circle cx="16" cy="16" r="2.2" fill="currentColor" />
            </svg>
          </span>
          <p className="admin-side-title">Administrator sign-in</p>
          <div className="admin-tiles">
            <span className="admin-tile mustard">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 13h4l2 3h4l2-3h4M5 6h14l1 7v5H4v-5l1-7Z" />
              </svg>
            </span>
            <span className="admin-tile forest">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="9" cy="8" r="3" />
                <path d="M3 19c.6-3 3-5 6-5s5.4 2 6 5M16 5a3 3 0 0 1 0 6M18 14c1.6.6 2.7 2.4 3 5" />
              </svg>
            </span>
            <span className="admin-tile terra">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
              </svg>
            </span>
          </div>
        </aside>
        <main className="admin-card">
          <div className="admin-card-top">
            <div className="eyebrow">Nexus Agentic OS</div>
            <ThemeToggle compact />
          </div>
          <h1>Administrator sign-in</h1>
          <p className="admin-note">
            Full access to every business on the platform. Staff sign in on the main page with the
            access code issued to them.
          </p>
  
          <form onSubmit={onSubmit} autoComplete="off">
            <label htmlFor="admin-email">Email</label>
            <input
              id="admin-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="username"
              required
            />
  
            <label htmlFor="admin-password">Password</label>
            <input
              id="admin-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              autoComplete="current-password"
              required
            />

            <label className="admin-remember">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Keep me signed in
            </label>

            <button type="submit" className="btn" disabled={busy || !email.trim() || !password}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
  
            {error && <p className="admin-error">{error}</p>}
          </form>
  
          <p className="admin-foot">
            Lost your password? It cannot be recovered — only a hash is stored. Run the
            create-admin script on the server to set a new one.
          </p>
          {/* To the team's form itself: the top of "/" is now the sales page. */}
          <a className="admin-back" href="/#signin">
            Staff sign-in
          </a>
        </main>
      </div>
    </div>
  );
}
