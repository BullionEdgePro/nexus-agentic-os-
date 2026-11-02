/**
 * How long a customer has waited, as a colour and as words (2 Nov 2026, Cream
 * pages 2a). The front page's "customers waiting" cards take the video's four
 * card colours by wait: forest under half an hour, mustard to two hours,
 * terracotta to a day, ink beyond. Pure.
 */
export type Tone = "mustard" | "forest" | "terra" | "ink" | "paper";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function waitTone(ms: number): Tone {
  if (ms < 30 * MIN) return "forest";
  if (ms < 2 * HOUR) return "mustard";
  if (ms < DAY) return "terra";
  return "ink";
}

export function formatWait(ms: number): string {
  if (ms < MIN) return "under a minute";
  if (ms < HOUR) return `${Math.floor(ms / MIN)} m`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.floor((ms % HOUR) / MIN);
    return m ? `${h} h ${m} m` : `${h} h`;
  }
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  return h ? `${d} d ${h} h` : `${d} d`;
}
