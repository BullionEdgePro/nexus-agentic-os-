"use client";

import { useState } from "react";
import {
  saveHqProfile,
  saveHqKeyword,
  deleteHqKeyword,
  saveHqSocial,
  deleteHqSocial,
  checkHqNow,
  readableError,
  type HqBusinessDetail,
  type HqCheck,
  type HqSocial,
} from "@/lib/api";
import { ScoreRing } from "../overview";
import { VaultPanel } from "./vault-panel";

/**
 * One business in Business HQ (spec 2026-10-14-business-hq-design.md §3.2).
 * Five tabs over one response; `tab` and `now` are props so every tab renders
 * the same on the server, in tests and in the browser.
 */
export type HqTab = "overview" | "website" | "seo" | "social" | "vault";

export const TABS: { id: HqTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "website", label: "Website & domain" },
  { id: "seo", label: "SEO & Google" },
  { id: "social", label: "Social media" },
  { id: "vault", label: "Vault & access log" },
];

const DAY = 86_400_000;
const daysUntil = (iso: string, now: Date) => Math.round((new Date(iso).getTime() - now.getTime()) / DAY);
const daysAgo = (iso: string, now: Date) => Math.round((now.getTime() - new Date(iso).getTime()) / DAY);
const shortDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const dateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
/** Only http(s) links are rendered as links; anything else stays text. */
const isHttpLink = (url: string | null | undefined): url is string => !!url && /^https?:\/\//i.test(url.trim());

/** A fresh / stale / never chip for something a person has to keep up. */
function Freshness({ at, maxDays, now, verb = "updated" }: { at: string | null; maxDays: number; now: Date; verb?: string }) {
  if (!at) return <span className="hq-chip never">never {verb}</span>;
  const d = daysAgo(at, now);
  return <span className={`hq-chip ${d > maxDays ? "stale" : "fresh"}`}>{d > maxDays ? "stale · " : ""}{verb} {d === 0 ? "today" : `${d} days ago`}</span>;
}

/** A countdown chip for something that expires. */
function Countdown({ at, warnDays, critDays, now }: { at: string; warnDays: number; critDays: number; now: Date }) {
  const d = daysUntil(at, now);
  const tone = d <= critDays ? "crit" : d <= warnDays ? "warn" : "fresh";
  return <span className={`hq-chip ${tone}`}>{d <= 0 ? "expired" : `expires in ${d} days`}</span>;
}

/** One automatic check as a row: its answer, or plainly that it could not be checked. */
function CheckRow({ label, check, children }: { label: string; check: HqCheck | undefined; children: React.ReactNode }) {
  let body: React.ReactNode;
  if (!check) body = <span className="hq-unknown">Not checked yet — press Check now</span>;
  else if (check.ok === null) body = <span className="hq-unknown">Could not check{check.error ? ` — ${check.error}` : ""}</span>;
  else body = children;
  return (
    <div className="hq-fact">
      <dt>{label}</dt>
      <dd>{body}</dd>
    </div>
  );
}

