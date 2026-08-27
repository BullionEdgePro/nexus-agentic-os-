"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BusinessTabs } from "@/lib/business-tabs";
import type { BusinessSlug } from "@nexus/shared";
import {
  getCatalog,
  installCatalogItem,
  removeCatalogInstall,
  activateCatalogInstall,
  takeCatalogUpdate,
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
 * THE THREE STEPS, WHICH ARE THREE DECISIONS AND NOT ONE FLOW. Installing
 * records that a business has chosen a pack, at a version. Adding materialises
 * it into that business — a procedure into "How we answer" SWITCHED OFF, wording
 * into "What we say" switched off, a knowledge pack indexed and therefore live
 * at once, which the banner says out loud. Switching on happens on those screens,
 * never here: they show what else is already answering that situation, and a
 * button on this page that reached past them into the live prompt is the one
 * thing 039's design exists to prevent.
 *
 * Taking an update is the fourth, and the same rule again — a catalogue that
 * upgraded itself inside a live agent would change what customers are told with
 * nobody deciding to, so v1 stays v1 until somebody presses the button.
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
    activated: 0,
  });
  const [activatableKinds, setActivatableKinds] = useState<CatalogItemKind[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /**
   * A LOAD that failed, kept apart from an ACTION that failed.
   *
   * The render below refuses to draw anything when this is set, because the
   * alternative is the previous business's numbers under the new one's name.
   * An action failure — a recompute, a send, a save — must NOT do that: the
   * screen it happened on is still correct, and blanking it would lose the
   * context the message is about.
   */
  const [loadError, setLoadError] = useState("");
  const [busySlug, setBusySlug] = useState<string | null>(null);
  /** What the last activation actually did, per item. The server's own sentence. */
  const [said, setSaid] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setLoadError("");
    try {
      const data = await getCatalog();
      setItems(data.items);
      setInstalls(data.installs);
      setCounts(data.counts);
      setActivatableKinds(data.activatableKinds);
    } catch (err) {
      setLoadError(readableError(err));
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

  async function activate(item: CatalogItem, installId: string) {
    setBusySlug(item.slug);
    setError("");
    try {
      const { outcome } = await activateCatalogInstall(business, installId);
      // The server's sentence, kept per item rather than as one page-level
      // banner: "indexed, live now" and "added, switched off" are different
      // facts about different cards, and one shared line would attach the wrong
      // one to whatever the reader looked at next.
      const blocked =
        outcome.kind === "procedure" && outcome.blockedBySource
          ? ` Something else is already switched on for this kind of enquiry, so you will have to turn that one off first.`
          : "";
      setSaid((current) => ({ ...current, [item.slug]: outcome.note + blocked }));
      await load();
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusySlug(null);
    }
  }

  async function update(item: CatalogItem, installId: string) {
    setBusySlug(item.slug);
    setError("");
    try {
      const { outcome } = await takeCatalogUpdate(business, installId);
      // The server's sentence again. "Waiting on How we answer as a suggestion"
      // and "the agent is answering from the newer text now" are very different
      // outcomes of one button, and the page must not flatten them into "done".
      setSaid((current) => ({ ...current, [item.slug]: outcome.note }));
      await load();
    } catch (err) {
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
          <div className={`mk-count${counts.activated > 0 ? " live" : ""}`}>
            <strong>{counts.activated}</strong>
            <span>added to a business</span>
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

        {/* Two steps, and the difference between them is the whole safety
            argument — so it is stated before any button rather than discovered
            after one. */}
        <div className="mk-banner">
          <strong>Installing chooses it. Adding puts it in the business. Neither switches it on.</strong>
          <p>
            <em>Add to this business</em> writes a catalogue procedure into{" "}
            <a href="/deck/procedures">How we answer</a> <strong>switched off</strong>. Somebody
            turns it on there, where they can see what else is already answering that kind of
            enquiry. A catalogue button that reached straight into the live prompt is the one
            thing this design exists to prevent.
          </p>
          <p>
            Knowledge is the exception and it is worth knowing before you press it: an indexed
            chunk has no switched-off state, so adding a knowledge pack changes what the agent can
            answer from <strong>immediately</strong> — exactly as adding a source by hand in{" "}
            <a href="/deck/knowledge">Knowledge</a> already does.
          </p>
        </div>

        <h2 className="act-sub-head">Installing into</h2>
        <BusinessTabs
          value={business}
          onChange={(slug) => {
            // These screens are meaningless without one business chosen, so they
            // hold a plain BusinessSlug and never render the All tab. The guard
            // says that rather than casting the empty case away.
            if (slug) setBusiness(slug);
          }}
          includeAll={false}
        />
        <p className="mk-target">
          {tenantName(business)} — {installedHere.size} installed
        </p>

        {loadError ? (
          /*
           * WHEN THE LOAD FAILS, NOTHING BELOW IS DRAWN.
           *
           * This line used to appear ABOVE the data, and the data was
           * whatever the last successful load had put in state. Switch
           * business, have the request fail, and this page showed the
           * PREVIOUS business's numbers under the new one's name — one
           * tenant's figures attributed to another, arriving through the
           * UI rather than the database that spent a whole feature
           * preventing exactly that.
           *
           * Clearing the data instead would have been worse: the page
           * would fall through to its empty state and say "nothing to
           * report" when the truth is "nobody could ask". Those are the
           * two silences the operators panel was fixed for this morning.
           */
          <p className="act-msg">{loadError}</p>
        ) : null}

        {loadError ? null : loading ? (
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
                  // Asked of the server's list rather than decided here, so the
                  // page cannot come to its own view of which kinds work.
                  const canActivate = activatableKinds.includes(item.kind);

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
                              {here.isActive
                                ? `Added to ${tenantName(business)} at v${here.installedVersion}`
                                : `Installed for ${tenantName(business)} at v${here.installedVersion}, not yet added`}
                            </span>
                            <span className="mk-buttons">
                              {/* Only offered where the server says the kind can
                                  actually be activated, and only once. A second
                                  press is harmless — activation is idempotent by
                                  the unique index on the install — but a button
                                  that stays lit after it has done its job invites
                                  the reader to wonder whether it worked. */}
                              {!here.isActive && canActivate ? (
                                <button onClick={() => activate(item, here.id)} disabled={busy}>
                                  {busy ? "Adding…" : "Add to this business"}
                                </button>
                              ) : null}
                              <button
                                className="mk-remove"
                                onClick={() => remove(item, here.id)}
                                disabled={busy}
                              >
                                {busy ? "Removing…" : "Remove"}
                              </button>
                            </span>
                          </>
                        ) : (
                          <button onClick={() => install(item)} disabled={busy}>
                            {busy ? "Installing…" : `Install for ${tenantName(business)}`}
                          </button>
                        )}
                      </div>

                      {/* Why the Add button is not there, on the card where
                          somebody would look for it. An absent control with no
                          explanation reads as a bug. */}
                      {here && !here.isActive && !canActivate ? (
                        <p className="mk-behind">
                          This one cannot be added automatically. Message wording is not a
                          WhatsApp template — that table mirrors what Meta has approved — and the
                          platform has nowhere yet to put authored agent wording. Copy it by hand
                          for now.
                        </p>
                      ) : null}

                      {said[item.slug] ? <p className="mk-said">{said[item.slug]}</p> : null}

                      {here?.isActive ? (
                        <p className="mk-note">
                          Removing the install from here will not take this back out — by now it
                          is {tenantName(business)}&apos;s own material. Turn a procedure off in{" "}
                          <a href="/deck/procedures">How we answer</a>, or delete a source in{" "}
                          <a href="/deck/knowledge">Knowledge</a>.
                        </p>
                      ) : null}

                      {/* Shown only when it is true, and it names both numbers.
                          "An update is available" without saying from what to
                          what gives the reader nothing to decide with — and
                          taking an update is a decision, because the pack this
                          business agreed to is the one it is running. */}
                      {behind ? (
                        <div className="mk-behind">
                          <p>
                            The catalogue has moved to v{item.version}. This business stays on v
                            {here!.installedVersion} until somebody chooses otherwise — a catalogue
                            that updated itself inside a live agent would change what customers are
                            told with nobody deciding to.
                          </p>
                          {/* The button sits inside the explanation rather than
                              beside Install, because taking an update is a
                              different decision from choosing the pack and the
                              sentence above it is the reason to think twice. */}
                          <button onClick={() => update(item, here!.id)} disabled={busy}>
                            {busy ? "Taking…" : `Take v${item.version}`}
                          </button>
                        </div>
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
