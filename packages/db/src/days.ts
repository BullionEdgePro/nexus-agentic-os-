/**
 * A run of days with nothing missing (2 Nov 2026, Cream pages 2a). A day with
 * no conversations has no row in the rollup; a chart that skipped it would
 * join Monday straight to Wednesday and hide the quiet day. Pure; days are
 * `YYYY-MM-DD`, counted in UTC so no clock change skips or repeats one.
 */
export function zeroFillDays(
  rows: Array<{ day: string; conversations: number }>,
  endDay: string,
  days: number
): Array<{ day: string; conversations: number }> {
  const byDay = new Map(rows.map((r) => [r.day.slice(0, 10), r.conversations]));
  const end = Date.parse(`${endDay}T00:00:00Z`);
  const out: Array<{ day: string; conversations: number }> = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day, conversations: byDay.get(day) ?? 0 });
  }
  return out;
}