export function HqBusinessView({
  data,
  tab,
  now = new Date(),
  onTab,
  onChanged,
}: {
  data: HqBusinessDetail;
  tab: HqTab;
  now?: Date;
  onTab: (tab: HqTab) => void;
  onChanged: () => void;
}) {
  const [checkMsg, setCheckMsg] = useState("");
  const slug = data.business.slug;
  const lastRun = Object.values(data.checks).map((c) => c?.ranAt).filter(Boolean).sort().pop() ?? null;

  async function checkNow() {
    setCheckMsg("");
    try {
      await checkHqNow(slug);
      setCheckMsg("Checking now — refresh in a minute for the results.");
    } catch (err) {
      setCheckMsg(readableError(err));
    }
  }

  return (
    <div className="hq-business">
      <header className="hq-bhead">
        <a href="/deck/hq" className="hq-back">← All businesses</a>
        <div className="hq-bhead-row">
          <ScoreRing score={data.score} size={72} />
          <div className="hq-bhead-name">
            <h1>{data.business.name}</h1>
            <p className="hq-muted">
              {data.business.websiteUrl ?? "No website recorded"} · last checked {lastRun ? `${shortDate(lastRun)}` : "never"}
            </p>
          </div>
          <button type="button" className="btn" onClick={checkNow}>Check now</button>
        </div>
        {checkMsg ? <p className="hq-vault-msg" role="status">{checkMsg}</p> : null}
      </header>

      <nav className="hq-tabs" role="tablist" aria-label="Business HQ sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : undefined} onClick={() => onTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      <div className="hq-panel" role="tabpanel">
        {tab === "overview" ? <OverviewTab data={data} now={now} /> : null}
        {tab === "website" ? <WebsiteTab data={data} now={now} onChanged={onChanged} /> : null}
        {tab === "seo" ? <SeoTab data={data} now={now} onChanged={onChanged} /> : null}
        {tab === "social" ? <SocialTab data={data} now={now} onChanged={onChanged} /> : null}
        {tab === "vault" ? (
          <>
            <VaultPanel slug={slug} entries={data.vault} configured={data.vaultConfigured} unlockedSeconds={data.unlockedSeconds} now={now} onChanged={onChanged} />
            <RevealLog data={data} />
          </>
        ) : null}
      </div>
    </div>
  );
}

// ---------- Overview ----------

