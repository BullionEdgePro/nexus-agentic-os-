/**
 * Where to go after signing in, and why the person is signing in again
 * (5 Nov 2026).
 *
 * A screen whose sign-in has ended sends its person to the front page's sign-in
 * with `next` (where they were) and `signed-out` (why). Signing in takes them
 * straight back. Only the console's own screens are accepted as `next`: a link
 * that could send a just-signed-in person to another site is a phishing tool.
 */

const SCREENS = /^\/(deck|inbox)(\/|\?|$)/;

/** The screen to return to, or null when there is none or it is not ours. */
export function returnPath(search: string): string | null {
  const next = new URLSearchParams(search).get("next");
  if (!next || !SCREENS.test(next)) return null;
  return next;
}

export type SignedOutReason = "ended" | "removed";

/** Why the person was sent to sign in, when a screen said. */
export function signedOutReason(search: string): SignedOutReason | null {
  const why = new URLSearchParams(search).get("signed-out");
  return why === "ended" || why === "removed" ? why : null;
}

/** The sign-in address for a screen whose sign-in has ended. */
export function signInAgainUrl(path: string, why: SignedOutReason): string {
  const params = new URLSearchParams({ "signed-out": why });
  if (SCREENS.test(path)) params.set("next", path);
  return `/?${params.toString()}#signin`;
}
