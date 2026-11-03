"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getHqBusiness, readableError, type HqBusinessDetail } from "@/lib/api";
import { fontVariables } from "@/lib/fonts";
import { HqBusinessView, tabsFor, type HqTab } from "./tabs";
import "../../deck.css";
import "../hq.css";
// The Workflow tab's panel brings no styles of its own (3 Nov 2026).
import "../../activity/activity.css";
import "../../../kit/kit.css";
import "../../workflow/workflow.css";

/** One business's Business HQ dashboard (admins only). The tab lives in the URL hash. */
export default function HqBusinessPage() {
  const { slug } = useParams<{ slug: string }>();
  const [data, setData] = useState<HqBusinessDetail | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<HqTab>("overview");

  const load = useCallback(() => {
    getHqBusiness(slug)
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((err) => setError(readableError(err)));
  }, [slug]);

  useEffect(() => {
    load();
    const fromHash = window.location.hash.slice(1) as HqTab;
    // This business's own tabs: #workflow only where a workflow is drawn.
    if (tabsFor(slug).some((t) => t.id === fromHash)) setTab(fromHash);
  }, [load]);

  const changeTab = (next: HqTab) => {
    setTab(next);
    history.replaceState(null, "", `#${next}`);
  };

  return (
    <div className={`deck-root ${fontVariables}`}>
      <div className="hq-root">
        {error ? <p className="hq-error">{error}</p> : null}
        {!data && !error ? <p className="hq-loading">Opening this business…</p> : null}
        {data ? <HqBusinessView data={data} tab={tab} onTab={changeTab} onChanged={load} /> : null}
      </div>
    </div>
  );
}