function OverviewTab({ data, now }: { data: HqBusinessDetail; now: Date }) {
  const c = data.checks;
  return (
    <div className="hq-two">
      <section>
        <h3>Needs you</h3>
        {data.issues.length === 0 ? (
          <p className="hq-allclear">All clear — nothing needs you here.</p>
        ) : (
          <ul className="hq-needs">
            {data.issues.map((i) => (
              <li key={i.code} className={`hq-need sev-${i.severity}`}>
                <span className="hq-sev" />
                <div>
                  <strong>{i.title}</strong>
                  <p>{i.fix}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3>At a glance</h3>
        <dl className="hq-facts">
          <CheckRow label="Domain" check={c.rdap}>
            {String(c.rdap?.data.registrar ?? "Registrar unknown")}{" "}
            {c.rdap?.data.expiresAt ? <Countdown at={String(c.rdap.data.expiresAt)} warnDays={30} critDays={14} now={now} /> : null}
          </CheckRow>
          <CheckRow label="Hosting" check={c.dns}>{String(c.dns?.data.provider ?? "Unknown")}</CheckRow>
          <CheckRow label="SSL" check={c.tls}>{c.tls?.data.validTo ? <Countdown at={String(c.tls.data.validTo)} warnDays={21} critDays={7} now={now} /> : "—"}</CheckRow>
          <CheckRow label="Platform" check={c.platform}>{String(c.platform?.data.platform ?? "Not recognised")}</CheckRow>
          <div className="hq-fact"><dt>Saved logins</dt><dd>{data.vault.length}</dd></div>
          <div className="hq-fact"><dt>Social accounts</dt><dd>{data.socials.length}</dd></div>
        </dl>
      </section>
    </div>
  );
}

// ---------- Website & domain ----------

function WebsiteTab({ data, now, onChanged }: { data: HqBusinessDetail; now: Date; onChanged: () => void }) {
  const c = data.checks;
  const p = data.profile;
  const [form, setForm] = useState({
    domain: p?.domain ?? data.business.websiteUrl ?? "",
    registrarNote: p?.registrarNote ?? "",
    hostingNote: p?.hostingNote ?? "",
    platformNote: p?.platformNote ?? "",
  });
  const [msg, setMsg] = useState("");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    try {
      await saveHqProfile(data.business.slug, form);
      // A new or changed domain is checked straight away, so its expiry,
      // host and certificate fill in without waiting for 6 am.
      if (form.domain && form.domain !== (p?.domain ?? "")) await checkHqNow(data.business.slug).catch(() => undefined);
      setMsg("Saved.");
      onChanged();
    } catch (err) {
      setMsg(readableError(err));
    }
  }

  const speed = c.speed?.data as { mobile?: number; desktop?: number } | undefined;
  return (
    <div className="hq-stack">
      <section>
        <h3>Checked automatically every morning</h3>
        <dl className="hq-facts">
          <CheckRow label="Registrar" check={c.rdap}>{String(c.rdap?.data.registrar ?? "Unknown")}</CheckRow>
          <CheckRow label="Domain expiry" check={c.rdap}>
            {c.rdap?.data.expiresAt ? <>{shortDate(String(c.rdap.data.expiresAt))} <Countdown at={String(c.rdap.data.expiresAt)} warnDays={30} critDays={14} now={now} /></> : "—"}
          </CheckRow>
          <CheckRow label="Hosting" check={c.dns}>
            {String(c.dns?.data.provider ?? "Unknown")}
            {Array.isArray(c.dns?.data.nameservers) && (c.dns?.data.nameservers as string[]).length ? (
              <span className="hq-muted"> · {(c.dns?.data.nameservers as string[]).join(", ")}</span>
            ) : null}
          </CheckRow>
          <CheckRow label="SSL certificate" check={c.tls}>
            {c.tls?.ok === false ? (
              <span className="hq-chip crit">not working — {c.tls.error}</span>
            ) : c.tls?.data.validTo ? (
              <>{String(c.tls.data.issuer ?? "")} · {shortDate(String(c.tls.data.validTo))} <Countdown at={String(c.tls.data.validTo)} warnDays={21} critDays={7} now={now} /></>
            ) : "—"}
          </CheckRow>
          <CheckRow label="Up?" check={c.http}>
            {c.http?.ok ? <span className="hq-chip fresh">up · {String(c.http.data.ms)} ms</span> : <span className="hq-chip crit">down — {c.http?.error}</span>}
          </CheckRow>
          <CheckRow label="Speed (Google)" check={c.speed}>
            {speed ? <>mobile <b className={speed.mobile! < 50 ? "hq-bad" : speed.mobile! < 70 ? "hq-meh" : "hq-good"}>{speed.mobile}</b> · desktop <b>{speed.desktop}</b></> : "—"}
          </CheckRow>
          <CheckRow label="Platform" check={c.platform}>{String(c.platform?.data.platform ?? "Not recognised")}</CheckRow>
        </dl>
      </section>
      <section>
        <h3>Your notes</h3>
        <form className="hq-form" onSubmit={save}>
          <div className="hq-form-grid">
            <label>Website address<input id="hq-domain" value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="example.com" /></label>
            <label>Registrar (where the domain is bought)<input value={form.registrarNote} onChange={(e) => setForm({ ...form, registrarNote: e.target.value })} placeholder="Hostinger, GoDaddy…" /></label>
            <label>Hosting plan / renewal<input value={form.hostingNote} onChange={(e) => setForm({ ...form, hostingNote: e.target.value })} placeholder="Business plan, renews Mar 2027" /></label>
            <label>Built with<input value={form.platformNote} onChange={(e) => setForm({ ...form, platformNote: e.target.value })} placeholder="WordPress + Elementor" /></label>
          </div>
          <div className="hq-form-actions"><button type="submit" className="btn">Save</button>{msg ? <span className="hq-muted">{msg}</span> : null}</div>
        </form>
      </section>
      <section>
        <h3>Website, hosting and domain logins</h3>
        <VaultPanel slug={data.business.slug} entries={data.vault} configured={data.vaultConfigured} unlockedSeconds={data.unlockedSeconds} section="website" now={now} onChanged={onChanged} />
      </section>
    </div>
  );
}

// ---------- SEO & Google ----------

function SeoTab({ data, now, onChanged }: { data: HqBusinessDetail; now: Date; onChanged: () => void }) {
  const seo = data.checks.seo;
  const s = (seo?.data ?? {}) as Record<string, unknown>;
  const p = data.profile;
  const [kw, setKw] = useState({ keyword: "", position: "", checkedAt: new Date().toISOString().slice(0, 10) });
  const [gbp, setGbp] = useState({
    gbpUrl: p?.gbpUrl ?? "",
    gbpRating: p?.gbpRating?.toString() ?? "",
    gbpReviewCount: p?.gbpReviewCount?.toString() ?? "",
    gbpUnansweredReviews: p?.gbpUnansweredReviews?.toString() ?? "",
    gbpLastPostAt: dateInput(p?.gbpLastPostAt ?? null),
    gbpLastPhotoAt: dateInput(p?.gbpLastPhotoAt ?? null),
  });
  const [msg, setMsg] = useState("");

  const item = (ok: boolean, good: string, bad: string) => (
    <li className={ok ? "hq-ok" : "hq-no"}><span aria-hidden>{ok ? "✓" : "✕"}</span> {ok ? good : bad}</li>
  );

  async function addKeyword(e: React.FormEvent) {
    e.preventDefault();
    if (!kw.keyword.trim()) return;
    try {
      await saveHqKeyword(data.business.slug, { keyword: kw.keyword.trim(), position: kw.position ? Number(kw.position) : null, checkedAt: kw.checkedAt || null });
      setKw({ ...kw, keyword: "", position: "" });
      onChanged();
    } catch (err) {
      setMsg(readableError(err));
    }
  }

  async function saveGbp(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    try {
      await saveHqProfile(data.business.slug, {
        gbpUrl: gbp.gbpUrl || null,
        gbpRating: gbp.gbpRating ? Number(gbp.gbpRating) : null,
        gbpReviewCount: gbp.gbpReviewCount ? Number(gbp.gbpReviewCount) : null,
        gbpUnansweredReviews: gbp.gbpUnansweredReviews ? Number(gbp.gbpUnansweredReviews) : null,
        gbpLastPostAt: gbp.gbpLastPostAt || null,
        gbpLastPhotoAt: gbp.gbpLastPhotoAt || null,
      });
      setMsg("Saved.");
      onChanged();
    } catch (err) {
      setMsg(readableError(err));
    }
  }

  return (
    <div className="hq-stack">
      <section>
        <h3>Homepage SEO basics</h3>
        {!seo || seo.ok === null ? (
          <p className="hq-unknown">Could not check{seo?.error ? ` — ${seo.error}` : " yet — press Check now"}</p>
        ) : (
          <ul className="hq-checklist">
            {item(!!s.title, `Title: “${String(s.title)}” (${String(s.titleLength)} characters)`, "No page title")}
            {item(!!s.metaDescription, "Meta description present", "No meta description")}
            {item(Number(s.h1Count) === 1, "One main heading (H1)", Number(s.h1Count) === 0 ? "No main heading (H1)" : `${String(s.h1Count)} H1 headings — use one`)}
            {item(!!s.sitemapOk, "sitemap.xml found", "No sitemap.xml")}
            {item(!s.robotsBlocksAll, "robots.txt lets Google in", "robots.txt blocks search engines")}
            {item(!s.noindex, "Google may index the homepage", "The homepage tells Google not to index it")}
            {item(!!s.jsonLd, "Structured data present", "No structured data")}
            {item(!!s.canonical, "Canonical tag present", "No canonical tag")}
          </ul>
        )}
      </section>

      <section>
        <h3>Target keywords</h3>
        {data.keywords.length === 0 ? <p className="hq-empty">No keywords yet. Add the searches you want this business found for.</p> : (
          <table className="hq-table">
            <thead><tr><th>Keyword</th><th>Google position</th><th>Last checked</th><th /></tr></thead>
            <tbody>
              {data.keywords.map((k) => (
                <tr key={k.id}>
                  <td>{k.keyword}</td>
                  <td className="num">{k.position ?? "—"}</td>
                  <td><Freshness at={k.checkedAt} maxDays={30} now={now} verb="checked" /></td>
                  <td><button type="button" className="btn ghost danger" onClick={() => deleteHqKeyword(data.business.slug, k.id).then(onChanged)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form className="hq-inline" onSubmit={addKeyword}>
          <input aria-label="Keyword" placeholder="e.g. villas for sale dubai" value={kw.keyword} onChange={(e) => setKw({ ...kw, keyword: e.target.value })} />
          <input aria-label="Position" type="number" min={1} max={500} placeholder="Position" value={kw.position} onChange={(e) => setKw({ ...kw, position: e.target.value })} />
          <input aria-label="Checked on" type="date" value={kw.checkedAt} onChange={(e) => setKw({ ...kw, checkedAt: e.target.value })} />
          <button type="submit" className="btn ghost">Add keyword</button>
        </form>
      </section>

      <section>
        <h3>Google Business Profile</h3>
        <p className="hq-muted">
          {p?.gbpRating != null ? `★ ${p.gbpRating} · ${p.gbpReviewCount ?? 0} reviews` : "No rating recorded"}
          {p?.gbpUnansweredReviews ? ` · ${p.gbpUnansweredReviews} unanswered` : ""}{" "}
          {p?.gbpUrl ? (
            p.gbpLastPostAt && daysAgo(p.gbpLastPostAt, now) > 7
              ? <span className="hq-chip stale">no post in {daysAgo(p.gbpLastPostAt, now)} days</span>
              : <Freshness at={p.gbpLastPostAt} maxDays={7} now={now} verb="posted" />
          ) : null}
        </p>
        <form className="hq-form" onSubmit={saveGbp}>
          <div className="hq-form-grid">
            <label className="wide">Profile link<input value={gbp.gbpUrl} onChange={(e) => setGbp({ ...gbp, gbpUrl: e.target.value })} placeholder="https://g.page/…" /></label>
            <label>Rating<input type="number" step="0.1" min={0} max={5} value={gbp.gbpRating} onChange={(e) => setGbp({ ...gbp, gbpRating: e.target.value })} /></label>
            <label>Reviews<input type="number" min={0} value={gbp.gbpReviewCount} onChange={(e) => setGbp({ ...gbp, gbpReviewCount: e.target.value })} /></label>
            <label>Unanswered reviews<input type="number" min={0} value={gbp.gbpUnansweredReviews} onChange={(e) => setGbp({ ...gbp, gbpUnansweredReviews: e.target.value })} /></label>
            <label>Last post<input type="date" value={gbp.gbpLastPostAt} onChange={(e) => setGbp({ ...gbp, gbpLastPostAt: e.target.value })} /></label>
            <label>Last photo<input type="date" value={gbp.gbpLastPhotoAt} onChange={(e) => setGbp({ ...gbp, gbpLastPhotoAt: e.target.value })} /></label>
          </div>
          <div className="hq-form-actions"><button type="submit" className="btn">Save</button>{msg ? <span className="hq-muted">{msg}</span> : null}</div>
        </form>
      </section>
    </div>
  );
}

// ---------- Social media ----------

const PLATFORM_LABEL: Record<string, string> = {
  facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok", linkedin: "LinkedIn", youtube: "YouTube",
  x: "X", snapchat: "Snapchat", google_business: "Google Business", other: "Other",
};

function SocialTab({ data, now, onChanged }: { data: HqBusinessDetail; now: Date; onChanged: () => void }) {
  const [draft, setDraft] = useState<(Partial<HqSocial> & { platform: string }) | null>(null);
  const [msg, setMsg] = useState("");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    try {
      await saveHqSocial(data.business.slug, draft);
      setDraft(null);
      onChanged();
    } catch (err) {
      setMsg(readableError(err));
    }
  }

  return (
    <div className="hq-stack">
      <section>
        <h3>Accounts</h3>
        {data.socials.length === 0 ? <p className="hq-empty">No social accounts recorded yet.</p> : (
          <ul className="hq-socials">
            {data.socials.map((s) => (
              <li key={s.id} className="hq-social">
                <div className="hq-social-head">
                  <strong>{PLATFORM_LABEL[s.platform] ?? s.platform}</strong>
                  {isHttpLink(s.url) ? <a href={s.url} target="_blank" rel="noreferrer noopener">{s.handle ?? s.url}</a> : <span>{s.handle ?? s.url ?? "—"}</span>}
                </div>
                <div className="hq-social-meta">
                  {s.source === "connected" ? <span className="hq-chip fresh">Connected to Nexus</span> : null}
                  {s.followers != null ? <span>{s.followers.toLocaleString()} followers</span> : null}
                  {s.lastPostAt ? <Freshness at={s.lastPostAt} maxDays={14} now={now} verb="posted" /> : null}
                  {s.twoFactor === false ? <span className="hq-chip stale">No 2FA</span> : s.twoFactor ? <span className="hq-chip fresh">2FA on</span> : null}
                  {s.recoveryContact ? <span className="hq-muted">Recovery: {s.recoveryContact}</span> : null}
                </div>
                <div className="hq-vault-actions">
                  <button type="button" className="btn ghost" onClick={() => setDraft({ ...s })}>{s.source === "connected" ? "Record details" : "Edit"}</button>
                  {s.source === "recorded" ? <button type="button" className="btn ghost danger" onClick={() => deleteHqSocial(data.business.slug, s.id).then(onChanged)}>Remove</button> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {draft ? (
          <form className="hq-form" onSubmit={save}>
            <div className="hq-form-grid">
              <label>Platform
                <select value={draft.platform} onChange={(e) => setDraft({ ...draft, platform: e.target.value })}>
                  {Object.entries(PLATFORM_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
              </label>
              <label>Handle<input value={draft.handle ?? ""} onChange={(e) => setDraft({ ...draft, handle: e.target.value })} placeholder="@handle" /></label>
              <label>Profile link<input value={draft.url ?? ""} onChange={(e) => setDraft({ ...draft, url: e.target.value })} /></label>
              <label>Followers<input type="number" min={0} value={draft.followers ?? ""} onChange={(e) => setDraft({ ...draft, followers: e.target.value ? Number(e.target.value) : null })} /></label>
              <label>Last post<input type="date" value={dateInput(draft.lastPostAt ?? null)} onChange={(e) => setDraft({ ...draft, lastPostAt: e.target.value || null })} /></label>
              <label>Two-factor sign-in
                <select value={draft.twoFactor == null ? "" : String(draft.twoFactor)} onChange={(e) => setDraft({ ...draft, twoFactor: e.target.value === "" ? null : e.target.value === "true" })}>
                  <option value="">Not sure</option><option value="true">On</option><option value="false">Off</option>
                </select>
              </label>
              <label className="wide">Recovery email / phone<input value={draft.recoveryContact ?? ""} onChange={(e) => setDraft({ ...draft, recoveryContact: e.target.value })} /></label>
            </div>
            <div className="hq-form-actions"><button type="submit" className="btn">Save</button><button type="button" className="btn ghost" onClick={() => setDraft(null)}>Cancel</button>{msg ? <span className="hq-muted">{msg}</span> : null}</div>
          </form>
        ) : (
          <button type="button" className="btn ghost hq-add" onClick={() => setDraft({ platform: "instagram" })}>+ Add an account</button>
        )}
      </section>
      <section>
        <h3>Social media logins</h3>
        <VaultPanel slug={data.business.slug} entries={data.vault} configured={data.vaultConfigured} unlockedSeconds={data.unlockedSeconds} section="social" now={now} onChanged={onChanged} />
      </section>
    </div>
  );
}

// ---------- Access log ----------

function RevealLog({ data }: { data: HqBusinessDetail }) {
  return (
    <section className="hq-log">
      <h3>Who looked at a password</h3>
      {data.reveals.length === 0 ? <p className="hq-empty">No password has been revealed yet.</p> : (
        <table className="hq-table">
          <thead><tr><th>When</th><th>Who</th><th>Login</th><th>From</th></tr></thead>
          <tbody>
            {data.reveals.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.revealedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                <td>{r.adminName ?? r.adminId}</td>
                <td>{r.service}</td>
                <td className="hq-muted">{r.ip ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
