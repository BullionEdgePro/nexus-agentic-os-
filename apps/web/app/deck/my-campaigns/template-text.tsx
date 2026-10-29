"use client";

import { useEffect, useState } from "react";
import { readableError, type TemplateWording } from "@/lib/api";
import { fillPlaceholders } from "@/lib/template-placeholders";
import "./template-text.css";

/**
 * What an approved message actually says, shown under the picker (29 Oct 2026).
 *
 * The pickers listed Meta's names only — `zipicka_promotions` — so a person
 * chose what to send their whole book by a filename. This reads the wording
 * from WhatsApp and lays it out as the customer will see it: the first
 * placeholder filled with a sample first name (Nexus fills it with each
 * person's own), any further ones shown as the dash Nexus sends.
 */
export function TemplateText({
  load,
  loadKey,
  sampleName,
}: {
  /** Fetches the wording; called again whenever `loadKey` changes. */
  load: () => Promise<TemplateWording>;
  loadKey: string;
  sampleName: string | null;
}) {
  const [wording, setWording] = useState<TemplateWording | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setWording(null);
    setError(null);
    load()
      .then((result) => {
        if (!cancelled) setWording(result);
      })
      .catch((err) => {
        if (!cancelled) setError(readableError(err, "Could not read this message's wording."));
      });
    return () => {
      cancelled = true;
    };
    // `load` is a fresh closure every render; the key says when it really changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  if (error) return <p className="tpl-text-note">{error}</p>;
  if (!wording) return <p className="tpl-text-note">Reading the message from WhatsApp…</p>;

  const { header, body, footer, buttons } = wording.text;
  return (
    <div className="tpl-text" aria-label="What this message says">
      <span className="tpl-text-label">What your client will read</span>
      <div className="tpl-text-bubble">
        {header ? <strong>{fillPlaceholders(header, sampleName)}</strong> : null}
        <p>{fillPlaceholders(body, sampleName)}</p>
        {footer ? <small>{footer}</small> : null}
      </div>
      {buttons.length ? (
        <div className="tpl-text-buttons">
          {buttons.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      ) : null}
      {wording.bodyParamCount > 0 ? (
        <em className="tpl-text-note">
          {wording.bodyParamCount === 1
            ? "The name is filled in with each client's first name."
            : "The first blank is each client's first name; the others are sent as “-”."}
        </em>
      ) : null}
    </div>
  );
}
