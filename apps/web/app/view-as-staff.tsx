"use client";

import { useCallback, useEffect, useState } from "react";
import { viewingAs, setViewingAs } from "@/lib/api";
import { TENANTS } from "@/lib/tenants";

/**
 * Seeing the console the way one business's staff see it.
 *
 * ============================================================
 * THE BANNER IS THE FEATURE
 * ============================================================
 *
 * The switch itself is four lines. What matters is that somebody in a preview
 * cannot forget they are in one.
 *
 * An operator looking at a narrowed console has every reason to misread it. The
 * screens are the same screens; the numbers are smaller and still plausible;
 * "no customers waiting" is exactly as reassuring as it always is. Left
 * unlabelled, this feature would eventually have an owner conclude their
 * platform was quiet when they were looking at one fifth of it — which is the
 * sentence this whole deck is built to stop being said falsely.
 *
 * So the banner is loud, it names the business, it is on every page, and the
 * way out is in it.
 *
 * ============================================================
 * WHAT IT CANNOT SHOW, SAID OUT LOUD
 * ============================================================
 *
 * The preview has no employee identity — the owner is not one of their own
 * staff. Anything keyed on "assigned to me" is therefore empty, and an empty
 * follow-up list is the kind of thing that reads as a fact about the business
 * rather than a limit of the view. The banner says which it is, because
 * nothing else on the screen can.
 */
export function ViewAsStaff() {
  const [slug, setSlug] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Read after mount: sessionStorage does not exist during the server render,
  // and guessing either way would flash the wrong state.
  useEffect(() => {
    setSlug(viewingAs());
  }, []);

  const start = useCallback((next: string) => {
    setViewingAs(next);
    // A full reload rather than a re-render. Every screen has already fetched
    // its data with the operator's access; leaving those in place would mix two
    // scopes on one page, which is precisely the confusion this exists to end.
    window.location.reload();
  }, []);

  const stop = useCallback(() => {
    setViewingAs(null);
    window.location.reload();
  }, []);

  if (slug) {
    const business = TENANTS.find((tenant) => tenant.slug === slug);
    return (
      <div className="vas-banner" role="status">
        <strong>Viewing as staff at {business?.name ?? slug}</strong>
        <span>
          This is what an employee of that business sees — the API is scoped, not just the screen.
          Anything assigned to a specific person is empty, because you are not one of them.
        </span>
        <button type="button" onClick={stop}>
          Back to my own view
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" className="vas-open" onClick={() => setOpen(true)}>
        View as staff
      </button>
    );
  }

  return (
    <div className="vas-pick">
      <span>See the console as staff at:</span>
      {TENANTS.filter((tenant) => tenant.status !== "offline").map((tenant) => (
        <button key={tenant.slug} type="button" onClick={() => start(tenant.slug)}>
          {tenant.name}
        </button>
      ))}
      <button type="button" className="vas-cancel" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}
