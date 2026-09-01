"use client";

import { useEffect, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import {
  getBusinessSocialAccounts,
  saveBusinessSocialAccounts,
  readableError,
  type SocialAccount,
} from "@/lib/api";

/**
 * A business's own social accounts — the company pages, set by the owner.
 *
 * The org-level twin of the staff directory (My clients → Your social accounts).
 * Same shape, same "directory not a connection" rule; it just belongs to the
 * business rather than a person, and only the owner writes it. Reloads whenever
 * the owner switches business, because these are per-company.
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

export function BusinessSocialsPanel({ slug }: { slug: BusinessSlug }) {
  const [rows, setRows] = useState<SocialAccount[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRows(null);
    setSavedNotice(null);
    setError(null);
    getBusinessSocialAccounts(slug)
      .then((data) => {
        if (live) setRows(data.accounts);
      })
      .catch((err) => {
        if (live) setError(readableError(err, "Could not load the business's social accounts."));
      });
    return () => {
      live = false;
    };
  }, [slug]);

  const edit = () => setSavedNotice(null);
  const setRow = (index: number, patch: Partial<SocialAccount>) => {
    edit();
    setRows((cur) => (cur ? cur.map((r, i) => (i === index ? { ...r, ...patch } : r)) : cur));
  };
  const addRow = () => {
    edit();
    setRows((cur) => (cur ? [...cur, { ...BLANK }] : [{ ...BLANK }]));
  };
  const removeRow = (index: number) => {
    edit();
    setRows((cur) => (cur ? cur.filter((_, i) => i !== index) : cur));
  };

  return (
    <section className="soc bsoc">
      <h2>The company&rsquo;s social accounts</h2>
      <p className="soc-lede">
        This business&rsquo;s own pages and profiles. Recorded here for reference — a directory, not a
        connection; nothing here reads a message.
      </p>

      {error ? <p className="team-msg bad">{error}</p> : null}

      {rows === null ? (
        <p className="soc-empty">Loading&hellip;</p>
      ) : (
        <>
          {rows.length === 0 ? (
            <p className="soc-empty">No company accounts added yet.</p>
          ) : (
            <div className="soc-rows">
              {rows.map((row, index) => (
                <div key={index} className="soc-row">
                  <select
                    aria-label="Platform"
                    value={row.platform}
                    onChange={(e) => setRow(index, { platform: e.target.value })}
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
                    onChange={(e) => setRow(index, { label: e.target.value })}
                  />
                  <input
                    aria-label="Link"
                    value={row.url}
                    placeholder="link (optional)"
                    inputMode="url"
                    onChange={(e) => setRow(index, { url: e.target.value })}
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
                  const result = await saveBusinessSocialAccounts(slug, rows);
                  setRows(result.accounts);
                  setSavedNotice(
                    result.accounts.length === 0
                      ? "Saved — no company accounts on file."
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
        </>
      )}
    </section>
  );
}
