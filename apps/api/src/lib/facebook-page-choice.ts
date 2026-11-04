import type { ConnectablePage } from "./facebook-onboarding.js";

/**
 * Which of the Pages a Facebook account manages belongs to this business, or
 * null when that cannot be told (audit, 4 Nov 2026).
 *
 * The connect used to save whichever Page Meta listed first: an admin whose
 * account manages several businesses' Pages could connect one business's Page as
 * another's channel, and its Messenger customers landed in the wrong inbox to be
 * answered by the wrong agent. Now, among the Pages that fit (for Instagram, the
 * ones with an Instagram account): a Page named exactly for the business, else
 * the one Page carrying every word of its name, else -- only when the account
 * manages a single Page at all -- that Page. Anything else is null, and the
 * caller refuses and lists the Pages rather than guess. Words are whole words,
 * so "ABR" never matches "Fabric".
 */
export function chooseFacebookPage(
  pages: ConnectablePage[],
  businessName: string,
  target: "facebook" | "instagram"
): ConnectablePage | null {
  const fits = target === "instagram" ? pages.filter((page) => page.instagram) : pages;
  const wanted = words(businessName);
  if (wanted.length > 0) {
    const exact = fits.filter((page) => words(page.name).join(" ") === wanted.join(" "));
    if (exact.length === 1) return exact[0];
    const named = fits.filter((page) => {
      const has = new Set(words(page.name));
      return wanted.every((word) => has.has(word));
    });
    if (named.length === 1) return named[0];
  }
  // An account with one Page has nothing to confuse it with.
  return pages.length === 1 && fits.length === 1 ? fits[0] : null;
}

function words(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}
