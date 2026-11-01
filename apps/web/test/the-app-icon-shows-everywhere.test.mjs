/**
 * The Nexus app icon (1 Nov 2026): the glass hexagon on warm near-black, in
 * the iPhone app-icon style, everywhere the app shows a face — every browser
 * tab, the iPhone home screen, Android and the installed app, notifications
 * and the offline page.
 *
 * Tabs had no icon at all before this (a blank page in every tab), so the
 * first assertion is that the tab is told where its icon is. The PNG sizes are
 * read from the files themselves: a 512 labelled 192 is a blurry icon nobody
 * notices until it is on someone's phone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const bytes = (path) => readFileSync(new URL(path, import.meta.url));

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path) {
  const b = bytes(path);
  assert.equal(b.subarray(1, 4).toString("ascii"), "PNG", `${path} is not a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

/** Whether a PNG's colour type carries alpha (6 = RGBA). */
const hasAlpha = (path) => bytes(path)[25] === 6;

test("every browser tab is told where the icon is", () => {
  const layout = read("../app/layout.tsx");
  assert.match(layout, /\{ url: "\/icons\/favicon\.svg", type: "image\/svg\+xml" \}/);
  assert.match(layout, /\{ url: "\/icons\/favicon-32\.png", sizes: "32x32", type: "image\/png" \}/);
  assert.match(layout, /apple: "\/icons\/apple-touch-icon\.png"/);
});

test("the tab icon is the glass hexagon, sharp at any size", () => {
  const svg = read("../public/icons/favicon.svg");
  assert.match(svg, /^<svg[^>]*viewBox="0 0 64 64"/);
  assert.match(svg, /<linearGradient/, "no glass gradient");
  assert.match(svg, /#16140F|#2C2821/i, "not on the warm near-black ground");
  assert.match(svg, /#E8C24A|#F6DA70/i, "no mustard core");
  assert.match(svg, /<polygon[^>]*points=/, "no hexagon");
});

test("each picture is the size it claims", () => {
  for (const [file, size] of [
    ["favicon-32.png", 32],
    ["apple-touch-icon.png", 180],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["icon-maskable-512.png", 512],
  ]) {
    assert.deepEqual(pngSize(`../public/icons/${file}`), [size, size], file);
  }
});

test("the iPhone gets a full square (it rounds the corners itself); tabs get the rounded shape", () => {
  // iOS fills transparent corners with black, so its icon must be opaque.
  assert.equal(hasAlpha("../public/icons/apple-touch-icon.png"), false, "apple-touch-icon has transparent corners");
  assert.equal(hasAlpha("../public/icons/icon-maskable-512.png"), false, "the maskable icon has transparent corners");
  // Tabs, notifications and the 'any' icons are drawn already rounded.
  assert.equal(hasAlpha("../public/icons/favicon-32.png"), true);
  assert.equal(hasAlpha("../public/icons/icon-192.png"), true);
});

test("the installed app wears Cream, not the old blue", () => {
  const manifest = read("../app/manifest.ts");
  assert.match(manifest, /theme_color: "#16140F"/);
  assert.match(manifest, /background_color: "#F3EFE8"/);
  const offline = read("../public/offline.html");
  assert.match(offline, /<meta name="theme-color" content="#16140F">/);
  assert.doesNotMatch(offline, /#0873c9|#f3f8fd/i);
});
