import { Manrope, IBM_Plex_Mono } from "next/font/google";

/**
 * Two faces, not three.
 *
 * The previous set was Bricolage Grotesque for headlines and IBM Plex Sans for
 * body — a characterful grotesque over a technical-documentation sans, chosen
 * for a theme built to look like a draughtsman's plate.
 *
 * The Instrument Face theme is built on a geometric humanist sans with wide
 * apertures and even stroke contrast, which one family covers across the whole
 * weight range: 800 carries the nameplate, 700 the headings, 600 the buttons
 * and subheads, 500 the card titles, 400 the running copy. A second display
 * face on top of that would be decoration rather than hierarchy.
 *
 * Manrope is the substitution the reference itself names for Gilroy, and it is
 * the closer of the two candidates: Inter is a UI grotesque with a much smaller
 * x-height difference between weights, so its bold does not carry a heading the
 * way a geometric face does.
 */
export const fontDisplay = Manrope({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["600", "700", "800"],
});

export const fontBody = Manrope({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "500", "600"],
});

/**
 * IBM Plex Mono: spec-sheet labels, severity pills, tabular figures, ids.
 *
 * DELIBERATELY KEPT. The reference is a landing-page system and has no mono at
 * all — it does not need one, because nothing on a landing page is a reading
 * instrument. This console is nothing else: every screen is a list of things
 * that are true right now, and the mono labels are what stop it reading as
 * marketing. Plex Mono is also genuinely cool-toned, so it sits on the new
 * marble ground without the warmth that made the old palette feel like paper.
 */
export const fontMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500"],
});

export const fontVariables = `${fontDisplay.variable} ${fontBody.variable} ${fontMono.variable}`;
