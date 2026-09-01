"use client";

import { useEffect, useState } from "react";
import {
  getMySocialAccounts,
  saveMySocialAccounts,
  readableError,
  type SocialAccount,
} from "@/lib/api";

/**
 * Where a staff member is online — a list they type in themselves.
 *
 * ============================================================
 * A DIRECTORY, NOT A CONNECTION
 * ============================================================
 *
 * This is deliberately the plain version: platform, a handle, a link. It does
 * not connect anything, read anything, or hold a token — connecting an account
 * (Gmail; TikTok if it is ever un-parked) is the "Your accounts" panel above,
 * and it is a different thing. This exists so the referral link has somewhere to
 * point: "put your link on your socials" needs a list of which socials those
 * are, for the person to work through and for the owner to see the reach.
 */

const PLATFORMS: { value: string; label: string }[] = [
  { value: "instagram", label: "Instagram" },
  { value: "facebook", label: "Facebook" },
  { value: "tiktok", label: "TikTok" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "youtube", label: "YouTube" },
  { value: "x", label: "X (Twitter)" },
  { value: "snapchat", label: "Snapchat" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "website", label: "Website" },
  { value: "other", label: "Other" },
];

const BLANK: SocialAccount = { platform: "instagram", label: "", url: "" };

export function SocialAccountsPanel() {
  const [rows, setRows] = useState<SocialAccount[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await getMySocialAccounts();
      setRows(data.accounts);
      setError(null);
    } catch (err) {
      const message = readableError(err, "Could not load your social accounts.");
      // The owner has no employee record here, so this panel is not theirs.
      if (/only a staff|account not found|no personal account/i.test(message)) setRows(null);
      else setError(message);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (!rows) return null;

  const edit = () => setSavedNotice(null);
  const setRow = (index: number, patch: Partial<SocialAccount>) => {
    edit();
    setRows((current) =>
      current ? current.map((row, i) => (i === index ? { ...row, ...patch } : row)) : current
    );
  };
  const addRow = () => {
    edit();
    setRows((current) => (current ? [...current, { ...BLANK }] : [{ ...BLANK }]));
  };
  const removeRow = (index: number) => {
    edit();
    setRows((current) => (current ? current.filter((_, i) => i !== index) : current));
  };

  return (
    <section className="soc">
      <h2>Your social accounts</h2>
      <p className="soc-lede">
        The pages and profiles you are on — where your link goes. Just a list for your own record and
        the owner&rsquo;s; it does not connect anything or read your messages.
      </p>

      {error ? <p className="mc-error">{error}</p> : null}

      {rows.length === 0 ? (
        <p className="soc-empty">Nothing added yet. Add the socials you use for work.</p>
      ) : (
        <div className="soc-rows">
          {rows.map((row, index) => (
            <div key={index} className="soc-row">
              <select
                aria-label="Platform"
                value={row.platform}
                onChange={(event) => setRow(index, { platform: event.target.value })}
              >
                {PLATFORMS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              <input
                aria-label="Handle or name"
                value={row.label}
                placeholder="@handle or page name"
                onChange={(event) => setRow(index, { label: event.target.value })}
              />
              <input
                aria-label="Link"
                value={row.url}
                placeholder="link (optional)"
                inputMode="url"
                onChange={(event) => setRow(index, { url: event.target.value })}
              />
              <button
                type="button"
                className="soc-remove"
                aria-label="Remove"
                onClick={() => removeRow(index)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="soc-foot">
        <button type="button" className="soc-add" onClick={addRow}>
          + Add an account
        </button>
        <button
          type="button"
          className="soc-save"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              const result = await saveMySocialAccounts(rows);
              setRows(result.accounts);
              setSavedNotice(
                result.accounts.length === 0
                  ? "Saved — no accounts on file."
                  : `Saved — ${result.accounts.length} account${result.accounts.length === 1 ? "" : "s"}.`
              );
            } catch (err) {
              setError(readableError(err, "Those were not saved."));
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {savedNotice ? <p className="soc-saved">{savedNotice}</p> : null}
    </section>
  );
}
