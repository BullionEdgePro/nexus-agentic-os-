/**
 * The light / dark choice — shared by the switch (app/theme-toggle.tsx) and the
 * root layout, which runs THEME_BOOT inline before first paint.
 *
 * A plain module on purpose: a string exported from a "use client" file reaches
 * a server component as a client reference, not as the string.
 */
export const THEME_KEY = "nexus-theme";

/** Inline, blocking, before paint. Kept tiny and wrapped: storage can throw. */
export const THEME_BOOT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="dark"||t==="light"){document.documentElement.setAttribute("data-theme",t)}}catch(e){}`;
