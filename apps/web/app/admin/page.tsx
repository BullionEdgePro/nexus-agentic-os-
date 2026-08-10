"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fontVariables } from "@/lib/fonts";
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
        body: JSON.stringify({ email: email.trim(), password, mode: "admin" }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "That email and password don't match.");
        return;
      }
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
      <main className="admin-card">
        <div className="eyebrow">Nexus Agentic OS</div>
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

          <button type="submit" className="btn" disabled={busy || !email.trim() || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </button>

          {error && <p className="admin-error">{error}</p>}
        </form>

        <p className="admin-foot">
          Lost your password? It cannot be recovered — only a hash is stored. Run the
          create-admin script on the server to set a new one.
        </p>
        <a className="admin-back" href="/">
          Staff sign-in
        </a>
      </main>
    </div>
  );
}
