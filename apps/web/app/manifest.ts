import type { MetadataRoute } from "next";

/**
 * Nexus as an installable app (spec 2026-10-09-nexus-mobile-app-design.md).
 *
 * Served by Next at /manifest.webmanifest. It opens on the inbox, because on a
 * phone that is the only screen anyone installs it for, and standalone, with
 * no browser bar. The Android download (Bubblewrap) is generated from this same
 * file, so its name, icon and colours come from here too.
 *
 * Colours are the console's Clear Sky tokens: --signal for the theme, so the
 * status bar and task switcher match the app, and --marble for the splash
 * ground.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/inbox",
    name: "Nexus",
    short_name: "Nexus",
    description: "Your Nexus inbox: WhatsApp, email, Facebook and Instagram chats, with alerts for your own.",
    start_url: "/inbox",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    theme_color: "#0873c9",
    background_color: "#f3f8fd",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
