"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getMe,
  updateMe,
  getMySocialAccounts,
  saveMySocialAccounts,
  readableError,
  type Me,
  type SocialAccount,
} from "@/lib/api";
import { fontVariables } from "@/lib/fonts";
import "../deck.css";
import "../activity/activity.css";
import "./my-settings.css";

/**
 * Your settings — the one place a staff member changes their own details.
 *
 * Everything here is about YOU: how you appear, the number customers reach you
 * on, and the socials your referral link points to. It writes only your own row
 * (via /api/me and /api/my/social-accounts, both self-scoped on the server), so
 * there is nothing here that can touch a colleague's account.
 *
 * What is deliberately NOT here: your sign-in email and code (changing them
 * would lock you out — an owner reissues those), and connecting Gmail or a
 * WhatsApp Business number, which is its own step under My clients → Connections.
 */

const PLATFORMS: { value: string; label: string; glyph: string }[] = [
  { value: "instagram", label: "Instagram", glyph: "📷" },
  { value: "facebook", label: "Facebook", glyph: "👍" },
  { value: "tiktok", label: "TikTok", glyph: "🎵" },
  { value: "linkedin", label: "LinkedIn", glyph: "in" },
  { value: "youtube", label: "YouTube", glyph: "▶" },
  { value: "x", label: "X (Twitter)", glyph: "𝕏" },
  { value: "snapchat", label: "Snapchat", glyph: "👻" },
  { value: "whatsapp", label: "WhatsApp", glyph: "💬" },
  { value: "website", label: "Website", glyph: "🌐" },
  { value: "other", label: "Other", glyph: "•" },
];

const BLANK_SOCIAL: SocialAccount = { platform: "instagram", label: "", url: "" };

