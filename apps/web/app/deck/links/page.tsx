"use client";

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { getLinks, type BusinessLink } from "@/lib/api";
import { fontVariables } from "@/lib/fonts";
import "../deck.css";
import "../activity/activity.css";
import "./links.css";

/**
 * The link each business hands its own customers.
 *
 * Five businesses answer one WhatsApp number. That solved reachability and left
 * an adoption problem: someone who wants the law firm still arrives at a triage
 * menu, because nothing in "hi" says which business they came for. These links
 * carry a routing tag in the prefilled message, so a customer who taps ABR's
 * link reaches ABR's agent directly.
 *
 * This page exists because the links were only reachable through the API, which
 * means they may as well not have existed — the person who needs to paste one
 * into a website is not going to run curl.
 *
 * The copy button is the whole interface. Everything else on the page is there
 * to answer "where do I put this" and "why does it matter", because a link
 * nobody publishes changes nothing.
 */
export default function LinksPage() {
  const [links, setLinks] = useState<BusinessLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await getLinks();
      setLinks(data.links);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the links.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Rendered client-side once the links arrive.
  //
  // Two settings decide whether these actually scan, and both are easy to get
  // wrong in a way that looks fine on screen:
  //
  //   margin — the quiet zone. A QR printed flush against other artwork fails
  //   on a large share of scanners. Four modules is the spec's minimum and the
  //   difference between "works from a shop window" and "works sometimes".
  //
  //   colour — fixed dark-on-light, NOT theme-aware. The rest of this page
  //   follows the operator's theme; a QR that inverted with it would be white
  //   on black, which many scanners refuse and which prints as a black square.
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      links
        .filter((link) => link.url)
        .map(async (link) => {
          const svg = await QRCode.toString(link.url!, {
            type: "svg",
            margin: 4,
            // Q tolerates ~25% damage — the level worth having on something
            // that will be printed, taped to a window and rained on.
            errorCorrectionLevel: "Q",
            color: { dark: "#000000", light: "#ffffff" },
          });
          return [link.slug, svg] as const;
        })
    )
      .then((pairs) => {
        if (!cancelled) setCodes(Object.fromEntries(pairs));
      })
      .catch(() => {
        // A failed QR must not take the links with it — the URL is the thing
        // that matters and it is already on screen.
        if (!cancelled) setCodes({});
      });
    return () => {
      cancelled = true;
    };
  }, [links]);

  function downloadQr(link: BusinessLink) {
    const svg = codes[link.slug];
    if (!svg) return;
    // SVG rather than PNG: it scales to a shop window or a business card
    // without the blur that kills a scan at large sizes.
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${link.slug}-whatsapp-qr.svg`;
    anchor.click();
    // Revoked on the next tick, not on the next line. click() only queues the
    // download; revoking synchronously can invalidate the blob before the
    // browser has started fetching it, and in Firefox and Safari the download
    // then fails silently — no error, no file, and an operator who concludes
    // the feature is broken.
    setTimeout(() => URL.revokeObjectURL(href), 0);
  }

  async function copy(link: BusinessLink) {
    if (!link.url) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(link.slug);
      // Cleared rather than left showing: a permanent "Copied" gives no signal
      // the second time someone presses it.
      setTimeout(() => setCopied((current) => (current === link.slug ? null : current)), 2000);
    } catch {
      setError("Could not reach the clipboard — select the link and copy it manually.");
    }
  }

  const usable = links.filter((link) => link.url);

  return (
    <div className={`deck-root ${fontVariables}`}>
      <div className="act-root">
        <a className="act-back" href="/">
          ← Command deck
        </a>

        <header className="act-head">
          <h1>Customer links</h1>
        </header>
        <p className="act-lede">
          One link per business. A customer who taps it reaches that business&apos;s agent
          directly — no menu, no being asked which company they mean.
        </p>

        {error ? <p className="act-msg">{error}</p> : null}

        {loading ? (
          <div className="act-empty">Loading…</div>
        ) : usable.length === 0 ? (
          <div className="act-empty">
            <strong>No business has a WhatsApp number recorded.</strong>
            <br />
            Links cannot be built until one does.
          </div>
        ) : (
          <div className="lk-list">
            {links.map((link) => (
              <article className={`lk-item${link.url ? "" : " off"}`} key={link.slug}>
                <div className="lk-head">
                  <h2>{link.name}</h2>
                  {link.number ? (
                    <span className="lk-number">+{link.number}</span>
                  ) : (
                    <span className="act-flag warn">no number</span>
                  )}
                </div>

                {link.url ? (
                  <>
                    <div className="lk-url">
                      <code>{link.url}</code>
                      <button onClick={() => copy(link)}>
                        {copied === link.slug ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <p className="lk-note">
                      Opens WhatsApp with a message already written. The customer just presses
                      send, and it arrives already routed to {link.name}.
                    </p>

                    {codes[link.slug] ? (
                      <div className="lk-qr">
                        <div
                          className="lk-qr-img"
                          /* Generated locally by qrcode from the URL above — no
                             remote service, so no third party learns which
                             businesses exist or gets to log the scans. */
                          dangerouslySetInnerHTML={{ __html: codes[link.slug] }}
                        />
                        <div className="lk-qr-side">
                          <p>
                            Print this for the shop window, a business card, a property listing
                            or an invoice. Scanning it opens the same pre-routed message.
                          </p>
                          <button onClick={() => downloadQr(link)}>Download SVG</button>
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <p className="lk-note">{link.unavailableReason}</p>
                )}
              </article>
            ))}
          </div>
        )}

        <section className="lk-where">
          <h2 className="act-sub-head">Where to put it</h2>
          <ul>
            <li>
              <strong>The website</strong> — as the WhatsApp button. This is the highest-value
              one: someone reading the services page is already interested.
            </li>
            <li>
              <strong>Instagram and Facebook bio</strong> — the single link slot.
            </li>
            <li>
              <strong>Google Business Profile</strong> — under the appointment or website link.
            </li>
            <li>
              <strong>Email signatures</strong> for anyone client-facing.
            </li>
          </ul>
          <p className="lk-why">
            Worth being blunt about why this page exists: four of the five businesses have never
            had a customer message them. Everything else in this platform — the routing, the
            memory, the lead scoring, the quality measurement — is exercised by one business.
            Publishing these is the cheapest way to change that.
          </p>
        </section>
      </div>
    </div>
  );
}
