import { AMENITY_WORDS, whatsappLink } from "@nexus/shared";
import { InterestButton, ViewBeacon } from "./interest-button";

/**
 * What a buyer sees on a pocket listing's private link (7 Nov 2026): the
 * listing, who it was shared with, the agent with their BRN, the agency's ORN,
 * the Trakheesi permit, how long the link works. Never the building, the unit's
 * reference, the owner or the notes — the API never sends them.
 * Spec: docs/superpowers/specs/2026-11-07-pocket-listings-design.md §5
 */

export type PocketView = {
  businessName: string;
  recipientFirstName: string | null;
  title: string;
  description: string;
  purpose: "rent" | "sale";
  priceAed: number;
  propertyType: string;
  bedrooms: number | null;
  bathrooms: number | null;
  sizeSqft: number;
  furnishing: string | null;
  community: string;
  subCommunity: string | null;
  amenities: string[];
  availableFrom: string | null;
  photoIds: string[];
  agent: { name: string; firstName: string; brn: string; whatsapp: string | null };
  orn: string;
  permitNumber: string;
  expiresAt: string;
};

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const word = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replaceAll("_", " ");
const FURNISHING: Record<string, string> = { furnished: "Furnished", semi_furnished: "Semi-furnished", unfurnished: "Unfurnished" };
const date = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dubai" });

export function PocketListing({ view, token, apiUrl }: { view: PocketView; token: string; apiUrl: string }) {
  const price = `AED ${Math.round(view.priceAed).toLocaleString("en-US")}${view.purpose === "rent" ? " a year" : ""}`;
  const place = view.subCommunity ? `${view.subCommunity}, ${view.community}` : view.community;
  const facts = [
    word(view.propertyType),
    view.bedrooms !== null ? count(view.bedrooms, "bedroom", "bedrooms") : null,
    view.bathrooms !== null ? count(view.bathrooms, "bathroom", "bathrooms") : null,
    `${view.sizeSqft.toLocaleString("en-US")} sq ft`,
    view.furnishing ? FURNISHING[view.furnishing] ?? word(view.furnishing) : null,
  ].filter((f): f is string => !!f);
  const whatsapp = whatsappLink(view.agent.whatsapp, `Hi, about the private listing "${view.title}"`);
  return (
    <article className="pocket-card">
      <ViewBeacon token={token} apiUrl={apiUrl} />
      <header className="pocket-head">
        <p className="pocket-business">{view.businessName}</p>
        <p className="pocket-private">{view.recipientFirstName ? `Private listing — shared with ${view.recipientFirstName}` : "Private listing"}</p>
        <p className="pocket-note">Please keep it to yourself.</p>
      </header>

      <div className="pocket-photos">
        {view.photoIds.map((id, i) => (
          // eslint-disable-next-line @next/next/no-img-element -- photos come from the API, one link's own address
          <img
            key={id}
            src={`${apiUrl}/pocket-shares/${token}/photos/${id}.jpg`}
            alt={`Photo ${i + 1} of ${view.photoIds.length}`}
            loading={i === 0 ? "eager" : "lazy"}
            referrerPolicy="no-referrer"
          />
        ))}
      </div>

      <h1 className="pocket-title" dir="auto">
        {view.title}
      </h1>
      <p className="pocket-price">{price}</p>
      <p className="pocket-place">{place}</p>
      <ul className="pocket-facts">
        {facts.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <p className="pocket-description" dir="auto">
        {view.description}
      </p>
      {view.amenities.length > 0 ? (
        <ul className="pocket-amenities">
          {view.amenities.map((a) => (
            <li key={a}>{AMENITY_WORDS[a as keyof typeof AMENITY_WORDS] ?? word(a)}</li>
          ))}
        </ul>
      ) : null}
      {view.availableFrom ? <p className="pocket-note">Available from {date(view.availableFrom)}</p> : null}

      <section className="pocket-agent">
        <p className="pocket-agent-name">{view.agent.name}</p>
        <p className="pocket-licence">BRN {view.agent.brn}</p>
        <p className="pocket-licence">
          {view.businessName} · ORN {view.orn}
        </p>
        <p className="pocket-licence">Trakheesi permit {view.permitNumber}</p>
      </section>

      <div className="pocket-actions">
        <InterestButton token={token} apiUrl={apiUrl} agentFirstName={view.agent.firstName} />
        {whatsapp ? (
          <a className="pocket-button quiet" href={whatsapp} target="_blank" rel="noopener noreferrer">
            WhatsApp {view.agent.firstName}
          </a>
        ) : null}
      </div>
      <p className="pocket-note">Available until {date(view.expiresAt)}</p>
    </article>
  );
}

export function Unavailable() {
  return (
    <article className="pocket-card">
      <p className="pocket-gone">This private listing is no longer available. Ask the agent who sent it.</p>
    </article>
  );
}
