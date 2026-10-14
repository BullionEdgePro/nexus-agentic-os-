"use client";

import { useEffect, useRef, useState } from "react";
import {
  unlockHqVault,
  lockHqVault,
  revealHqSecret,
  saveHqVaultEntry,
  deleteHqVaultEntry,
  readableError,
  type HqVaultEntry,
} from "@/lib/api";

/**
 * The vault (spec 2026-10-14-business-hq-design.md §5).
 *
 * Passwords are dots until revealed. Unlocking asks for YOUR admin password and
 * opens a 5-minute window on the server; Reveal and Copy each fetch one password,
 * which the server logs, and a revealed password hides itself after 30 seconds.
 * The page never stores a password anywhere: not in state after it hides, not in
 * localStorage, not in the URL.
 */
const HIDE_AFTER_MS = 30_000;

/** Only http(s) links are ever rendered as links: a stored javascript: URL stays text. */
const isHttpLink = (url: string | null): url is string => !!url && /^https?:\/\//i.test(url.trim());

const daysAgo = (iso: string | null, now: Date) => (iso ? Math.round((now.getTime() - new Date(iso).getTime()) / 86_400_000) : null);

type Draft = { id?: string; section: HqVaultEntry["section"]; service: string; label: string; username: string; url: string; notes: string; secret: string };
const emptyDraft = (section: HqVaultEntry["section"]): Draft => ({ section, service: "", label: "", username: "", url: "", notes: "", secret: "" });

