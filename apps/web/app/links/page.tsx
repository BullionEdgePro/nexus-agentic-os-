import type { Metadata } from "next";
import QRCode from "qrcode";
import { fontVariables } from "@/lib/fonts";
import { CopyButton } from "./copy-button";
import "../deck/deck.css";
import "./public-links.css";

/**
 * nexusagenticos.com/links — the page you send to whoever publishes.
 *
 * THE PROBLEM IT SOLVES. The links were only reachable from inside the deck,
 * behind an operator login. But the people who actually put them live are a web
 * designer, whoever runs an Instagram account, a printer — none of whom are
 * staff, and none of whom will ever have an account here. Handing them a link
 * meant an operator copying five URLs into an email by hand, so in practice
 * nobody was handed anything and four businesses stayed at zero customers.
 *
 * This is that page, on the platform's own domain, openable by anyone with the
 * address. Nothing on it is secret: five business names already on the front
 * page, and one WhatsApp number whose entire purpose is to be printed.
 *
 * RENDERED ON THE SERVER, INCLUDING THE QR CODES. No client JavaScript is
 * needed to read it, so it survives a blocked script, a slow phone in a shop,
 * and being saved to disk and emailed around — which is exactly what will
 * happen to it.
 */

export const metadata: Metadata = {
  title: "Customer links",
  description:
    "The WhatsApp link and QR code for each business on Nexus. Publish these on your website, social profiles and printed material.",
};

// Read fresh on each request rather than baked at build: a business that gains
// a dialable number should appear here without a redeploy.
export const dynamic = "force-dynamic";

interface BusinessLink {
  slug: string;
  name: string;
  number: string | null;
  url: string | null;
  unavailableReason: string | null;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

async function loadLinks(): Promise<{ links: BusinessLink[]; error: string | null }> {
  try {
    const response = await fetch(`${API_URL}/links`, { cache: "no-store" });
    if (!response.ok) return { links: [], error: `The links service answered ${response.status}.` };
    const data = (await response.json()) as { links: BusinessLink[] };
    return { links: data.links ?? [], error: null };
  } catch {
    // Named rather than shown as an empty page. "No links" and "could not
    // reach the server" look identical otherwise, and the first would send
    // someone away believing there is nothing to publish.
    return { links: [], error: "Could not reach the links service just now." };
  }
}

/**
 * Two settings decide whether a printed code actually scans, and both are easy
 * to get wrong in a way that looks fine on screen.
 *
 *   margin — the quiet zone. Four modules is the spec's minimum and the
 *   difference between "works from a shop window" and "works sometimes".
 *
 *   colour — fixed dark-on-light, never theme-aware. A QR that inverted with
 *   the page would be white on black, which many scanners refuse and which
 *   prints as a black square.
 */
async function qrFor(url: string): Promise<string | null> {
  try {
    return await QRCode.toString(url, {
      type: "svg",
      margin: 4,
      errorCorrectionLevel: "Q",
      color: { dark: "#000000", light: "#ffffff" },
    });
  } catch {
    // A failed code must not take the link with it — the URL is the thing that
    // matters and it is already on the page.
    return null;
  }
}

export default async function PublicLinksPage() {
  const { links, error } = await loadLinks();
  const usable = links.filter((link) => link.url);
  const codes = await Promise.all(usable.map((link) => qrFor(link.url!)));

  return (
    <div className={`deck-root pl-root ${fontVariables}`}>
      <header className="pl-mast">
        <a className="pl-brand" href="/">
          Nexus Agentic OS
        </a>
        <h1>Customer links</h1>
        <p className="pl-sub">
          One link per business. A customer who taps it reaches that business&apos;s WhatsApp
          directly — no menu, no being asked which company they mean.
        </p>
      </header>

      {error ? <p className="pl-error">{error}</p> : null}

      {!error && usable.length === 0 ? (
        <p className="pl-error">No business has a WhatsApp number recorded yet.</p>
      ) : null}

      <div className="pl-list">
        {usable.map((link, index) => (
          <article className="pl-card" key={link.slug}>
            <div className="pl-card-head">
              <h2>{link.name}</h2>
              <span className="pl-num">+{link.number}</span>
            </div>

            <div className="pl-card-body">
              {codes[index] ? (
                <div
                  className="pl-qr"
                  /* Generated on this server by the qrcode package, from the URL
                     beside it — no third party learns which businesses exist or
                     gets to log who scans them. */
                  dangerouslySetInnerHTML={{ __html: codes[index]! }}
                />
              ) : null}

              <div className="pl-detail">
                <p className="pl-lede">
                  Opens WhatsApp with the message already written. The customer presses send, and
                  it arrives already routed to {link.name}.
                </p>
                <code className="pl-url">{link.url}</code>
                <CopyButton url={link.url!} />
              </div>
            </div>
          </article>
        ))}
      </div>

      {links
        .filter((link) => !link.url)
        .map((link) => (
          <p className="pl-missing" key={link.slug}>
            <strong>{link.name}</strong> — {link.unavailableReason}
          </p>
        ))}

      <section className="pl-where">
        <h2>Where each one goes</h2>
        <ol>
          <li>
            <strong>The business&apos;s own website</strong>, as the WhatsApp button. Highest value
            by some distance — someone reading the services page is already interested.
          </li>
          <li>
            <strong>Instagram and Facebook bio</strong>, in the single link slot.
          </li>
          <li>
            <strong>Google Business Profile</strong>, under the appointment or website link.
          </li>
          <li>
            <strong>Email signatures</strong> for anyone client-facing.
          </li>
          <li>
            <strong>Print the QR</strong> for the shop window, a business card, a property listing
            or an invoice. Keep the white border — that quiet zone is what lets a phone read it
            from a distance.
          </li>
        </ol>
        <p className="pl-print">This page prints. One business per page, codes at scanning size.</p>
      </section>
    </div>
  );
}
