/**
 * Installing Nexus on a phone (spec 2026-10-09-nexus-mobile-app-design.md).
 *
 * Which offer a person sees is a pure decision, tested here directly: Chrome's
 * own install prompt when the browser offers one, a link to the iPhone guide in
 * Safari on an iPhone, and nothing once installed or dismissed. The banner's
 * first frame is also rendered, because a server-rendered offer that the
 * browser then hides is a flash and a hydration mismatch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { installChoice, InstallBanner } from "@/app/install-app";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0";

test("an iPhone in Safari is pointed to the install guide", () => {
  assert.equal(installChoice({ ua: IPHONE, standalone: false, dismissed: false, promptAvailable: false }), "ios-guide");
});

test("a browser that offers its own install prompt gets the Install button", () => {
  assert.equal(installChoice({ ua: ANDROID, standalone: false, dismissed: false, promptAvailable: true }), "prompt");
  assert.equal(installChoice({ ua: DESKTOP, standalone: false, dismissed: false, promptAvailable: true }), "prompt");
});

test("nothing is offered once installed, dismissed, or when there is nothing to offer", () => {
  assert.equal(installChoice({ ua: IPHONE, standalone: true, dismissed: false, promptAvailable: false }), "none");
  assert.equal(installChoice({ ua: ANDROID, standalone: false, dismissed: true, promptAvailable: true }), "none");
  assert.equal(installChoice({ ua: DESKTOP, standalone: false, dismissed: false, promptAvailable: false }), "none");
});

test("the first frame offers nothing, so the browser decides without a flash", () => {
  assert.equal(renderToStaticMarkup(createElement(InstallBanner)), "");
});
