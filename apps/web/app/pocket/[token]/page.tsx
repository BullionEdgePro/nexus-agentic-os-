import type { Metadata } from "next";
import { fontVariables } from "@/lib/fonts";
import { PocketListing, Unavailable, type PocketView } from "./pocket-listing";
import "../../deck/deck.css";
import "../pocket.css";

/**
 * A pocket listing's private page (7 Nov 2026), opened by a buyer from the link
 * their agent sent — no sign-in. Read fresh on every request: the API checks
 * every rule each time (link revoked or expired, unit closed, no longer a
 * pocket, permit expired) and this page shows one sentence when any fails.
 * The title says nothing about the property, so a link preview shows nothing.
 * Spec: docs/superpowers/specs/2026-11-07-pocket-listings-design.md §5
 */

export const dynamic = "force-dynamic";
// Nothing but "Private listing" (final review): `absolute` skips the layout's
// title template, and an own Open Graph block replaces the layout's — Nexus's
// marketing would otherwise be the preview under every link an agent sends.
export const metadata: Metadata = {
  title: { absolute: "Private listing" },
  description: "A private property listing.",
  openGraph: { title: "Private listing", description: "A private property listing.", siteName: undefined, url: undefined },
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

async function load(token: string): Promise<PocketView | null> {
  try {
    const res = await fetch(`${API_URL}/pocket-shares/${encodeURIComponent(token)}`, { cache: "no-store" });
    return res.ok ? ((await res.json()) as PocketView) : null;
  } catch {
    return null;
  }
}

export default async function PocketPage({ params }: { params: { token: string } }) {
  const view = await load(params.token);
  return (
    <main className={`pocket-page ${fontVariables}`}>
      {view ? <PocketListing view={view} token={params.token} apiUrl={API_URL} /> : <Unavailable />}
    </main>
  );
}
