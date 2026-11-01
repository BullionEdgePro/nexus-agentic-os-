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
