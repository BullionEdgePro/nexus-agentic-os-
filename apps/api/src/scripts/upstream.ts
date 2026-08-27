/**
 * Telling "the platform is broken" from "the vendor is down".
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * On 2026-08-27, twice within twenty minutes, `verify-all.sh` reported:
 *
 *   self-check        FAIL
 *   retrieval-check   FAIL
 *
 * Google's generative API was returning 503 UNAVAILABLE. Nothing was wrong with
 * this platform, and the only way to know that was to open the output file and
 * read a stack trace by hand. On the summary line those two were
 * indistinguishable from a real defect in the reply path.
 *
 * That is the failure mode this codebase keeps meeting, arriving at the one
 * place whose entire job is to be believed. A gate that goes red for a reason
 * the reader cannot act on teaches them to re-run rather than to read — and a
 * suite people re-run until it is green is not a suite.
 *
 * ============================================================
 * WHY IT IS NOT A PASS EITHER
 * ============================================================
 *
 * The obvious fix is to swallow the outage and carry on green. That is worse.
 * Retrieval quality genuinely WAS NOT CHECKED on those runs, and a summary that
 * says "All gates pass" after checking nothing is the same sentence
 * `/health/jobs` refused to say when it could not read the queues:
 *
 *   "I could not check" is not "nothing is wrong", and the two must not answer
 *   a monitor alike.
 *
 * So there are three outcomes, not two. The third is loud, it is named, and it
 * suppresses the "All gates pass" line — which is the whole point, because that
 * line is what a deploy is signed off on.
 *
 * ============================================================
 * WHAT COUNTS
 * ============================================================
 *
 * Only the provider being unable to answer: 503, 429, 502/504, and the
 * transport-level failures that mean the request never landed. NOT a 400, a 401
 * or a 403 — a malformed request, an expired key or a revoked permission are
 * this platform's problems and must stay red.
 */

/** Exit code for "could not be checked because the model provider was down". */
export const EXIT_UPSTREAM_UNAVAILABLE = 75;

/**
 * Is this error the vendor failing to answer, rather than us asking wrongly?
 *
 * Deliberately narrow. Every widening here converts a real defect into a shrug,
 * and the cost of being wrong in that direction is a broken reply path that
 * reports itself as somebody else's outage.
 */
export function isUpstreamUnavailable(err: unknown): boolean {
  const status = readStatus(err);
  if (status !== null) {
    // 429 is included and it is the arguable one. A rate limit is the provider
    // declining to serve us right now; the reply path already treats it as
    // transient and retries, and `stale.ts` draws the same line for indexing.
    return status === 429 || status === 502 || status === 503 || status === 504;
  }

  // No status at all: the request did not reach anyone. `fetch` rejects with a
  // bare TypeError, and Node surfaces DNS and socket failures by code.
  const code = typeof err === "object" && err !== null ? String((err as { code?: unknown }).code ?? "") : "";
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) {
    return true;
  }

  // Last resort, on the message. Kept because the Google SDK wraps its own
  // errors and the status is not always where the type says it is -- the
  // 2026-08-27 outage arrived as an ApiError whose message was a JSON blob
  // containing "UNAVAILABLE". Anchored on the vendor's own status words rather
  // than on anything as loose as "unavailable" appearing anywhere.
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /"status"\s*:\s*"(UNAVAILABLE|RESOURCE_EXHAUSTED)"/.test(message);
}

function readStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const candidate = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const value of [candidate.status, candidate.response?.status, candidate.code]) {
    if (typeof value === "number" && value >= 100 && value < 600) return value;
  }
  return null;
}

/**
 * The sentence a gate prints before standing down.
 *
 * It says what was NOT checked, because that is the part a person reading a
 * green-looking run needs and the part an outage message would otherwise omit.
 */
export function upstreamNotice(gate: string, whatWasNotChecked: string, err: unknown): string {
  const detail = err instanceof Error ? err.message.split("\n")[0].slice(0, 200) : String(err);
  return [
    "",
    `UNVERIFIED — ${gate} could not run because the model provider did not answer.`,
    `  ${detail}`,
    `  ${whatWasNotChecked} is UNCHECKED by this run. Nothing here says it is working,`,
    "  and nothing here says it is broken. Re-run when the provider is back.",
  ].join("\n");
}
