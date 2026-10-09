// Nexus as an app on a phone (spec 2026-10-09-nexus-mobile-app-design.md).
// Installing needs an identity the phone recognises: a manifest naming the app,
// where it starts and how it opens, icons at the sizes Android and iOS ask for,
// and the iOS meta that makes Add to Home Screen open full screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const web = (...p) => join(root, "apps", "web", ...p);
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/** Width and height from a PNG's IHDR chunk (bytes 16-23). */
function pngSize(file) {
  const b = readFileSync(file);
  assert.equal(b.toString("ascii", 1, 4), "PNG", `${file} is not a PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

test("the app has an installable identity", () => {
  const manifest = read(web("app", "manifest.ts"));
  assert.match(manifest, /name: "Nexus"/);
  assert.match(manifest, /short_name: "Nexus"/);
  assert.match(manifest, /start_url: "\/inbox"/);
  assert.match(manifest, /display: "standalone"/);
  assert.match(manifest, /src: "\/icons\/icon-192\.png", sizes: "192x192"/);
  assert.match(manifest, /src: "\/icons\/icon-512\.png", sizes: "512x512"/);
  assert.match(manifest, /src: "\/icons\/icon-maskable-512\.png", sizes: "512x512", type: "image\/png", purpose: "maskable"/);

  for (const [file, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["icon-maskable-512.png", 512], ["apple-touch-icon.png", 180]]) {
    const path = web("public", "icons", file);
    assert.ok(existsSync(path), `${file} is missing`);
    assert.deepEqual(pngSize(path), { w: size, h: size }, `${file} must be ${size}x${size}`);
  }
});

test("iPhone treats it as an app", () => {
  const layout = read(web("app", "layout.tsx"));
  assert.match(layout, /appleWebApp: \{[^}]*capable: true/);
  assert.match(layout, /apple-touch-icon\.png/);
  assert.match(layout, /export const viewport: Viewport/);
  assert.match(layout, /themeColor/);
});

// ============================================================
// The service worker: push in, notification out, never a private cache
// ============================================================

const swPath = web("public", "sw.js");
const sw = () => read(swPath);

test("the service worker never caches private data", () => {
  const src = sw();
  // The only thing ever precached is the offline page.
  assert.match(src, /const PRECACHE = \["\/offline\.html"\];/);
  assert.equal((src.match(/cache\.addAll\(/g) ?? []).length, 1);
  assert.match(src, /cache\.addAll\(PRECACHE\)/);
  assert.ok(!/cache\.put\(/.test(src), "nothing fetched at runtime is ever written to a cache");
  // API traffic is never even intercepted.
  assert.match(src, /url\.pathname\.startsWith\("\/api"\)/);
  assert.match(src, /url\.hostname === "api\.nexusagenticos\.com"/);
});

test("a push becomes a notification that opens the chat", () => {
  const src = sw();
  assert.match(src, /self\.addEventListener\("push"/);
  assert.match(src, /showNotification\(data\.title/);
  assert.match(src, /tag: data\.tag/);
  assert.match(src, /data: \{ url: data\.url \}/);
  assert.match(src, /self\.addEventListener\("notificationclick"/);
  assert.match(src, /clients\.openWindow\(/);
  assert.match(src, /\.navigate\(/);
});

test("offline shows a page that says so", () => {
  const offline = read(web("public", "offline.html"));
  assert.match(offline, /You're offline\. Nexus will reconnect when you're back online\./);
  assert.match(sw(), /request\.mode === "navigate"/);
});

test("the worker is registered once, from the root, and never served stale", () => {
  const reg = read(web("app", "sw-register.tsx"));
  assert.match(reg, /"serviceWorker" in navigator/);
  assert.match(reg, /navigator\.serviceWorker\.register\("\/sw\.js", \{ scope: "\/" \}\)/);
  assert.match(read(web("app", "layout.tsx")), /<ServiceWorkerRegister \/>/);
  const config = read(web("next.config.mjs"));
  assert.match(config, /source: "\/sw\.js"/);
  assert.match(config, /"Cache-Control", value: "no-cache"/);
});
