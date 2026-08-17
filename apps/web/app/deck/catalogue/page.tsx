"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import {
  getCatalog,
  installCatalogItem,
  removeCatalogInstall,
  readableError,
  type CatalogItem,
  type CatalogItemKind,
  type CatalogInstall,
  type CatalogCounts,
} from "@/lib/api";
import { fontVariables } from "@/lib/fonts";
import { TENANTS, tenantName } from "@/lib/tenants";
import "../deck.css";
import "../activity/activity.css";
import "./catalogue.css";

/**
 * The catalogue (F13) — a shelf a business installs FROM, and never publishes
 * TO.
 *
 * THE EGRESS POLICY IS THE PRODUCT, so this page is built to make it visible
 * rather than to mention it. There is no "share this" control anywhere on the
 * screen, no "publish your procedure" empty state, no affordance that would
 * make a reader wonder whether their material travels. It does not: migration
 * 039 gave `catalog_items` no organization_id and no foreign key to any tenant
 * table, so there is nowhere for one business's method to be recorded.
 *
 * That matters most for the two law firms. Juris Prime Legal and ABR both
 * answer on the same WhatsApp number. A marketplace able to carry one firm's
 * intake to the other is not this feature with a risk attached; it is a
 * different product, and the reason the boundary is a property of the schema
 * rather than a rule in this file.
 *
 * WHAT THIS SCREEN HONESTLY IS TODAY. Installing records a decision — which
 * business has taken which pack, at which version, switched off. It does not
 * yet put anything in front of a customer, because no catalogue payload has
 * been wired into the live agent. So there is no activation switch here. A
 * toggle that read "active" while changing nothing about what customers hear is
 * exactly the plausible-normal-state failure this platform keeps producing, and
 * the banner below says the quiet part out loud instead.
 *
 * OPERATOR-ONLY, unlike Knowledge and Procedures next door. Those are a
 * business's own material and the people doing the job are trusted with them.
 * Installing a pack changes what every customer of that business is eventually
 * told, and this page shows all five businesses side by side — an owner's
 * decision on an owner's view. /api/catalog refuses employees outright.
 */

const KIND_LABEL: Record<CatalogItemKind, string> = {
  template: "Message",
  procedure: "Method",
  knowledge_pack: "Knowledge",
};

const KIND_BLURB: Record<CatalogItemKind, string> = {
  template: "Wording the agent can send, with the business's own details filled in.",
  procedure: "The order to work through a kind of enquiry in.",
  knowledge_pack: "Material the agent answers from.",
};

const KIND_ORDER: CatalogItemKind[] = ["procedure", "template", "knowledge_pack"];

/**
 * What is actually inside an item, rendered from its payload.
 *
 * Generic on purpose. The payload shape differs by kind and is authored rather
 * than validated, so this reads what it recognises and shows nothing where it
 * finds nothing — an item that renders as a title and a summary alone is a
 * worse card, not a broken page. Installing something sight-unseen is the thing
 * worth avoiding: an operator who cannot see the steps before pressing Install
 * is agreeing to text they have never read.
 */
