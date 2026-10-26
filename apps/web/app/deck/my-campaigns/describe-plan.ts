/**
 * How an email campaign will be paced, in words (26 Oct 2026):
 * "All 61 go out today" · "300 today, 120 tomorrow" · "… 50 on day 4".
 * Kept free of imports so the API's test suite can call it directly.
 */
export function describePlan(plan: number[]): string {
  if (plan.length === 0) return "Nobody to send to.";
  if (plan.length === 1) return `All ${plan[0]} go out today, a few seconds apart.`;
  const days = plan.map((n, day) =>
    day === 0 ? `${n} today` : day === 1 ? `${n} tomorrow` : day === 2 ? `${n} the day after` : `${n} on day ${day + 1}`
  );
  return `${days.join(", ")} — each mailbox sends a few hundred a day, so it isn't marked as spam.`;
}
