"use client";

import { useEffect, useState } from "react";
import { getHqOverview, getHqGroup, readableError, type HqCard, type HqGroupView } from "@/lib/api";
import { fontVariables } from "@/lib/fonts";
import { HqOverview } from "./overview";
import { HqGroupChart } from "./org-chart";
import "../deck.css";
import "./hq.css";

/**
 * Business HQ — every business you run, worst first (admins only).
 * Each card opens that business's dashboard: website, SEO, socials, vault.
 */
export default function BusinessHqPage() {
  const [businesses, setBusinesses] = useState<HqCard[] | null>(null);
  const [error, setError] = useState("");
  const [group, setGroup] = useState<HqGroupView | null>(null);

  useEffect(() => {
    let live = true;
    getHqOverview()
      .then((data) => live && setBusinesses(data.businesses))
      .catch((err) => live && setError(readableError(err)));
    // The group chart is a bonus view: if it fails, the business cards still show.
    getHqGroup()
      .then((g) => live && setGroup(g))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const needing = businesses?.filter((b) => b.topIssues.some((i) => i.severity !== "notice")).length ?? 0;

  return (
    <div className={`deck-root ${fontVariables}`}>
      <div className="hq-root">
        <header className="hq-head">
          <p className="hq-eyebrow">Admins only</p>
          <h1>Business HQ</h1>
          <p className="hq-lede">
            Every business's website, Google presence, social accounts and logins in one place. Nexus checks each
            website every morning at 6 and tells you before a domain, a certificate or an idle profile costs you.
          </p>
          {businesses ? (
            <p className="hq-summary">
              {needing === 0 ? "Nothing urgent across your businesses." : `${needing} of ${businesses.length} businesses need you.`}
            </p>
          ) : null}
        </header>
        {error ? <p className="hq-error">{error}</p> : null}
        {!businesses && !error ? <p className="hq-loading">Checking your businesses…</p> : null}
        {businesses ? <HqOverview businesses={businesses} /> : null}
        {group ? (
          <>
            <h2 className="hq-section-title">Group structure</h2>
            <HqGroupChart group={group} />
          </>
        ) : null}
      </div>
    </div>
  );
}
