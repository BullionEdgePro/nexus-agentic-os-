"use client";

import { useCallback, useEffect, useState } from "react";
import { BusinessTabs } from "@/lib/business-tabs";
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
import { fontVariables } from "@/lib/fonts";
import { TENANTS } from "@/lib/tenants";
import "../deck.css";
import "../activity/activity.css";
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
          <ul className="cu-list">
            {contacts.map((contact) => (
              <li key={contact.id}>
                <button type="button" className="cu-row" onClick={() => void open(contact)}>
                  <span className="cu-name">{contact.displayName ?? `+${contact.waId}`}</span>
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
          <section className="cu-detail">
            <div className="cu-detail-head">
              <h2>{selected.displayName ?? `+${selected.waId}`}</h2>
              <button type="button" className="cu-close" onClick={() => setSelected(null)}>
                Close
              </button>
            </div>
            <p className="cu-detail-meta">
              +{selected.waId}
              {selected.servedBy.length > 1 ? (
                // Worth saying out loud on a shared number: this person has
                // dealt with more than one of the firms answering it. Only the
                // slugs, never the other firm's conversations.
                <> · also a customer of {selected.servedBy.filter((s) => s !== business).join(", ")}</>
              ) : null}
              {selected.openFollowUps > 0 ? <> · {selected.openFollowUps} open follow-ups</> : null}
              {selected.bookings > 0 ? <> · {selected.bookings} appointments</> : null}
            </p>

            <h3>What this platform remembers</h3>
            {memory ? (
              <div className="cu-mem">
                <p className="cu-mem-text">{memory.summary}</p>
                <p className="cu-mem-meta">
                  worked out from {memory.sourceMessages}{" "}
                  {memory.sourceMessages === 1 ? "message" : "messages"} · updated{" "}
                  {when(memory.updatedAt)}
                </p>
                <div className="cu-mem-acts">
                  <button
                    type="button"
                    className="cu-forget"
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
                    className="cu-forget"
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

            <h3>Conversations</h3>
            {selected.conversationList.length === 0 ? (
              <p className="cu-note">None with this business.</p>
            ) : (
              <ul className="cu-convos">
                {selected.conversationList.map((conversation) => (
                  <li key={conversation.id}>
                    <span className={`cu-status ${conversation.status}`}>{conversation.status}</span>
                    <span>
                      {conversation.messages}{" "}
                      {conversation.messages === 1 ? "message" : "messages"}
                    </span>
                    <span className="cu-when">{when(conversation.lastMessageAt)}</span>
                    <a href="/inbox">Open</a>
                  </li>
                ))}
              </ul>
            )}

            <h3>How they have been scored</h3>
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
          </section>
        ) : null}
      </div>
    </div>
  );
}

/** Age, not a timestamp: "3d" is what a reader acts on. */
function when(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never";
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