export function VaultPanel({
  slug,
  entries,
  configured,
  unlockedSeconds,
  section,
  now = new Date(),
  onChanged,
}: {
  slug: string;
  entries: HqVaultEntry[];
  configured: boolean;
  unlockedSeconds: number;
  /** Show only one section's logins (the Website and Social tabs); all when absent. */
  section?: HqVaultEntry["section"];
  now?: Date;
  onChanged: () => void;
}) {
  const [secondsLeft, setSecondsLeft] = useState(unlockedSeconds);
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [shown, setShown] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const timers = useRef<number[]>([]);

  useEffect(() => setSecondsLeft(unlockedSeconds), [unlockedSeconds]);
  useEffect(() => {
    if (secondsLeft <= 0) return;
    const tick = window.setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearInterval(tick);
  }, [secondsLeft > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((t) => window.clearTimeout(t));
  }, []);

  const unlocked = secondsLeft > 0;
  const list = section ? entries.filter((e) => e.section === section) : entries;

  const lockedOut = (err: unknown) => {
    const text = readableError(err);
    if (/Unlock again/.test(text)) setSecondsLeft(0);
    setMessage(text);
  };

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    setMessage("");
    try {
      const r = await unlockHqVault(password);
      setSecondsLeft(r.expiresInSeconds);
      setAsking(false);
    } catch (err) {
      setMessage(readableError(err));
    } finally {
      setPassword("");
    }
  }

  async function lock() {
    await lockHqVault().catch(() => undefined);
    setSecondsLeft(0);
    setShown({});
  }

  async function reveal(entry: HqVaultEntry) {
    setMessage("");
    try {
      const { secret } = await revealHqSecret(slug, entry.id);
      setShown((s) => ({ ...s, [entry.id]: secret }));
      timers.current.push(
        window.setTimeout(() => setShown((s) => {
          const next = { ...s };
          delete next[entry.id];
          return next;
        }), HIDE_AFTER_MS)
      );
    } catch (err) {
      lockedOut(err);
    }
  }

  async function copy(entry: HqVaultEntry) {
    setMessage("");
    try {
      const { secret } = await revealHqSecret(slug, entry.id);
      await navigator.clipboard.writeText(secret);
      setMessage(`${entry.service} password copied. Paste it where you need it.`);
    } catch (err) {
      lockedOut(err);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setMessage("");
    try {
      await saveHqVaultEntry(slug, {
        id: draft.id,
        section: draft.section,
        service: draft.service,
        label: draft.label || null,
        username: draft.username || null,
        url: draft.url || null,
        notes: draft.notes || null,
        ...(draft.secret ? { secret: draft.secret } : {}),
      });
      setDraft(null);
      onChanged();
    } catch (err) {
      lockedOut(err);
    }
  }

  async function remove(entry: HqVaultEntry) {
    if (!window.confirm(`Delete the ${entry.service} login? The access log keeps its history.`)) return;
    try {
      await deleteHqVaultEntry(slug, entry.id);
      onChanged();
    } catch (err) {
      setMessage(readableError(err));
    }
  }

  if (!configured) {
    return <p className="hq-vault-off">The vault key is not set on the server. Logins can be listed, but no password can be saved or shown until it is.</p>;
  }

  return (
    <section className="hq-vault">
      <div className={`hq-vault-bar ${unlocked ? "open" : "shut"}`}>
        {unlocked ? (
          <>
            <span className="hq-lock-state">Unlocked · locks in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}</span>
            <button type="button" className="btn ghost" onClick={lock}>Lock now</button>
          </>
        ) : asking ? (
          <form className="hq-unlock" onSubmit={unlock}>
            <label htmlFor={`hq-unlock-${section ?? "all"}`}>Your admin password</label>
            <input id={`hq-unlock-${section ?? "all"}`} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            <button type="submit" className="btn">Unlock for 5 minutes</button>
            <button type="button" className="btn ghost" onClick={() => setAsking(false)}>Cancel</button>
          </form>
        ) : (
          <>
            <span className="hq-lock-state">Locked · passwords are hidden</span>
            <button type="button" className="btn" onClick={() => setAsking(true)}>Unlock</button>
          </>
        )}
      </div>
      {message ? <p className="hq-vault-msg" role="status">{message}</p> : null}

      {list.length === 0 ? (
        <p className="hq-empty">No logins saved{section ? " for this part yet" : " yet"}.</p>
      ) : (
        <ul className="hq-vault-list">
          {list.map((entry) => {
            const age = daysAgo(entry.secretChangedAt, now);
            return (
              <li key={entry.id} className="hq-vault-row">
                <div className="hq-vault-main">
                  <strong>{entry.service}</strong>
                  {entry.label ? <span className="hq-muted"> · {entry.label}</span> : null}
                  <div className="hq-vault-fields">
                    {entry.username ? <span>User <code>{entry.username}</code></span> : null}
                    <span>
                      Password <code className="hq-secret">{shown[entry.id] ?? (entry.hasSecret ? "••••••••" : "none saved")}</code>
                    </span>
                    {isHttpLink(entry.url) ? <a href={entry.url} target="_blank" rel="noreferrer noopener">Open site ↗</a> : entry.url ? <span>{entry.url}</span> : null}
                  </div>
                  {entry.hasSecret && age !== null ? (
                    <span className={`hq-chip ${age > 180 ? "stale" : "fresh"}`}>changed {age} days ago</span>
                  ) : null}
                  {entry.notes ? <p className="hq-muted hq-note">{entry.notes}</p> : null}
                </div>
                <div className="hq-vault-actions">
                  {entry.hasSecret ? (
                    <>
                      <button type="button" className="btn ghost" disabled={!unlocked} onClick={() => reveal(entry)}>
                        {shown[entry.id] ? "Shown 30s" : "Reveal"}
                      </button>
                      <button type="button" className="btn ghost" disabled={!unlocked} onClick={() => copy(entry)}>Copy</button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => setDraft({ id: entry.id, section: entry.section, service: entry.service, label: entry.label ?? "", username: entry.username ?? "", url: entry.url ?? "", notes: entry.notes ?? "", secret: "" })}
                  >
                    Edit
                  </button>
                  <button type="button" className="btn ghost danger" onClick={() => remove(entry)}>Delete</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {draft ? (
        <form className="hq-form" onSubmit={save}>
          <h4>{draft.id ? `Edit ${draft.service}` : "Add a login"}</h4>
          <div className="hq-form-grid">
            <label>Section
              <select value={draft.section} onChange={(e) => setDraft({ ...draft, section: e.target.value as Draft["section"] })}>
                <option value="website">Website / hosting</option>
                <option value="social">Social media</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label>Service<input required value={draft.service} onChange={(e) => setDraft({ ...draft, service: e.target.value })} placeholder="Hostinger, Instagram…" /></label>
            <label>Label<input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="hPanel, admin…" /></label>
            <label>Username / email<input value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} autoComplete="off" /></label>
            <label>Login page<input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://…" /></label>
            <label>
              {draft.id ? "New password (leave empty to keep)" : "Password"}
              <input type="password" value={draft.secret} onChange={(e) => setDraft({ ...draft, secret: e.target.value })} autoComplete="new-password" disabled={!unlocked} placeholder={unlocked ? "" : "Unlock to set a password"} />
            </label>
            <label className="wide">Notes<textarea rows={2} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Recovery email, 2FA phone, who else has access…" /></label>
          </div>
          <div className="hq-form-actions">
            <button type="submit" className="btn">Save</button>
            <button type="button" className="btn ghost" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </form>
      ) : (
        <button type="button" className="btn ghost hq-add" onClick={() => setDraft(emptyDraft(section ?? "website"))}>+ Add a login</button>
      )}
    </section>
  );
}
