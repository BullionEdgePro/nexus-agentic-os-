/**
 * Turning a user-agent string into something a person recognises.
 *
 * ============================================================
 * WHAT THIS IS FOR
 * ============================================================
 *
 * A sign-in record showing only a date answers "is this account still in use".
 * It cannot answer the question somebody actually asks when they look at it:
 * "was that me?" For that they need to recognise the thing that signed in, and
 * nobody recognises
 *
 *   Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like
 *   Gecko) Chrome/141.0.0.0 Safari/537.36
 *
 * whereas everybody recognises "Chrome on Windows".
 *
 * ============================================================
 * WHY THE PARSED LABEL IS WHAT GETS STORED
 * ============================================================
 *
 * The raw string is a fingerprint. Version, build, platform and locale together
 * identify one person's exact browser across services, and it is kept in a row
 * that is read by anybody who can see the team screen. The label answers the
 * question being asked and forgets the rest, which is the point.
 *
 * ============================================================
 * DELIBERATELY CRUDE
 * ============================================================
 *
 * No UA-parsing library and no attempt at completeness. This is read by a human
 * deciding "yes that was me" or "no it was not", and for that a wrong guess is
 * worse than an honest shrug -- "Unrecognised device" prompts a second look,
 * while a confidently wrong "Chrome on Windows" ends the question.
 *
 * ORDER MATTERS AND IS NOT ALPHABETICAL. Every Chromium browser claims Safari,
 * Edge claims Chrome, and Chrome on iOS claims all three, so the most specific
 * claim has to be tested first. Getting this backwards labels every Edge user
 * as Chrome, which is exactly the wrong-but-plausible answer above.
 */

const MAX_LABEL = 60;

/** Browsers, most specific claim first. */
const BROWSERS: Array<[RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bCriOS\//, "Chrome"],
  [/\bFxiOS\//, "Firefox"],
  [/\bFirefox\//, "Firefox"],
  [/\bChrome\//, "Chrome"],
  [/\bSafari\//, "Safari"],
];

/** Platforms, likewise: iPadOS reports as Macintosh on newer iPads. */
const PLATFORMS: Array<[RegExp, string]> = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows NT\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "Mac"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bLinux\b/, "Linux"],
];

/**
 * A short label for a user agent, or a stated unknown.
 *
 * Never throws and never returns an empty string: this is written during
 * sign-in, and a sign-in that fails because a header was strange would be a
 * worse outcome than an unlabelled one.
 */
export function describeDevice(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? "").trim();
  if (!ua) return "Unknown device";

  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  const platform = PLATFORMS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;

  // Said plainly rather than guessed at. A reader deciding "was that me?" is
  // better served by being told the platform does not recognise something than
  // by a plausible label that closes the question wrongly.
  if (!browser && !platform) return "Unrecognised device";
  if (!browser) return `Unrecognised browser on ${platform}`;
  if (!platform) return `${browser} on an unrecognised platform`;

  return `${browser} on ${platform}`.slice(0, MAX_LABEL);
}
