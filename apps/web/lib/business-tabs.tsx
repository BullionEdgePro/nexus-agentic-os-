"use client";

import { useEffect, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import { getMe } from "@/lib/api";
import { TENANTS } from "@/lib/tenants";

/**
 * The business switcher, once, for every screen that has one.
 *
 * ============================================================
 * WHY THIS IS ONE COMPONENT
 * ============================================================
 *
 * Thirteen screens each rendered their own copy of the same five buttons. Two
 * things were wrong with all thirteen at once, and neither could be fixed in
 * one place because there was no one place.
 *
 * FIRST, THEY WERE LABELLED N-01 TO N-05. Internal reference codes on the
 * screen a person uses to choose which of their own companies they are looking
 * at. The owner reads "ABR Advocates"; nobody reads "N-05" without translating.
 *
 * SECOND, AND WORSE, THEY WERE ALL SHOWN TO EVERYONE. An employee of one
 * business saw five tabs, four of which answered 403. The API is scoped
 * correctly -- `requireTenantScope` refuses a slug outside the employee's own
 * business, and its header says why that is the half that matters -- so no data
 * leaked. What leaked was the impression of a broken product: buttons that
 * exist, look enabled, and fail.
 *
 * ============================================================
 * IT WAITS RATHER THAN GUESSING
 * ============================================================
 *
 * Until `me` arrives this renders nothing. The alternative -- assume operator
 * and show all five -- would flash every business's name at an employee for a
 * moment on every page load, which is the one thing the scoping exists to
 * prevent. Assuming the narrower thing instead would flicker the owner's own
 * tabs away and back on every navigation.
 *
 * Waiting is the honest third option: a switcher that is not yet knowable is
 * not yet drawn.
 */
export function BusinessTabs({
  value,
  onChange,
  includeAll = true,
  allLabel = "All businesses",
}: {
  value: BusinessSlug | "";
  onChange: (slug: BusinessSlug | "") => void;
  /** Some screens are meaningless without one business chosen. */
  includeAll?: boolean;
  allLabel?: string;
}) {
  const { businesses, isOperator, known } = useVisibleBusinesses();

  if (!known) return <div className="act-tabs bt-waiting" aria-hidden="true" />;

  // An employee has exactly one business, so a switcher is furniture. The name
  // is still shown -- on a platform where five companies share one number,
  // "which of them am I looking at" is worth answering even when the answer
  // cannot change.
  if (!isOperator) {
    return (
      <div className="act-tabs">
        <span className="bt-only">{businesses[0]?.name ?? "Your business"}</span>
      </div>
    );
  }

  return (
    <div className="act-tabs">
      {includeAll ? (
        <button type="button" aria-pressed={value === ""} onClick={() => onChange("")}>
          {allLabel}
        </button>
      ) : null}
      {businesses.map((tenant) => (
        <button
          key={tenant.slug}
          type="button"
          aria-pressed={value === tenant.slug}
          onClick={() => onChange(tenant.slug)}
        >
          {tenant.name}
        </button>
      ))}
    </div>
  );
}

/**
 * Which businesses this person may actually look at.
 *
 * `known` is the third state and the reason this is a hook rather than a
 * constant: "operator" and "employee" are answers, and "we have not been told
 * yet" is not either of them.
 */
export function useVisibleBusinesses() {
  const [role, setRole] = useState<"operator" | "employee" | null>(null);
  const [mine, setMine] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((me) => {
        if (cancelled) return;
        setRole(me.role);
        setMine(me.businessSlug);
      })
      // FAILS CLOSED. If we cannot establish who is asking, the narrow answer
      // is the safe one: show nothing rather than every business's name to
      // somebody whose role we could not read.
      .catch(() => {
        if (!cancelled) {
          setRole("employee");
          setMine(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isOperator = role === "operator";
  const businesses = isOperator
    ? TENANTS.filter((tenant) => tenant.status !== "offline")
    : TENANTS.filter((tenant) => tenant.slug === mine);

  return { businesses, isOperator, known: role !== null, mySlug: mine };
}
