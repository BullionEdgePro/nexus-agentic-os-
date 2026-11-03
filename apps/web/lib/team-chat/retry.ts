/**
 * Fetch a team chat file again when it is not there YET (2 Nov 2026, final
 * review). A colleague's screen hears about a new photo the moment it is saved
 * — sometimes a moment before the save is visible to a second request — so a
 * 404 (or a dropped connection) is tried again after a short wait. A refusal
 * that will not change (403, 400) is not. Pure: the waits are passed in.
 */
type Answer = { ok: boolean; status: number };

const worthRetrying = (status: number) => status === 404 || status === 0 || status >= 500;

export async function fetchWithRetry<T extends Answer>(
  attempt: () => Promise<T>,
  delays: number[] = [400, 1000, 2000]
): Promise<T> {
  let last: T | null = null;
  for (let i = 0; i <= delays.length; i += 1) {
    try {
      last = await attempt();
    } catch {
      last = { ok: false, status: 0 } as T;
    }
    if (last.ok || !worthRetrying(last.status) || i === delays.length) return last;
    await new Promise((resolve) => setTimeout(resolve, delays[i]));
  }
  return last!;
}
