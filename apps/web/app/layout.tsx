import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nexus Unified Inbox",
  description: "Multi-tenant WhatsApp Business inbox for the Nexus Agentic OS.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="h-screen bg-neutral-950 text-neutral-100">{children}</body>
    </html>
  );
}
