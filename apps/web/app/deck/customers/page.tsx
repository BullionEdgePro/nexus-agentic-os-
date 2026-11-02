"use client";

import { useCallback, useEffect, useState } from "react";
import { BusinessTabs, useVisibleBusinesses } from "@/lib/business-tabs";
import type { BusinessSlug } from "@nexus/shared";
import {
  downloadExport,
  forgetContactMemory,
  getContact,
  getContacts,
  readableError,
  TruncatedExport,
  type ContactDetail,
  type ContactMemoryView,
  type ContactSummary,
} from "@/lib/api";
import { ImportCustomers } from "./import-customers";
import { HistoryCards, ago as when } from "./history-cards";
import { SlidePanel } from "../../kit/slide-panel";
import { Initials } from "../../kit/status-card";
import { fontVariables } from "@/lib/fonts";
import { TENANTS } from "@/lib/tenants";
import "../deck.css";
import "../activity/activity.css";
import "../../kit/kit.css";
import "./customers.css";

/**
 * The customer record — the "C" this platform did not have.
 *
 * ============================================================
 * WHY IT DID NOT EXIST, AND WHAT THAT COST
 * ============================================================
 *
 * Fourteen screens, and not one of them showed a person. You could read a
 * conversation, a follow-up, a booking or a lead score — every artefact a
 * customer produces — and never the customer. Their history sat across five
 * tables with nothing that put it back together.
 *
 * The part that mattered more than convenience: `contact_memory` holds what
 * this platform has REMEMBERED about somebody, inferred from their messages,
 * and its only readers were two verification scripts. Nobody could see what
 * was held. `forgetContact` — written because "delete what you hold about me"
 * is a request a customer can make — had no caller outside a script, so the
 * honest answer to that request was still "we would have to run something".
 *
 * ============================================================
 * WHAT THIS SCREEN IS CAREFUL ABOUT
 * ============================================================
 *
 * The memory is shown in the words it is held in, not summarised. Somebody
 * asking what is known about them deserves the actual text, and somebody
 * deciding whether to erase it cannot decide without reading it.
 *
 * Erasing asks first and says plainly what survives: the conversations stay,
 * because they are the business's own record of what was said. Only the part
 * this platform inferred on its own account goes.
 */
