import type { HqCard, HqSeverity } from "@/lib/api";

/**
 * Business HQ, every business at once (spec 2026-10-14-business-hq-design.md §3.1).
 *
 * Presentational and pure so it renders the same on the server, in tests and
 * in the browser. Worst score first, so the business that needs you is the
 * first thing you see.
 */
export function scoreTone(score: number): "good" | "warn" | "crit" {
  if (score >= 80) return "good";
  if (score >= 50) return "warn";
  return "crit";
}

const SEVERITY_LABEL: Record<HqSeverity, string> = { critical: "Critical", warning: "Warning", notice: "Notice" };

const hostOf = (url: string | null) => {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** A ring that fills to the score: 100 is a full circle. */
export function ScoreRing({ score, size = 64 }: { score: number; size?: number }) {
  const r = 26;
  const circumference = 2 * Math.PI * r;
  const filled = (Math.max(0, Math.min(100, score)) / 100) * circumference;
  return (
    <svg className={`hq-ring ${scoreTone(score)}`} width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={`Health ${score} out of 100`}>
      <circle className="hq-ring-track" cx="32" cy="32" r={r} />
      <circle
        className="hq-ring-fill"
        cx="32"
        cy="32"
        r={r}
        strokeDasharray={`${filled} ${circumference}`}
        transform="rotate(-90 32 32)"
      />
      <text x="32" y="37" textAnchor="middle" className="hq-ring-text">{score}</text>
    </svg>
  );
}

export function HqOverview({ businesses }: { businesses: HqCard[] }) {
  const sorted = [...businesses].sort((a, b) => a.score - b.score);
  return (
    <ul className="hq-cards">
      {sorted.map((b) => {
        const host = hostOf(b.websiteUrl);
        const more = b.issueCount - b.topIssues.length;
        return (
          <li key={b.slug} className={`hq-card tone-${scoreTone(b.score)}`}>
            <a href={`/deck/hq/${b.slug}`} className="hq-card-link">
              <div className="hq-card-head">
                {b.logoUrl ? (
                  <img src={b.logoUrl} alt="" className="hq-logo" width={40} height={40} />
                ) : (
                  <span className="hq-logo hq-logo-initial" aria-hidden>{b.name.slice(0, 1)}</span>
                )}
                <div className="hq-card-name">
                  <strong>{b.name}</strong>
                  {host ? <span className="hq-host">{host}</span> : <span className="hq-host">No website recorded</span>}
                </div>
                <ScoreRing score={b.score} />
              </div>
              {b.topIssues.length === 0 ? (
                <p className="hq-allclear">All clear — nothing needs you here.</p>
              ) : (
                <ul className="hq-issues">
                  {b.topIssues.map((i) => (
                    <li key={i.code} className={`hq-issue sev-${i.severity}`}>
                      <span className="hq-sev" aria-label={SEVERITY_LABEL[i.severity]} />
                      {i.title}
                    </li>
                  ))}
                  {more > 0 ? <li className="hq-more">+{more} more</li> : null}
                </ul>
              )}
              <span className="hq-open">Open {b.name} →</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
