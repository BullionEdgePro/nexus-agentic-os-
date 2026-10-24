// A deploy checks its fonts instead of assuming them.
//
// FOUND 22 OCT 2026. next/font downloads the typefaces from Google at build
// time and, when that download fails, quietly falls back to system fonts: the
// build passes, build-check passes, and the site ships looking wrong. It failed
// on the first deploy of the day and on two of three builds an hour later. So
// the deploy asks the built CSS whether it holds the fonts and rebuilds the web
// image, uncached, until it does — and refuses to ship it if it never does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const DEPLOY = readFileSync(join(here, "..", "..", "..", "scripts", "deploy.sh"), "utf8");

test("the deploy reads the built CSS for the fonts", () => {
  assert.match(DEPLOY, /fonts_in_web\(\)/);
  assert.match(DEPLOY, /\/app\/apps\/web\/\.next\/static\/css\/\*\.css/);
  assert.match(DEPLOY, /@font-face/);
});

test("a build without fonts is rebuilt uncached, three tries at most, before anything restarts", () => {
  assert.match(DEPLOY, /for attempt in 1 2 3; do/);
  assert.match(DEPLOY, /\$COMPOSE build --no-cache web/);
  assert.ok(DEPLOY.indexOf("fonts_in_web") < DEPLOY.indexOf("$COMPOSE up -d"), "checked before the restart");
});

test("a web build that never gets its fonts is not deployed", () => {
  assert.match(DEPLOY, /still has no fonts after 3 tries/);
});

test("a build that FAILS on a font download is retried, not abandoned", () => {
  // 24 Oct 2026: the same Google Fonts outage that usually falls back
  // silently failed the web build outright ("Build failed because of webpack
  // errors"); a second run a minute later built cleanly.
  assert.match(DEPLOY, /for build_attempt in 1 2 3; do/);
  assert.match(DEPLOY, /\$COMPOSE build api worker web && break/);
});