export default function CustomersPage() {
  // The exports are the admin's (the API answers staff "Not found"), so staff
  // are not offered them (24 Oct 2026).
  const { isOperator } = useVisibleBusinesses();
  const [business, setBusiness] = useState<BusinessSlug>("zipicka");
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ContactDetail | null>(null);
  const [memory, setMemory] = useState<ContactMemoryView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /** Something worth saying that is not a failure. See `download`. */
  const [notice, setNotice] = useState("");

  const load = useCallback(async (slug: BusinessSlug, query: string) => {
    setLoading(true);
    setLoadError("");
    try {
      const data = await getContacts(slug, query);
      setContacts(data.contacts);
    } catch (err) {
      // Separate from `error`: a failed LOAD must not be reported in the place
      // an action failure is, and an empty list must never stand in for one.
      setLoadError(readableError(err, "The customer list could not be loaded."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setSelected(null);
    setMemory(null);
    void load(business, search);
  }, [business, search, load]);

  /**
   * Download one of the exports.
   *
   * A truncated file is reported as a NOTICE, not an error: it downloaded, it
   * is usable, and it is incomplete. Showing it in red beside "that could not
   * be exported" would teach somebody to read the two the same way.
   */
  async function download(path: string, fallback: string) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await downloadExport(path, fallback);
    } catch (err) {
      if (err instanceof TruncatedExport) setNotice(err.message);
      else setError(readableError(err, "That could not be exported."));
    } finally {
      setBusy(false);
    }
  }

  async function open(contact: ContactSummary) {
    setError("");
    try {
      const data = await getContact(business, contact.id);
      setSelected(data.contact);
      setMemory(data.memory);
    } catch (err) {
      setError(readableError(err, "That customer could not be opened."));
    }
  }

  async function forget(contact: ContactDetail) {
    // Asked first, and the question says what survives. "Forget this customer"
    // could reasonably be read as deleting them.
    const ok = window.confirm(
      `Erase what this platform has remembered about ${contact.displayName ?? contact.waId}?\n\n` +
        `Their conversations stay — they are your record of what was said. Only the summary ` +
        `this platform worked out on its own is removed, and it cannot be recovered.`
    );
    if (!ok) return;

    setBusy(true);
    setError("");
    try {
      await forgetContactMemory(business, contact.id);
      setMemory(null);
      setSelected({ ...contact, remembered: false });
      await load(business, search);
    } catch (err) {
      setError(readableError(err, "That could not be erased."));
    } finally {
      setBusy(false);
    }
  }

  const latest = selected ? latestConversation(selected) : null;

  return (
    <div className={`deck-root ${fontVariables}`}>
      <div className="act-root">
        <header className="act-head">
          <h1>Customers</h1>
        </header>
        <p className="act-lede">
          Everyone this business has spoken to on WhatsApp, most recent first — with what was
          asked, what the scorer made of it, and what this platform has remembered about them.
        </p>

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

        <label className="cu-search">
          <span>Search by name or number</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Ahmed, or 9715…"
          />
        </label>

        {/* THE BUSINESS'S OWN DATA, OUT.

            There was no export anywhere in this product until today; the only
            download it offered was a QR code. A platform that can be asked to
            forget a customer and cannot produce a single row of the business's
            own records has the two halves of that the wrong way round. */}
        {/* Import sits beside export deliberately. A product that will hand
            you your data and not take it back is a one-way door, and until this
            existed the only way in was one customer at a time. */}
        <ImportCustomers
          business={business}
          businessName={TENANTS.find((t) => t.slug === business)?.name ?? business}
          onImported={() => void load(business, "")}
        />

        {isOperator ? (
        <div className="cu-export">
          <span>Take your data</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void download(`/api/organizations/${business}/export/customers.csv`, "customers.csv")}
          >
            Customers (CSV)
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void download(`/api/organizations/${business}/export/messages.csv`, "messages.csv")}
          >
            Every message (CSV)
          </button>
        </div>
        ) : null}

        {notice ? <p className="cu-notice">{notice}</p> : null}
        {error ? <p className="cu-err">{error}</p> : null}

        {loadError ? (
          // Where the list would be, never above an empty one: an empty list
          // under a failed fetch reads as "no customers", which is the sentence
          // this deck exists not to say by accident.
          <p className="cu-err cu-err-load">{loadError}</p>
        ) : loading ? (
          <p className="cu-note">Loading…</p>
        ) : contacts.length === 0 ? (
          <p className="cu-note">
            {search
              ? "Nobody matches that."
              : "Nobody has messaged this business yet. Once somebody does, they appear here."}
          </p>
        ) : (
          <ul className="kit-cards cu-cards">
            {contacts.map((contact) => (
              <li key={contact.id}>
                <button type="button" className="kit-card tone-paper cu-card" onClick={() => void open(contact)}>
                  <span className="cu-card-top">
                    <Initials name={contact.displayName} />
                    <span className="kit-card-title" dir="auto">
                      {contact.displayName ?? (contact.waId ? `+${contact.waId}` : "Customer")}
                    </span>
                  </span>
                  {/* The number is the title when there is no name; not twice. */}
                  <span className="kit-card-sub">{contact.displayName ? (contact.waId ? `+${contact.waId}` : "Email") : "no name saved"}</span>
                  <span className="cu-meta">
                    {contact.leadPriority ? (
                      <span className={`cu-pri ${contact.leadPriority}`}>
                        {contact.leadScore} · {contact.leadPriority}
                      </span>
                    ) : (
                      <span className="cu-pri none">not scored</span>
                    )}
                    <span>
                      {contact.conversations}{" "}
                      {contact.conversations === 1 ? "conversation" : "conversations"}
                    </span>
                    {/* Said on the list, not only in the detail. Whether this
                        platform holds something about a person is the fact
                        somebody scanning for a "forget me" request needs. */}
                    {contact.remembered ? <span className="cu-rem">remembered</span> : null}
                    {contact.optedOut ? <span className="cu-out">opted out</span> : null}
                    <span className="cu-when">{when(contact.lastMessageAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {selected ? (
          <SlidePanel
            open
            title={selected.displayName ?? (selected.waId ? `+${selected.waId}` : "Customer")}
            onClose={() => setSelected(null)}
          >
            <div className="cu-profile-head">
              <Initials name={selected.displayName} />
              <h2 dir="auto">{selected.displayName ?? (selected.waId ? `+${selected.waId}` : "Customer")}</h2>
            </div>
            <p className="cu-detail-meta">
              {selected.waId ? `+${selected.waId}` : "Email"}
              {selected.servedBy.length > 1 ? (
                // Worth saying out loud on a shared number: this person has
                // dealt with more than one of the firms answering it. Only the
                // slugs, never the other firm's conversations.
                <> · also a customer of {selected.servedBy.filter((s) => s !== business).join(", ")}</>
              ) : null}
              {selected.openFollowUps > 0 ? <> · {selected.openFollowUps} open follow-ups</> : null}
              {selected.bookings > 0 ? <> · {selected.bookings} appointments</> : null}
            </p>
            {latest ? (
              <div className="kit-actions">
                <a className="kit-btn" href={`/inbox?conversation=${encodeURIComponent(latest)}`}>
                  Open chat
                </a>
              </div>
            ) : null}

            {/* An erase or a download that failed says so here, where it was
                asked for, not behind the panel. */}
            {error ? <p className="cu-err">{error}</p> : null}
            {notice ? <p className="cu-notice">{notice}</p> : null}

            <h3 className="cu-h3">What this platform remembers</h3>
            {memory ? (
              <div className="cu-mem">
                <dl className="kit-rows">
                  <dt>In its words</dt>
                  <dd className="cu-mem-text" dir="auto">
                    {memory.summary}
                  </dd>
                  <dt>Worked out from</dt>
                  <dd>
                    {memory.sourceMessages} {memory.sourceMessages === 1 ? "message" : "messages"}
                  </dd>
                  <dt>Updated</dt>
                  <dd>{when(memory.updatedAt)}</dd>
                </dl>
                <div className="kit-actions">
                  <button
                    type="button"
                    className="kit-btn quiet"
                    onClick={() => void forget(selected)}
                    disabled={busy}
                  >
                    {busy ? "Erasing…" : "Erase this"}
                  </button>
                  {/* The other half of the same request. Somebody who asks
                      what is held about them is usually the same person who
                      may then ask for it to be deleted, and the two answers
                      belong next to each other. */}
                  <button
                    type="button"
                    className="kit-btn quiet"
                    disabled={busy}
                    onClick={() =>
                      void download(
                        `/api/organizations/${business}/contacts/${selected.id}/export.json`,
                        "customer.json"
                      )
                    }
                  >
                    Download everything held
                  </button>
                </div>
              </div>
            ) : (
              <p className="cu-note">
                Nothing. This platform holds no summary about them — only the conversations below.
              </p>
            )}

            <h3 className="cu-h3">Conversations</h3>
            <HistoryCards conversations={selected.conversationList} />

            <h3 className="cu-h3">How they have been scored</h3>
            {selected.leadHistory.length === 0 ? (
              <p className="cu-note">Never scored.</p>
            ) : (
              <ul className="cu-leads">
                {selected.leadHistory.map((lead) => (
                  <li key={lead.id}>
                    <span className={`cu-pri ${lead.priority}`}>
                      {lead.score} · {lead.priority}
                    </span>
                    <span>{lead.category.replace(/_/g, " ")}</span>
                    <span className="cu-when">{when(lead.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </SlidePanel>
        ) : null}
      </div>
    </div>
  );
}

/** The conversation "Open chat" goes to: the one most recently written in. */
function latestConversation(contact: ContactDetail): string | null {
  let best: { id: string; at: number } | null = null;
  for (const c of contact.conversationList) {
    const at = c.lastMessageAt ? new Date(c.lastMessageAt).getTime() : Number.NaN;
    const score = Number.isNaN(at) ? -Infinity : at;
    if (!best || score > best.at) best = { id: c.id, at: score };
  }
  return best?.id ?? null;
}
