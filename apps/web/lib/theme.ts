/**
 * The light / dark choice — shared by the switch (app/theme-toggle.tsx) and the
 * root layout, which runs THEME_BOOT inline before first paint.
 *
 * A plain module on purpose: a string exported from a "use client" file reaches
 * a server component as a client reference, not as the string.
 */
import { RAIL_FROM_KEY, RAIL_KEY } from "./rail";

export const THEME_KEY = "nexus-theme";

/**
 * Inline, blocking, before paint. Kept tiny and wrapped: storage can throw.
 * Also applies a shrunk dock (lib/rail.ts), so the page never jumps from the
 * full dock to the icon one after it has drawn — and, arriving from the dock,
 * holds back the current link's own marker so the pill can slide in to it.
 */
export const THEME_BOOT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="dark"||t==="light"){document.documentElement.setAttribute("data-theme",t)}}catch(e){}try{if(localStorage.getItem("${RAIL_KEY}")==="icons"){document.documentElement.setAttribute("data-rail","icons")}}catch(e){}try{if(sessionStorage.getItem("${RAIL_FROM_KEY}")){document.documentElement.setAttribute("data-rail-from","1")}}catch(e){}`;

/**
 * The public pages only — the storefront and /admin (spec
 * 2026-11-02-storefront-cream-design.md §1). With no saved choice they follow
 * the visitor's device into Warm Night; the console keeps its own default,
 * light. Runs after THEME_BOOT, which has already applied a saved choice.
 *
 * The system's dark is applied, never saved: the visitor has not chosen it.
 * Blocked storage counts as nothing saved. A script rather than a
 * prefers-color-scheme media query, which would copy the whole Warm Night
 * token block a second time.
 */
export const PUBLIC_THEME_BOOT = `var s=null;try{s=localStorage.getItem("${THEME_KEY}")}catch(e){}try{if(s!=="dark"&&s!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches){document.documentElement.setAttribute("data-theme","dark")}}catch(e){}`;

/**
 * On signing in from a public page. Signing in is a soft refresh, so a dark
 * the public boot took from the device would follow the visitor into the
 * console; with nothing saved, the console opens light, as it always has.
 */
export function forgetSystemTheme(): void {
  let saved: string | null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    // Blocked storage: whatever shows now is all this visit has — leave it.
    return;
  }
  if (saved !== "dark" && saved !== "light") document.documentElement.removeAttribute("data-theme");
}
