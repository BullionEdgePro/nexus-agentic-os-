/**
 * A voice note's waveform (2 Nov 2026): the loudness sampled while recording,
 * folded into a fixed number of bars and scaled so the loudest is 100. Sent
 * with the note, so a colleague's screen draws the real shape at once without
 * downloading and decoding the audio. Pure.
 */
export function foldPeaks(levels: number[], bars = 64): number[] {
  if (levels.length === 0) return new Array(bars).fill(0);
  const folded: number[] = [];
  for (let i = 0; i < bars; i += 1) {
    const from = Math.floor((i * levels.length) / bars);
    const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / bars));
    let peak = 0;
    for (let j = from; j < to && j < levels.length; j += 1) peak = Math.max(peak, Math.abs(levels[j] ?? 0));
    folded.push(peak);
  }
  const loudest = Math.max(...folded);
  if (loudest <= 0) return new Array(bars).fill(0);
  return folded.map((v) => Math.min(100, Math.max(0, Math.round((v / loudest) * 100))));
}

/** m:ss, as WhatsApp shows a note's length. */
export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
