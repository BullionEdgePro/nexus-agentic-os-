import type { ConnectablePage } from "./facebook-onboarding.js";

/**
 * Which of the Pages a Facebook account manages belongs to this business, or
 * null when that cannot be told (audit, 4 Nov 2026).
 *
 * The connect used to save whichever Page Meta listed first: an admin whose
 * account manages several businesses' Pages could connect one business's Page as
 * another's channel, and its Messenger customers landed in the wrong inbox to be
 * answered by the wrong agent. Now: the only Page that fits (for Instagram, the
 * only one with an Instagram account), else the one Page named for the business,
 * else nothing — the caller refuses and lists the Pages rather than guess.
 */
export function chooseFacebookPage(
  pages: ConnectablePage[],
  businessName: string,
  target: "facebook" | "instagram"
): ConnectablePage | null {
  const fits = target === "instagram" ? pages.filter((page) => page.instagram) : pages;
  if (fits.length === 1) return fits[0];
  const wanted = plain(businessName);
  if (!wanted) return null;
  const named = fits.filter((page) => {
    const name = plain(page.name);
    return name.length > 0 && (name.includes(wanted) || wanted.includes(name));
  });
  return named.length === 1 ? named[0] : null;
}

function plain(text: string): string {
  return (text ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
