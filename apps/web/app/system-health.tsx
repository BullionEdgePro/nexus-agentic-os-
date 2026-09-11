"use client";

import { useEffect, useState } from "react";
import { getJobsHealth, type JobsHealth } from "@/lib/api";

/**
 * Is the background half of the platform alive — at a glance, on the console.
 *
 * The deck already shows whether DATA is flowing (the "Live data" and "Webhook
 * connected" pills). It said nothing about whether the SWEEPS are running: the
 * operators that answer a waiting customer, the scheduled sends, the daily jobs.
 * Those fail silently by nature — a stopped sweep looks exactly like a quiet
 * platform — which is the single failure mode this codebase keeps rediscovering.
 * `/health/jobs` already knows the answer; this puts it where the owner looks.
 *
 * Three states, and the third is not the second. "Healthy" and "N issues" are
 * both the endpoint answering; "Health unknown" is the endpoint not answering,
 * which is news about this check rather than about the schedule — the same
 * distinction /health/jobs itself draws with `queuesUnreadable`.
 */
export function SystemHealth() {
  const [health, setHealth] = useState<JobsHealth | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () =>
      getJobsHealth()
        .then((h) => {
          if (!live) return;
          setHealth(h);
          setFailed(false);
        })
        .catch(() => {
          // Recorded, not swallowed: an unreachable check must not read as a
          // healthy one. It reads as "unknown", which is the truth.
          if (live) setFailed(true);
        });
    load();
    // A minute is often enough: these jobs run on ten-minute-plus cadences, so
    // polling faster only spends requests to learn the same thing.
    const id = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  if (failed) {
    return (
      <span className="pill" title="The health endpoint could not be reached — the API may be down or restarting.">
        <span className="dot warnd" />
        Health unknown
      </span>
    );
  }
  if (!health) {
    return (
      <span className="pill">
        <span className="dot" />
        Checking…
      </span>
    );
  }
  if (health.ok) {
    return (
      <span className="pill" title="Every scheduled job ran on time and no queue is backed up.">
        <span className="dot live" />
        Systems healthy
      </span>
    );
  }

  // Degraded — name exactly what, so the pill is a lead rather than an alarm.
  const problems = [
    ...health.stalled.map((job) => `${job} stalled`),
    ...health.failing.map((queue) => `${queue} failing`),
    ...health.backedUp.map((queue) => `${queue} backed up`),
    ...(health.queuesUnreadable ? ["queue status unreadable"] : []),
  ];
  const n = problems.length;
  return (
    <span className="pill" title={problems.join(" · ") || "A background check reported a problem."}>
      <span className="dot warnd" />
      {n} {n === 1 ? "issue" : "issues"} in background jobs
    </span>
  );
}
