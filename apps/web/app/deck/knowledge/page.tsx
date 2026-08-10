"use client";

import { useCallback, useEffect, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import {
  getKnowledge,
  addKnowledge,
  removeKnowledge,
  type KnowledgeSource,
} from "@/lib/api";
import { fontVariables } from "@/lib/fonts";
import { TENANTS } from "@/lib/tenants";
import "../deck.css";
import "../activity/activity.css";
import "./knowledge.css";

/**
 * What each business's agent actually knows.
 *
 * Until now this existed only as an API, which meant the answer to "why did the
 * agent say that?" required a terminal. It is the highest-leverage screen in
 * the product: every customer reply is generated from these sources, so a stale
 * page here is a wrong answer to a real person, repeated until someone notices.
 *
 * Two things it is careful about:
 *
 *   Removing a source is destructive and silent in its effects — the agent
 *   simply stops knowing something and answers worse, with no error anywhere.
 *   So deletion asks first and names what is being removed.
 *
 *   Indexing is synchronous and can take seconds on a slow page. The button
 *   says what is happening rather than appearing hung, and a failure shows the
 *   server's own reason, because "a blocked internal URL" and "the site is
 *   down" need different responses from the operator.
 */
export default function KnowledgePage() {
  const [business, setBusiness] = useState<BusinessSlug>("zipicka");
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mode, setMode] = useState<"url" | "text">("url");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [confirming, setConfirming] = useState<KnowledgeSource | null>(null);

  const load = useCallback(async (slug: BusinessSlug) => {
    setLoading(true);
    setError("");
    try {
      const data = await getKnowledge(slug);
      setSources(data.sources);
    } catch (err) {
      setError(readable(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(business);
    setConfirming(null);
    setNotice("");
  }, [business, load]);

  async function handleAdd(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const input =
        mode === "url"
          ? { url: url.trim(), title: title.trim() || undefined }
          : { title: title.trim(), content: content.trim() };
      const result = await addKnowledge(business, input);
      setNotice(
        result.unchanged
          ? "Already up to date — the content had not changed, so nothing was re-indexed."
          : `Indexed ${result.chunks} ${result.chunks === 1 ? "passage" : "passages"}.`
      );
      setUrl("");
      setTitle("");
      setContent("");
      await load(business);
    } catch (err) {
      setError(readable(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(source: KnowledgeSource) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await removeKnowledge(business, source.id);
      setNotice(`Removed "${source.title}". The agent no longer knows anything from it.`);
      setConfirming(null);
      await load(business);
    } catch (err) {
      setError(readable(err));
    } finally {
      setBusy(false);
    }
  }

  const indexed = sources.filter((source) => source.status === "indexed");
  const failed = sources.filter((source) => source.error);
  const totalPassages = sources.reduce((sum, source) => sum + source.chunks, 0);

  return (
    <div className={`deck-root ${fontVariables}`}>
      <div className="act-root">
        <a className="act-back" href="/">
          ← Command deck
        </a>

        <header className="act-head">
          <h1>Knowledge</h1>
        </header>
        <p className="act-lede">
          Everything the agent draws on when it answers a customer. If a reply was wrong, the
          reason is almost always on this page.
        </p>

        <div className="act-tabs">
          {TENANTS.map((tenant) => (
            <button
              key={tenant.slug}
              aria-pressed={business === tenant.slug}
              onClick={() => setBusiness(tenant.slug as BusinessSlug)}
            >
              {tenant.ref}
            </button>
          ))}
        </div>

        {error ? <p className="act-msg">{error}</p> : null}
        {notice && !error ? <p className="kn-ok">{notice}</p> : null}

        {failed.length > 0 ? (
          <p className="kn-warn">
            {failed.length} {failed.length === 1 ? "source" : "sources"} failed to index. The agent
            is answering without {failed.length === 1 ? "it" : "them"}.
          </p>
        ) : null}

        <section className="kn-add">
          <h2 className="act-sub-head">Teach it something</h2>
          <div className="kn-modes">
            <button aria-pressed={mode === "url"} onClick={() => setMode("url")}>
              From a page
            </button>
            <button aria-pressed={mode === "text"} onClick={() => setMode("text")}>
              Write it out
            </button>
          </div>

          <form onSubmit={handleAdd}>
            {mode === "url" ? (
              <>
                <label>
                  <span>Page address</span>
                  <input
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="https://example.ae/services/attestation"
                    required
                  />
                </label>
                <label>
                  <span>Title (optional — taken from the page if blank)</span>
                  <input value={title} onChange={(event) => setTitle(event.target.value)} />
                </label>
              </>
            ) : (
              <>
                <label>
                  <span>Title</span>
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="Refund policy"
                    required
                  />
                </label>
                <label>
                  <span>What the agent should know</span>
                  <textarea
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    rows={6}
                    placeholder="Write it the way you would explain it to a new colleague."
                    required
                  />
                </label>
              </>
            )}

            <button className="kn-submit" type="submit" disabled={busy}>
              {/* Indexing is synchronous and can take seconds — saying so beats
                  looking hung. */}
              {busy ? "Reading and indexing…" : "Add to knowledge"}
            </button>
          </form>
        </section>

        <h2 className="act-sub-head">
          What it knows{" "}
          {sources.length > 0 ? (
            <span className="kn-count">
              {indexed.length} {indexed.length === 1 ? "source" : "sources"}, {totalPassages}{" "}
              passages
            </span>
          ) : null}
        </h2>

        {loading ? (
          <div className="act-empty">Loading…</div>
        ) : sources.length === 0 ? (
          <div className="act-empty">
            <strong>This agent knows nothing yet.</strong>
            <br />
            It will still reply, but only from its instructions — it cannot answer anything
            specific about the business until something is added above.
          </div>
        ) : (
          <div className="kn-list">
            {sources.map((source) => (
              <article className={`kn-item${source.error ? " bad" : ""}`} key={source.id}>
                <div className="kn-main">
                  <h3>{source.title}</h3>
                  {source.uri ? (
                    <a className="kn-uri" href={source.uri} target="_blank" rel="noreferrer">
                      {source.uri}
                    </a>
                  ) : (
                    <span className="kn-uri plain">Written by hand</span>
                  )}
                  {source.error ? <p className="kn-error">{source.error}</p> : null}
                </div>

                <div className="kn-meta">
                  <span className={`act-flag${source.error ? " warn" : ""}`}>{source.status}</span>
                  <span className="kn-passages">
                    {source.chunks} {source.chunks === 1 ? "passage" : "passages"}
                  </span>
                  <span className="kn-when">{freshness(source)}</span>
                </div>

                {confirming?.id === source.id ? (
                  <div className="kn-confirm">
                    {/* Deletion has no visible failure mode — the agent just
                        answers worse from then on — so it names what goes. */}
                    <span>
                      Remove “{source.title}”? The agent will stop knowing its {source.chunks}{" "}
                      {source.chunks === 1 ? "passage" : "passages"} immediately.
                    </span>
                    <button className="kn-danger" onClick={() => handleRemove(source)} disabled={busy}>
                      {busy ? "Removing…" : "Remove"}
                    </button>
                    <button className="kn-cancel" onClick={() => setConfirming(null)}>
                      Keep
                    </button>
                  </div>
                ) : (
                  <button className="kn-remove" onClick={() => setConfirming(source)}>
                    Remove
                  </button>
                )}
              </article>
            ))}
          </div>
        )}

        <p className="act-caveat">
          <strong>How this is used.</strong> When a customer asks something, the agent searches
          these passages and answers from what it finds. It re-checks pages every six hours, so a
          site edit reaches customers on its own — but text written here changes only when you
          change it. A source that failed to index is not used at all.
        </p>
      </div>
    </div>
  );
}

function freshness(source: KnowledgeSource): string {
  const stamp = source.lastIndexedAt ?? source.lastCheckedAt;
  if (!stamp) return "never indexed";
  const days = Math.floor((Date.now() - new Date(stamp).getTime()) / 86_400_000);
  if (days <= 0) return "indexed today";
  if (days === 1) return "indexed yesterday";
  return `indexed ${days} days ago`;
}

/** The server's reason, not a generic one — they call for different responses. */
function readable(err: unknown): string {
  if (!(err instanceof Error)) return "Something went wrong.";
  const match = err.message.match(/\{"error":"(.+?)"\}/);
  return match ? match[1] : err.message;
}