function Contents({ item }: { item: CatalogItem }) {
  const payload = item.payload ?? {};

  const steps = Array.isArray(payload.steps)
    ? (payload.steps as { text?: string }[]).map((step) => step?.text).filter(Boolean)
    : [];
  const body = typeof payload.body === "string" ? payload.body : null;
  const documents = Array.isArray(payload.documents)
    ? (payload.documents as { title?: string; body?: string }[])
    : [];
  const notes = typeof payload.notes === "string" ? payload.notes : null;

  return (
    <div className="mk-contents">
      {body ? <p className="mk-body">{body}</p> : null}

      {steps.length > 0 ? (
        <ol className="mk-steps">
          {steps.map((text, index) => (
            <li key={index}>{text}</li>
          ))}
        </ol>
      ) : null}

      {documents.length > 0 ? (
        <ul className="mk-docs">
          {documents.map((doc, index) => (
            <li key={index}>
              <strong>{doc.title}</strong>
              {doc.body ? <span>{doc.body}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {notes ? <p className="mk-note">{notes}</p> : null}
    </div>
  );
}

export default function CataloguePage() {
  const [business, setBusiness] = useState<BusinessSlug>(TENANTS[0].slug);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [installs, setInstalls] = useState<CatalogInstall[]>([]);
  const [counts, setCounts] = useState<CatalogCounts>({
    published: 0,
    installs: 0,
    businesses: 0,
    outdated: 0,
  });
  const [activationWired, setActivationWired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busySlug, setBusySlug] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await getCatalog();
      setItems(data.items);
      setInstalls(data.installs);
      setCounts(data.counts);
      setActivationWired(data.activationWired);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Which item the SELECTED business has, keyed by item slug.
   *
   * Recomputed per business rather than flagged on the item, because the same
   * item is installed by some businesses and not others — an `installed` field
   * on the item itself would be a lie the moment the picker moved.
   */
  const installedHere = useMemo(() => {
    const map = new Map<string, CatalogInstall>();
    for (const install of installs) {
      if (install.businessSlug === business) map.set(install.itemSlug, install);
    }
    return map;
  }, [installs, business]);

  async function install(item: CatalogItem) {
    setBusySlug(item.slug);
    setError("");
    try {
      await installCatalogItem(business, item.slug);
      await load();
    } catch (err) {
      // The API's own sentence, unwrapped from the transport detail around it.
      // "That business already has this one installed" is a state, not a fault,
      // and it is what the person pressing the button needs to read — not a
      // 409 and a path.
      setError(readableError(err));
    } finally {
      setBusySlug(null);
    }
  }

  async function remove(item: CatalogItem, installId: string) {
    setBusySlug(item.slug);
    setError("");
    try {
      await removeCatalogInstall(business, installId);
      await load();
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusySlug(null);
    }
  }

  const byKind = KIND_ORDER.map((kind) => ({
    kind,
    items: items.filter((item) => item.kind === kind),
  })).filter((group) => group.items.length > 0);

  return (
    <div className={`deck-root ${fontVariables}`}>
      <div className="act-root">

        <header className="act-head">
          <h1>Catalogue</h1>
        </header>
        <p className="act-lede">
          Methods, wording and knowledge a business can take on ready-made, instead of writing
          from nothing. Everything here was written for the platform — no business&apos;s own
          material is in it, and none can be added to it.
        </p>

        {/* Stated once, plainly, near the top. The alternative — a page that
            quietly never mentions where its contents come from — is the one
            that leaves a law firm wondering whether its intake is on this
            shelf. */}
        <p className="mk-policy">
          <strong>Nothing leaves.</strong> A business installs from this shelf and never
          contributes to it. The catalogue table has no column that could hold one business&apos;s
          material, so this is a property of how it is built rather than a rule somebody has to
          remember — which is what the two law firms sharing a number are owed.
        </p>

        <div className="mk-counts">
          <div className="mk-count">
            <strong>{counts.published}</strong>
            <span>on the shelf</span>
          </div>
          <div className={`mk-count${counts.installs > 0 ? " live" : ""}`}>
            <strong>{counts.installs}</strong>
            <span>installed</span>
          </div>
          <div className="mk-count">
            <strong>{counts.businesses}</strong>
            <span>of {TENANTS.length} businesses using one</span>
          </div>
          <div className={`mk-count${counts.outdated > 0 ? " warn" : ""}`}>
            <strong>{counts.outdated}</strong>
            <span>behind the current version</span>
          </div>
        </div>

        {/* The whole reason this banner exists rather than an "active" switch.
            An install is a recorded decision today and nothing more. */}
        {!activationWired ? (
          <div className="mk-banner">
            <strong>Installing does not change what customers hear — not yet.</strong>
            <p>
              An install records that this business has chosen a pack, at the version it chose,
              switched off. Connecting a pack to the live agent is a separate step and is not
              built. There is deliberately no switch on this page: a control labelled
              &ldquo;active&rdquo; that changed nothing would be worse than no control at all.
            </p>
          </div>
        ) : null}

        <h2 className="act-sub-head">Installing into</h2>
        <div className="act-tabs">
          {TENANTS.map((tenant) => (
            <button
              key={tenant.slug}
              aria-pressed={business === tenant.slug}
              onClick={() => setBusiness(tenant.slug)}
              title={tenant.name}
            >
              {tenant.ref}
            </button>
          ))}
        </div>
        <p className="mk-target">
          {tenantName(business)} — {installedHere.size} installed
        </p>

        {error ? <p className="act-msg">{error}</p> : null}

        {loading ? (
          <div className="act-empty">Loading…</div>
        ) : items.length === 0 ? (
          <div className="act-empty">
            <strong>Nothing has been published to the catalogue yet.</strong>
            <br />
            The shelf is built and empty, which is a different thing from broken. Items are
            authored by whoever runs the platform and published in a migration — the application
            cannot write one, by design.
          </div>
        ) : (
          byKind.map((group) => (
            <section key={group.kind} className="mk-group">
              <h2 className="act-sub-head">
                {KIND_LABEL[group.kind]}
                <em className="mk-group-blurb">{KIND_BLURB[group.kind]}</em>
              </h2>

              <div className="mk-list">
                {group.items.map((item) => {
                  const here = installedHere.get(item.slug);
                  const busy = busySlug === item.slug;
                  const behind = here && here.installedVersion < item.version;

                  return (
                    <article className={`mk-item${here ? " on" : ""}`} key={item.slug}>
                      <div className="mk-head">
                        <h3>{item.title}</h3>
                        <span className="mk-version">v{item.version}</span>
                      </div>

                      <p className="mk-summary">{item.summary}</p>

                      {item.suitsIndustry ? (
                        <span className="act-flag">for {item.suitsIndustry}</span>
                      ) : null}

                      <Contents item={item} />

                      <div className="mk-actions">
                        {here ? (
                          <>
                            <span className="mk-state">
                              Installed for {tenantName(business)} at v{here.installedVersion},
                              switched off
                            </span>
                            <button
                              className="mk-remove"
                              onClick={() => remove(item, here.id)}
                              disabled={busy}
                            >
                              {busy ? "Removing…" : "Remove"}
                            </button>
                          </>
                        ) : (
                          <button onClick={() => install(item)} disabled={busy}>
                            {busy ? "Installing…" : `Install for ${tenantName(business)}`}
                          </button>
                        )}
                      </div>

                      {/* Shown only when it is true, and it names both numbers.
                          "An update is available" without saying from what to
                          what gives the reader nothing to decide with — and
                          taking an update is a decision, because the pack this
                          business agreed to is the one it is running. */}
                      {behind ? (
                        <p className="mk-behind">
                          The catalogue has moved to v{item.version}. This business stays on v
                          {here!.installedVersion} until somebody chooses otherwise — a catalogue
                          that updated itself inside a live agent would change what customers are
                          told with nobody deciding to. Taking an update is not built yet; remove
                          and install again to move.
                        </p>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </section>
          ))
        )}

        {/* The cross-business view, which is the half an owner actually wants
            and the half no per-business page could show. */}
        <h2 className="act-sub-head">Running now, across every business</h2>
        {installs.length === 0 ? (
          <div className="act-empty">
            No business has installed anything yet.
          </div>
        ) : (
          <table className="mk-table">
            <thead>
              <tr>
                <th>Business</th>
                <th>Item</th>
                <th>Kind</th>
                <th>Version</th>
                <th>Installed</th>
              </tr>
            </thead>
            <tbody>
              {installs.map((install) => (
                <tr key={install.id}>
                  <td>{install.businessName}</td>
                  <td>{install.itemTitle}</td>
                  <td>{KIND_LABEL[install.itemKind]}</td>
                  <td>
                    v{install.installedVersion}
                    {install.installedVersion < install.availableVersion ? (
                      <em> (v{install.availableVersion} available)</em>
                    ) : null}
                  </td>
                  <td>{new Date(install.installedAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
