"use client";

import { useCallback, useEffect, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import {
  getBroadcasts,
  createBroadcast,
  sendBroadcast,
  syncTemplates,
  type BroadcastTemplate,
  type BroadcastSummary,
} from "@/lib/api";
import { fontVariables } from "@/lib/fonts";
import { TENANTS } from "@/lib/tenants";
import "../deck.css";
import "../activity/activity.css";
import "./broadcasts.css";

/**
 * Bulk WhatsApp messaging.
 *
 * The send engine has existed server-side for a while; what was missing was
 * any way to drive it. This is that, plus the part such a page usually omits:
 * a plain statement of why a send would fail before you attempt it.
 *
 * WhatsApp does not allow a business to message a customer freely. Outside the
 * 24-hour window that a customer's own message opens, only a template Meta has
 * approved may be sent, and only from a verified business with billing set up.
 * Those are Meta's gates, not this platform's, and none of them can be cleared
 * from here — so the page names them and links out, rather than presenting a
 * Send button that returns an error whose real cause is three screens away in
 * another product.
 */
export default function BroadcastsPage() {
  const [business, setBusiness] = useState<BusinessSlug>("zipicka");
  const [templates, setTemplates] = useState<BroadcastTemplate[]>([]);
  const [broadcasts, setBroadcasts] = useState<BroadcastSummary[]>([]);
  const [reachable, setReachable] = useState(0);
  const [canSend, setCanSend] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (slug: BusinessSlug) => {
    setLoading(true);
    setError("");
    try {
      const data = await getBroadcasts(slug);
      setTemplates(data.templates);
      setBroadcasts(data.broadcasts);
      setReachable(data.reachable);
      setCanSend(data.canSend);
      setTemplateId(data.templates.find((t) => t.isApproved)?.id ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load broadcasts.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(business);
  }, [business, load]);

  async function handleSend() {
    if (!templateId) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { broadcast } = await createBroadcast({ organizationSlug: business, templateId });
      const { enqueued } = await sendBroadcast(broadcast.id);
      setNotice(`Queued for ${enqueued} ${enqueued === 1 ? "contact" : "contacts"}.`);
      await load(business);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The send did not go through.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSync() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await syncTemplates(business);
      setNotice(
        `Read ${result.synced} template${result.synced === 1 ? "" : "s"} from Meta — ${result.approved} approved.`
      );
      await load(business);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach Meta.");
    } finally {
      setBusy(false);
    }
  }

  const approved = templates.filter((t) => t.isApproved);
  const pending = templates.filter((t) => !t.isApproved && t.status !== "DELETED");

  return (
    <div className={`deck-root ${fontVariables}`}>
      <div className="act-root">

        <header className="act-head">
          <h1>Broadcasts</h1>
        </header>
        <p className="act-lede">
          Send one approved WhatsApp template to every contact of a business at once. Everything
          goes out from the shared number, so a customer sees the same sender they already know.
        </p>

        <div className="act-tabs">
          {TENANTS.map((tenant) => (
            <button
              key={tenant.slug}
              aria-pressed={business === tenant.slug}
              onClick={() => setBusiness(tenant.slug as BusinessSlug)}
            >
              {tenant.ref}
            </button>
          ))}
        </div>

        <div className="bc-syncbar">
          <button className="bc-sync" onClick={handleSync} disabled={busy}>
            {busy ? "Checking…" : "Check Meta for updates"}
          </button>
          <span className="act-sub">
            {templates[0]?.syncedAt
              ? `Last checked ${new Date(templates[0].syncedAt).toLocaleString()}`
              : "Never checked"}
          </span>
        </div>

        {loading ? (
          <div className="act-empty">Loading…</div>
        ) : (
          <>
            {!canSend ? (
              <section className="bc-gate">
                <h2>Sending is not open yet</h2>
                <p>
                  These are WhatsApp&apos;s requirements, and all three are settled in Meta&apos;s
                  own tools — not here. Until they are met, a send would be rejected by WhatsApp
                  rather than by this platform.
                </p>
                <ol>
                  <li className={approved.length ? "done" : ""}>
                    <b>An approved message template.</b>{" "}
                    {approved.length
                      ? `${approved.length} approved and ready.`
                      : pending.length
                        ? `${pending.length} submitted, awaiting Meta's review. Approval usually lands within a few hours.`
                        : "None submitted yet."}
                  </li>
                  <li>
                    <b>A verified business.</b> Business verification is currently incomplete —
                    Meta is asking for more information. Until it passes, business-initiated
                    messages stay blocked.
                  </li>
                  <li>
                    <b>A payment method on the WhatsApp account.</b> Without one, the account can
                    only reply to conversations customers start. Bulk sends are business-initiated,
                    so they need billing enabled.
                  </li>
                </ol>
                <a
                  className="bc-out"
                  href="https://business.facebook.com/wa/manage/message-templates/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Open WhatsApp Manager ↗
                </a>
              </section>
            ) : null}

            <section className="bc-compose">
              <h2 className="act-sub-head">Compose</h2>
              <div className="bc-row">
                <label>
                  <span>Template</span>
                  <select
                    value={templateId}
                    onChange={(event) => setTemplateId(event.target.value)}
                    disabled={!canSend}
                  >
                    {approved.length === 0 ? <option value="">No approved template</option> : null}
                    {approved.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.metaTemplateName} · {template.language}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="bc-audience">
                  <span className="act-sub">Audience</span>
                  <strong>
                    {reachable} {reachable === 1 ? "contact" : "contacts"}
                  </strong>
                </div>
                <button className="bc-send" onClick={handleSend} disabled={!canSend || !templateId || busy}>
                  {busy ? "Sending…" : "Send to all"}
                </button>
              </div>
              <p className="bc-warn">
                This goes to every contact of {label(business)} at once and cannot be recalled once
                queued.
              </p>
            </section>

            {error ? <p className="act-msg">{error}</p> : null}
            {notice ? <p className="bc-ok">{notice}</p> : null}

            <h2 className="act-sub-head">Templates</h2>
            {templates.length === 0 ? (
              <div className="act-empty">
                No templates yet. They are created at Meta and appear here once submitted.
              </div>
            ) : (
              <div className="act-table">
                <table>
                  <thead>
                    <tr>
                      <th>Template</th>
                      <th>Language</th>
                      <th>Category</th>
                      <th>Meta status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {templates.map((template) => (
                      <tr key={template.id}>
                        <td>{template.metaTemplateName}</td>
                        <td>{template.language}</td>
                        <td className={template.category ? "" : "act-zero"}>
                          {template.category ?? "—"}
                        </td>
                        <td>
                          <span className={`act-flag${template.isApproved ? "" : " warn"}`}>
                            {template.status ?? "unknown"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <h2 className="act-sub-head">Past sends</h2>
            {broadcasts.length === 0 ? (
              <div className="act-empty">Nothing sent yet.</div>
            ) : (
              <div className="act-table">
                <table>
                  <thead>
                    <tr>
                      <th>Template</th>
                      <th>Status</th>
                      <th>Recipients</th>
                      {/* ACCEPTED AND DELIVERED ARE TWO COLUMNS BECAUSE THEY ARE
                          TWO FACTS. This table had one, headed "Delivered", and
                          the number under it counted recipients marked 'sent' —
                          which is set the moment the Graph API returns 2xx, and
                          2xx means Meta took the message. Nothing had ever
                          written 'delivered' at all until migration 051, so the
                          column was a claim about receipt built entirely from
                          evidence of acceptance. */}
                      <th>Accepted</th>
                      <th>Delivered</th>
                      <th>Failed</th>
                      <th>Sent on</th>
                    </tr>
                  </thead>
                  <tbody>
                    {broadcasts.map((broadcast) => (
                      <tr key={broadcast.id}>
                        <td>{broadcast.templateName}</td>
                        <td>
                          <span className={`act-flag${broadcast.status === "failed" ? " warn" : ""}`}>
                            {broadcast.status}
                          </span>
                        </td>
                        <td>{broadcast.recipients}</td>
                        <td>{broadcast.sent}</td>
                        {/* An em dash rather than 0 where no receipt could have
                            been recorded. A campaign sent before 051 has a
                            genuine zero in the column and an unknown in
                            reality, and printing the zero would turn a gap in
                            the record into a statement that nobody received it. */}
                        <td className={broadcast.delivered ? "" : "act-zero"}>
                          {broadcast.sent > 0 && broadcast.delivered === 0 ? "—" : broadcast.delivered}
                        </td>
                        <td className={broadcast.failed ? "" : "act-zero"}>{broadcast.failed}</td>
                        <td>{new Date(broadcast.createdAt).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function label(slug: BusinessSlug) {
  return TENANTS.find((tenant) => tenant.slug === slug)?.name ?? slug;
}
