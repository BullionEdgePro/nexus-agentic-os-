import { fontVariables } from "@/lib/fonts";
import "./deck/deck.css";
import "./deck/error.css";

/**
 * A URL this console does not have.
 *
 * Next.js ships a default 404 and it is a bare black-on-white "This page could
 * not be found" with no styling, no navigation and no relation to anything
 * around it. Arriving at it from inside the console reads as having left the
 * product entirely, which for somebody who simply followed a stale link is a
 * worse answer than the truth.
 *
 * WHY THIS IS NOT AN ERROR. A 404 is the one failure here that is nobody's
 * fault and nothing to report: the address does not exist, and the only useful
 * thing to do is offer the way back. Wording it like a fault would send people
 * to report a mistyped URL.
 *
 * Deliberately links to Needs attention rather than the front page. Anyone
 * seeing this is already signed in and mid-task; the front page would be a
 * second dead end wearing a friendlier face.
 */
export default function NotFound() {
  return (
    <div className={`deck-root err-root ${fontVariables}`}>
      <div className="err-card">
        <p className="err-eyebrow">Not found</p>
        <h1 className="err-head">There is nothing at this address.</h1>
        <p className="err-body">
          The link may be out of date, or the screen it pointed at may have been renamed. Nothing
          has gone wrong and there is nothing to report.
        </p>

        <div className="err-actions">
          <a className="err-btn" href="/deck/operators">
            Go to Needs attention
          </a>
          <a className="err-btn ghost" href="/inbox">
            Go to the inbox
          </a>
        </div>
      </div>
    </div>
  );
}
