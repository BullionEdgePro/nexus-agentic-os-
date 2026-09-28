import type { Metadata } from "next";
import "./globals.css";
import { THEME_BOOT } from "@/lib/theme";

// `/` is the public front page now, so this title is what shows in search
// results and shared links — it has to name the product rather than the
// operator's inbox screen.
export const metadata: Metadata = {
  metadataBase: new URL("https://nexusagenticos.com"),
  title: {
    default: "Nexus Agentic OS — one console for every WhatsApp conversation",
    template: "%s · Nexus Agentic OS",
  },
  description:
    "Five UAE businesses share one WhatsApp number. Nexus classifies each enquiry, routes it to the right business, and holds every AI reply to that business's governance policy before it sends.",
  openGraph: {
    type: "website",
    url: "https://nexusagenticos.com",
    siteName: "Nexus Agentic OS",
    title: "Nexus Agentic OS — one console for every WhatsApp conversation",
    description:
      "One WhatsApp number, five businesses. Every reply is routed, checked and logged before it reaches a customer.",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: THEME_BOOT sets data-theme on <html> before React
    // hydrates, so the server's attribute-less tag is expected to differ.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Before first paint — a dark console must never flash white. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="h-screen bg-sky-50 text-slate-900">{children}</body>
    </html>
  );
}
