"use client";

import { useEffect, useRef, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import {
  createCustomerList,
  deleteCustomerList,
  getInboxSettings,
  previewCustomerList,
  readableError,
  type CustomerList,
  type SegmentFilter,
} from "@/lib/api";

/**
 * Customer lists that keep themselves up to date — DoubleTick's Segmentation
 * Studio. A list is a SAVED FILTER: labels, stage, how recently they wrote,
 * lead source, a custom field, a minimum score. It is evaluated when a campaign
 * goes out, so it is always current.
 *
 * The preview is live: who it reaches right now and a few names, so a list is
 * checked by eye before anything is sent to it. Opted-out customers and anyone
 * without a WhatsApp number are never in a list — the server applies that to
 * every one, and this says so rather than letting a count look short.
 */
export function CustomerLists({
  business,
  lists,
  onChanged,
}: {
  business: BusinessSlug;
  lists: CustomerList[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [stages, setStages] = useState<string[]>([]);
  const [stageChoices, setStageChoices] = useState<string[]>([]);
  const [active, setActive] = useState("");
  const [quiet, setQuiet] = useState("");
  const [source, setSource] = useState("");
  const [fieldKey, setFieldKey] = useState("");
  const [fieldValue, setFieldValue] = useState("");
  const [minScore, setMinScore] = useState("");
  const [preview, setPreview] = useState<{ count: number; sample: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getInboxSettings(business)
      .then(({ settings }) => setStageChoices(settings.stages))
      .catch(() => setStageChoices([]));
  }, [business]);

  const filter: SegmentFilter = {
    ...(tags.trim() ? { tags: tags.split(",").map((t) => t.trim()).filter(Boolean) } : {}),
    ...(stages.length ? { stages } : {}),
    ...(active ? { activeWithinDays: Number(active) } : {}),
    ...(quiet ? { quietForDays: Number(quiet) } : {}),
    ...(source.trim() ? { leadSource: source.trim() } : {}),
    ...(fieldKey.trim() ? { field: { key: fieldKey.trim(), value: fieldValue.trim() } } : {}),
    ...(minScore ? { minScore: Number(minScore) } : {}),
  };
  const filterKey = JSON.stringify(filter);

  // Live preview, debounced so typing a label does not fire a query per key.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!open) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      previewCustomerList(business, JSON.parse(filterKey) as SegmentFilter)
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 350);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [open, business, filterKey]);

  function reset() {
    setName("");
    setTags("");
    setStages([]);
    setActive("");
    setQuiet("");
    setSource("");
    setFieldKey("");
    setFieldValue("");
    setMinScore("");
    setPreview(null);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createCustomerList(business, name.trim(), filter);
      reset();
      setOpen(false);
      onChanged();
    } catch (err) {
      setError(readableError(err, "That list did not save."));
    } finally {
      setBusy(false);
    }
  }

  async function remove(list: CustomerList) {
    setError(null);
    try {
      await deleteCustomerList(business, list.id);
      onChanged();
    } catch (err) {
      setError(readableError(err, "Could not delete that list."));
    }
  }

  return (
    <section className="cl">
      <header className="cl-head">
        <h2 className="act-sub-head">Customer lists</h2>
        <button type="button" className="cl-new" onClick={() => setOpen((o) => !o)}>
          {open ? "Close" : "+ New list"}
        </button>
      </header>
      <p className="cl-lede">
        Saved filters that stay up to date on their own — pick one as a campaign&apos;s audience and it is worked out
        again the moment you send. Opted-out customers and anyone without a WhatsApp number are always left out.
      </p>

      {lists.length ? (
        <ul className="cl-list">
          {lists.map((list) => (
            <li key={list.id} className="cl-item">
              <span className="cl-count">{list.count}</span>
              <span className="cl-main">
                <b>{list.name}</b>
                <small>{describe(list.filter)}</small>
              </span>
              <button type="button" className="cl-del" onClick={() => void remove(list)} aria-label={`Delete ${list.name}`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : !open ? (
        <div className="act-empty">No lists yet. “Everyone reachable” is always available as an audience.</div>
      ) : null}

      {open ? (
        <form className="cl-form" onSubmit={save}>
          <label className="cl-f wide">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Qualified leads, quiet 30 days" maxLength={80} />
          </label>
          <label className="cl-f">
            <span>Has any of these labels</span>
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="VIP, wholesale" />
          </label>
          <label className="cl-f">
            <span>Lead source</span>
            <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="Instagram ad" />
          </label>
          {stageChoices.length ? (
            <div className="cl-f wide">
              <span>In any of these stages</span>
              <div className="cl-chips">
                {stageChoices.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`cl-chip${stages.includes(s) ? " on" : ""}`}
                    aria-pressed={stages.includes(s)}
                    onClick={() => setStages((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <label className="cl-f">
            <span>Wrote to us within</span>
            <select value={active} onChange={(e) => setActive(e.target.value)}>
              <option value="">Any time</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
            </select>
          </label>
          <label className="cl-f">
            <span>Quiet for at least</span>
            <select value={quiet} onChange={(e) => setQuiet(e.target.value)}>
              <option value="">—</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
              <option value="60">60 days</option>
              <option value="90">90 days</option>
            </select>
          </label>
          <label className="cl-f">
            <span>Custom field</span>
            <span className="cl-pair">
              <input value={fieldKey} onChange={(e) => setFieldKey(e.target.value)} placeholder="Field" />
              <input value={fieldValue} onChange={(e) => setFieldValue(e.target.value)} placeholder="equals" />
            </span>
          </label>
          <label className="cl-f">
            <span>Lead score at least</span>
            <input type="number" min={0} max={100} value={minScore} onChange={(e) => setMinScore(e.target.value)} placeholder="0–100" />
          </label>

          <div className="cl-preview" role="status">
            {preview ? (
              <>
                <b>
                  {preview.count} {preview.count === 1 ? "customer" : "customers"}
                </b>{" "}
                right now
                {preview.sample.length ? <span> — {preview.sample.join(", ")}{preview.count > preview.sample.length ? "…" : ""}</span> : null}
              </>
            ) : (
              "Counting…"
            )}
          </div>
          <div className="cl-actions">
            <button type="submit" className="bc-send" disabled={busy || !name.trim()}>
              {busy ? "Saving…" : "Save list"}
            </button>
          </div>
        </form>
      ) : null}
      {error ? <p className="act-msg">{error}</p> : null}
    </section>
  );
}

/** "Label VIP · stage Qualified · quiet 30+ days" — a list in one line. */
export function describe(filter: SegmentFilter): string {
  const parts: string[] = [];
  if (filter.tags?.length) parts.push(`label ${filter.tags.join(" or ")}`);
  if (filter.stages?.length) parts.push(`stage ${filter.stages.join(" or ")}`);
  if (filter.activeWithinDays) parts.push(`wrote in last ${filter.activeWithinDays} days`);
  if (filter.quietForDays) parts.push(`quiet ${filter.quietForDays}+ days`);
  if (filter.leadSource) parts.push(`from ${filter.leadSource}`);
  if (filter.field) parts.push(`${filter.field.key} = ${filter.field.value || "(empty)"}`);
  if (filter.minScore) parts.push(`score ≥ ${filter.minScore}`);
  return parts.length ? parts.join(" · ") : "Everyone reachable";
}
