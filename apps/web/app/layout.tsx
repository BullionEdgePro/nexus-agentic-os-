import type { Metadata } from "next";
import "./globals.css";

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
    <html lang="en">
      <body className="h-screen bg-neutral-950 text-neutral-100">{children}</body>
    </html>
  );
}
