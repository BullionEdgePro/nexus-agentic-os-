import type { MetadataRoute } from "next";

/**
 * Nexus as an installable app (spec 2026-10-09-nexus-mobile-app-design.md).
 *
 * Served by Next at /manifest.webmanifest. It opens on the inbox, because on a
 * phone that is the only screen anyone installs it for, and standalone, with
 * no browser bar. The Android download (Bubblewrap) is generated from this same
 * file, so its name, icon and colours come from here too.
 *
 * Colours are the console's Cream tokens (1 Nov 2026): the dock's near-black
 * for the theme, so the status bar and task switcher match the app, and
 * --marble for the splash ground. The icons are the glass hexagon.
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
    theme_color: "#16140F",
    background_color: "#F3EFE8",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
