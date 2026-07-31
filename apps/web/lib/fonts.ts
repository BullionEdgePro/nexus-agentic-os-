import { Bricolage_Grotesque, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";

// Bricolage Grotesque: a bold, characterful grotesque used sparingly for
// headlines and big numerals — the "nameplate" face.
export const fontDisplay = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["600", "700", "800"],
});

// IBM Plex Sans: designed by IBM specifically for technical documentation —
// a genuinely on-brief body face for an operations console styled as a
// technical drawing, not a "safe default."
export const fontBody = IBM_Plex_Sans({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "500", "600"],
});

// IBM Plex Mono: spec-sheet labels, plate annotations, tabular data.
export const fontMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500"],
});

export const fontVariables = `${fontDisplay.variable} ${fontBody.variable} ${fontMono.variable}`;