export default function MySettingsPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    try {
      setMe(await getMe());
    } catch (err) {
      setLoadError(readableError(err, "Could not load your settings."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className={`deck-root ${fontVariables}`}>
      <div className="act-root">
        <header className="act-head">
          <h1>Settings</h1>
        </header>
        <p className="act-lede">
          Your details, in one place — how you appear to your team, the number your customers reach
          you on, and the socials your referral link points to. Changes here only ever touch your own
          account.
        </p>

        {loadError ? <p className="act-msg">{loadError}</p> : null}

        {me ? (
          me.role === "employee" ? (
            <div className="set-grid">
              <ProfileCard me={me} onSaved={load} />
              <SocialCard />
              <ConnectionsCard />
            </div>
          ) : (
            <div className="act-empty">
              Settings are for staff accounts. As an operator you edit your name and photo from the
              account menu in the top corner — there is no staff profile here to change.
            </div>
          )
        ) : loadError ? null : (
          <div className="act-empty">Loading…</div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- profile */

function initialsOf(me: Me): string {
  const source = me.fullName || me.email || "";
  const words = source.split("@")[0].split(/[\s._-]+/).filter(Boolean);
  const letters =
    words.length > 1 ? (words[0][0] ?? "") + (words[1][0] ?? "") : (words[0] ?? "").slice(0, 2);
  return (letters.replace(/[^a-zA-Z0-9]/g, "") || "ME").toUpperCase();
}

function ProfileCard({ me, onSaved }: { me: Me; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(me.fullName ?? "");
  const [jobTitle, setJobTitle] = useState(me.jobTitle ?? "");
  const [wa, setWa] = useState(me.whatsappNumber ?? "");
  const [avatar, setAvatar] = useState(me.avatarUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const dirty =
    name !== (me.fullName ?? "") ||
    jobTitle !== (me.jobTitle ?? "") ||
    wa !== (me.whatsappNumber ?? "") ||
    avatar !== (me.avatarUrl ?? "");

  // Resize a chosen photo to 256px in the browser and keep it as a data URI —
  // there is no file store here, so the picture travels inline with the profile.
  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      setError("Choose a PNG, JPEG or WebP. SVG is not accepted — it can carry scripts.");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setError("That file could not be read.");
    reader.onload = () => {
      const img = new window.Image();
      img.onerror = () => setError("That file is not an image this browser can open.");
      img.onload = () => {
        const size = 256;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          setError("This browser cannot process the image.");
          return;
        }
        const side = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        setAvatar(canvas.toDataURL("image/jpeg", 0.82));
        setError("");
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await updateMe({
        fullName: name.trim() || undefined,
        jobTitle: jobTitle.trim() ? jobTitle.trim() : null,
        whatsappNumber: wa.trim() ? wa.trim() : null,
        avatarUrl: avatar.trim() ? avatar.trim() : null,
      });
      await onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
    } catch (err) {
      setError(readableError(err, "That did not save."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="set-card" onSubmit={save}>
      <div className="set-card-head">
        <h2>Profile</h2>
        <span className="set-sub">How you appear to your team and on your referral link.</span>
      </div>

      <div className="set-id">
        <div className="set-avatar" aria-hidden={avatar ? undefined : "true"}>
          {avatar ? <img src={avatar} alt="" onError={(e) => (e.currentTarget.style.display = "none")} /> : initialsOf(me)}
        </div>
        <div className="set-id-actions">
          <button type="button" className="set-btn ghost" onClick={() => fileRef.current?.click()}>
            Change photo
          </button>
          {avatar ? (
            <button type="button" className="set-linkbtn" onClick={() => setAvatar("")}>
              Remove
            </button>
          ) : null}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={onPickFile} />
          <p className="set-hint">A chosen photo is shrunk to 256px and saved with your profile.</p>
        </div>
      </div>

      <label className="set-field">
        <span>Display name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" maxLength={80} />
      </label>

      <label className="set-field">
        <span>Job title</span>
        <input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="e.g. Sales, Support lead" maxLength={80} />
      </label>

      <label className="set-field">
        <span>WhatsApp number</span>
        <input value={wa} onChange={(e) => setWa(e.target.value)} placeholder="9715XXXXXXXX" inputMode="tel" />
        <span className="set-hint">Digits only, with country code. Used for your direct-contact link.</span>
      </label>

      <dl className="set-facts">
        <div><dt>Sign-in email</dt><dd>{me.email}</dd></div>
        {me.employeeCode ? <div><dt>Staff code</dt><dd>{me.employeeCode}</dd></div> : null}
        {me.businessName ? <div><dt>Business</dt><dd>{me.businessName}</dd></div> : null}
        {me.timezone ? <div><dt>Time zone</dt><dd>{me.timezone}</dd></div> : null}
      </dl>
      <p className="set-hint">Your email and staff code are how you sign in — an owner changes those.</p>

      {error ? <p className="set-error">{error}</p> : null}
      <div className="set-card-foot">
        {saved ? <span className="set-saved">Saved ✓</span> : null}
        <button type="submit" className="set-btn" disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save profile"}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------- social media */

function SocialCard() {
  const [rows, setRows] = useState<SocialAccount[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    getMySocialAccounts()
      .then((d) => setRows(d.accounts))
      .catch((err) => setError(readableError(err, "Could not load your social accounts.")));
  }, []);

  const touch = () => {
    setSaved(false);
    setDirty(true);
  };
  const setRow = (i: number, patch: Partial<SocialAccount>) => {
    touch();
    setRows((cur) => (cur ? cur.map((r, j) => (j === i ? { ...r, ...patch } : r)) : cur));
  };
  const addRow = () => {
    touch();
    setRows((cur) => [...(cur ?? []), { ...BLANK_SOCIAL }]);
  };
  const removeRow = (i: number) => {
    touch();
    setRows((cur) => (cur ? cur.filter((_, j) => j !== i) : cur));
  };

  async function save() {
    if (!rows) return;
    setSaving(true);
    setError("");
    try {
      const clean = rows.filter((r) => r.label.trim() || r.url.trim());
      const res = await saveMySocialAccounts(clean);
      setRows(res.accounts);
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
    } catch (err) {
      setError(readableError(err, "Could not save your social accounts."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="set-card">
      <div className="set-card-head">
        <h2>Social media</h2>
        <span className="set-sub">The profiles you use for work — where your link goes. A list only; it connects nothing.</span>
      </div>

      {error ? <p className="set-error">{error}</p> : null}

      {!rows ? (
        <p className="set-hint">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="set-empty">Nothing added yet. Add the socials you use for work.</p>
      ) : (
        <div className="set-socials">
          {rows.map((row, i) => (
            <div className="set-social-row" key={i}>
              <select aria-label="Platform" value={row.platform} onChange={(e) => setRow(i, { platform: e.target.value })}>
                {PLATFORMS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              <input aria-label="Handle or name" value={row.label} placeholder="@handle or page name" onChange={(e) => setRow(i, { label: e.target.value })} />
              <input aria-label="Link" value={row.url} placeholder="link (optional)" inputMode="url" onChange={(e) => setRow(i, { url: e.target.value })} />
              <button type="button" className="set-social-x" aria-label="Remove" onClick={() => removeRow(i)}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="set-card-foot">
        <button type="button" className="set-btn ghost" onClick={addRow} disabled={!rows}>
          + Add an account
        </button>
        {saved ? <span className="set-saved">Saved ✓</span> : null}
        <button type="button" className="set-btn" onClick={save} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save socials"}
        </button>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- connections */

function ConnectionsCard() {
  return (
    <section className="set-card">
      <div className="set-card-head">
        <h2>Connected accounts</h2>
        <span className="set-sub">Linking your Gmail or your own WhatsApp Business number is a separate, one-time step.</span>
      </div>
      <p className="set-hint">
        These actually connect an account — reading your client mail, or answering from your own
        WhatsApp number — so they live with your book, not here.
      </p>
      <a className="set-btn ghost set-link" href="/deck/my-clients">
        Open Connections in My clients →
      </a>
    </section>
  );
}
