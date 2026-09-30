"use client";

import { useEffect, useState } from "react";
import {
  connectBusinessMailbox,
  disconnectBusinessMailbox,
  getBusinessMailboxes,
  readableError,
  type BusinessMailbox,
} from "@/lib/api";
import { TENANTS } from "@/lib/tenants";

/**
 * A mailbox for each business — every email a person sends it becomes a chat
 * in that business's inbox, and replies go out from it.
 *
 * Connected by the owner, per business, with the address and an APP password.
 * For Gmail that is a Google app password, which doesn't expire every 7 days
 * the way the Google sign-in does while the Google app is in testing mode.
 * The password is checked with the mail server before it is saved; a wrong
 * one is refused here rather than stored as a mailbox that never syncs.
 */
export function BusinessMailboxes() {
  const [boxes, setBoxes] = useState<BusinessMailbox[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = () =>
    getBusinessMailboxes()
      .then((r) => setBoxes(r.mailboxes))
      .catch((err) => setError(readableError(err)));

  useEffect(() => {
    void load();
  }, []);

  async function connect(business: string) {
    setBusy(true);
    setError("");
    try {
      await connectBusinessMailbox({ business, email, password });
      setOpen(null);
      setEmail("");
      setPassword("");
      await load();
    } catch (err) {
      setError(readableError(err, "That mailbox could not be connected."));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(business: string) {
    setBusy(true);
    setError("");
    try {
      await disconnectBusinessMailbox(business);
      await load();
    } catch (err) {
      setError(readableError(err, "That mailbox could not be disconnected."));
    } finally {
      setBusy(false);
    }
  }

  const when = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "not yet";

  return (
    <section className="mb" aria-labelledby="mb-head">
      <h2 className="act-sub-head" id="mb-head">
        Business email
      </h2>
      <p className="mb-lede">
        Connect a mailbox to a business and every email a person sends it appears in that business&apos;s
        inbox, checked every 15 minutes. Newsletters, receipts and no-reply mail are left out. Replies go
        out from the same mailbox.
      </p>
      <div className="mb-list">
        {TENANTS.map((t) => {
          const box = boxes.find((b) => b.business === t.slug);
          const isOpen = open === t.slug;
          const gmail = /@(gmail|googlemail)\.com$/i.test(email);
          return (
            <div className="mb-row" key={t.slug}>
              <div className="mb-biz">{t.name}</div>
              <div className="mb-state">
                {box ? (
                  <>
                    <b>{box.email}</b> · last checked {when(box.lastSyncedAt)}
                    {box.lastError ? (
                      <span className="bad"> · {box.lastError}</span>
                    ) : box.lastSyncedAt ? (
                      <span className="ok"> · working</span>
                    ) : null}
                  </>
                ) : (
                  "No mailbox connected"
                )}
              </div>
              <div>
                {box ? (
                  <button type="button" className="btn small" disabled={busy} onClick={() => void disconnect(t.slug)}>
                    Disconnect
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => {
                      setOpen(isOpen ? null : t.slug);
                      setError("");
                    }}
                  >
                    {isOpen ? "Cancel" : "Connect mailbox"}
                  </button>
                )}
              </div>
              {isOpen ? (
                <form
                  className="mb-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void connect(t.slug);
                  }}
                >
                  <div className="mb-fields">
                    <input
                      id={`mb-email-${t.slug}`}
                      type="email"
                      placeholder="Email address"
                      aria-label="Email address"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoComplete="off"
                    />
                    <input
                      id={`mb-pass-${t.slug}`}
                      type="password"
                      placeholder={gmail ? "Google app password (16 letters)" : "Mailbox password or app password"}
                      aria-label="App password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="new-password"
                    />
                    <button type="submit" className="btn small" disabled={busy || !email || !password}>
                      {busy ? "Checking…" : "Connect"}
                    </button>
                  </div>
                  <p className="mb-help">
                    Gmail: turn on 2-Step Verification for that Google account, then create an app password at{" "}
                    <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">
                      myaccount.google.com/apppasswords
                    </a>{" "}
                    and paste it here. Your normal Gmail password won&apos;t work.
                  </p>
                </form>
              ) : null}
            </div>
          );
        })}
      </div>
      {error ? <p className="mb-err">{error}</p> : null}
    </section>
  );
}
