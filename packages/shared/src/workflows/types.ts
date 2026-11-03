/**
 * The workflow audit's shapes (2 Nov 2026). A workflow is a business's own
 * drawing of how its work should flow — for SFS International, the boss's
 * 20-step "AI agent workflow" — and the audit is what Nexus can show of it
 * from real data. Spec: docs/superpowers/specs/2026-11-02-sfs-audit-design.md
 */

/** What Nexus does for a step: all of it, part of it, or nothing yet. */
export type Coverage = "built" | "partly" | "not_tracked";

/** A step's status for a period, from its coverage and its activity. */
export type StepStatus = "working" | "idle" | "partly" | "not_tracked";

export type Lane = "supply" | "demand";

/** The only periods the audit is read for. */
export type AuditDays = 7 | 30 | 90;

/** What the audit endpoint answers (spec §7.4). */
export type WorkflowAudit = {
  business: { slug: string; name: string; timezone: string };
  period: { days: AuditDays; from: string; today: string; bucket: "day" | "week" };
  evidence: {
    /** optedOut: of re-engagement; emailOptedOut: of campaign emails (spec §6). */
    contacts: { total: number; added: number; withSource: number; optedOut: number; notACustomer: number; emailOptedOut: number };
    outreach: { sent: number; delivered: number; failed: number };
    calls: { answered: number; noAnswer: number; voicemail: number; busy: number; failed: number };
    reengagement: { sent: number; replied: number; optedOut: number; inCooldown: number };
    leads: { total: number; pitches: number; byChannel: Record<string, number>; bySource: { source: string; count: number }[] };
    qualifier: { scored: number; hot: number };
    replies: { medianMs: number | null; byAi: number; byPerson: number; unanswered: number };
    viewings: { booked: number; held: number; noShow: number; cancelled: number };
    won: number;
    followUps: { created: number; done: number; openNow: number; overdueNow: number };
    /** Cards created on or moved into each step on the workflow board in the period (3 Nov 2026). */
    board: Record<string, number>;
    /** Counts of now: open units on S9 or S10, and how many of their permits lapsed before today. */
    permits: { advertised: number; expired: number };
  };
  series: {
    leads: { bucket: string; count: number }[];
    replyMedian: { bucket: string; medianMs: number | null }[];
    quality: { bucket: string; scored: number; hot: number }[];
    viewings: { bucket: string; booked: number; held: number; noShow: number; cancelled: number }[];
  };
  funnel: { leads: number; scored: number; hot: number; booked: number; held: number; won: number };
};

export type Evidence = WorkflowAudit["evidence"];

export type WorkflowStep = {
  /** "S1"…"S10" on the supply lane, "D1"…"D10" on the demand lane. */
  id: string;
  lane: Lane;
  /** The boss's words, unchanged: tag, name, subtitle. */
  tag: string;
  name: string;
  subtitle: string;
  coverage: Coverage;
  /** What Nexus does for the step ("" for a step it does not track). */
  does: string;
  /** What is missing, or what tracking it would need; null when nothing is. */
  missing: string | null;
  /** How much happened in the period — only for a built step. */
  activity: ((e: Evidence) => number) | null;
  /** The screen that holds the detail, if one exists. */
  link: { href: string; label: string } | null;
  /** The steps an arrow leads to, with the boss's label on a branch. */
  next: { to: string; label?: string }[];
};

export type Workflow = { id: "real-estate"; title: string; steps: WorkflowStep[] };
