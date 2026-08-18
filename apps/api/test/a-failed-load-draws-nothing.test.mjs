// Switch business, have the request fail, and the deck showed the PREVIOUS
// business's numbers under the new one's name.
//
// Found on 2026-08-18 by continuing the sweep for claims that are asserted
// rather than measured. Every deck page with a business selector had the same
// shape:
//
//   catch (err) { setError(...) }          // data left exactly as it was
//   ...
//   {error ? <p>{error}</p> : null}        // a red line ABOVE the stale data
//   {loading ? ... : <the previous tenant's figures>}
//
// One tenant's containment rate, follow-ups, diary or campaign gate attributed
// to another — arriving through the UI rather than through the database that
// spent a whole feature preventing exactly that.
//
// CLEARING THE DATA WOULD HAVE BEEN WORSE. The page would fall through to its
// empty state and say "nothing needs attention" or "no conversations to
// measure" when the truth is "nobody could ask" — the two silences the
// operators panel was fixed for the same morning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

/** Every deck page that switches between businesses. */
const PAGES = [
  "quality",
  "activity",
  "operators",
  "procedures",
  "knowledge",
  "forecast",
  "tasks",
  "bookings",
  "catalogue",
  "broadcasts",
];

const pageSource = (name) => read("apps", "web", "app", "deck", name, "page.tsx");

test("every page keeps a failed LOAD apart from a failed ACTION", () => {
  // One `error` for both would blank the whole screen when a recompute, a send
  // or a save failed — losing the context the message is about, on a page that
  // is still perfectly correct.
  for (const name of PAGES) {
    const src = pageSource(name);
    assert.match(src, /const \[loadError, setLoadError\] = useState\(""\);/, `${name} has no loadError`);
    assert.match(src, /setLoadError\(""\);/, `${name} does not reset loadError when a load starts`);
  }
});

test("the load's catch sets loadError, not the shared one", () => {
  // The whole fix turns on this: if the load still wrote to `error`, the gate
  // below would never fire and the stale data would stay.
  for (const name of PAGES) {
    const src = pageSource(name);
    const load = src.slice(src.indexOf("const load = useCallback"));
    const body = load.slice(0, load.indexOf("}, ["));
    assert.match(body, /catch \(err\) \{\s*\n?\s*setLoadError\(/, `${name}'s load catch does not set loadError`);
  }
});

test("nothing below is drawn when the load failed", () => {
  for (const name of PAGES) {
    const src = pageSource(name);
    // Either the gate before the loading branch, or — where the page's error
    // line sat inside the loaded branch — a loadError arm in the same ternary.
    const gated =
      /\{loadError \? null : loading \? \(/.test(src) || /\) : loadError \? \(/.test(src);
    assert.ok(gated, `${name} still draws its content after a failed load`);
  }
});

test("the message itself is still shown", () => {
  // Refusing to draw the data must not also swallow the reason. A blank screen
  // with no explanation is its own version of this bug.
  for (const name of PAGES) {
    assert.match(pageSource(name), /\{loadError\}/, `${name} never renders the load error`);
  }
});
