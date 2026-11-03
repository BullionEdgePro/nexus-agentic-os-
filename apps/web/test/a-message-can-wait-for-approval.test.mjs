/**
 * An admin's own message to every chosen customer (3 Nov 2026): one action
 * sends it for approval and, once WhatsApp approves it, to the customers ticked
 * on the page; while it waits it shows in Recent campaigns and can be cancelled.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8");
const PANEL = read("app", "deck", "bulk", "new-approved.tsx");
const PAGE = read("app", "deck", "bulk", "page.tsx");
const API = read("lib", "api.ts");

test("with customers chosen, the panel offers to send to them once approved", () => {
  assert.match(PANEL, /Send for approval, then send to \$\{chosen\.length\} \$\{chosen\.length === 1 \? "customer" : "customers"\}/);
  assert.match(PANEL, /Only send for approval/);
  assert.match(PANEL, /sendTo: andSend \? chosen : undefined/);
  assert.match(PAGE, /<NewApproved[\s\S]*?chosen=\{chosen\.map\(\(person\) => person\.id\)\}/);
});

test("the client sends the chosen customers and reads back the wait", () => {
  assert.match(API, /input: \{ label: string; language: "en" \| "ar"; text: string; sendTo\?: string\[\] \}/);
  assert.match(API, /Promise<\{ name: string; status: string; waiting\?: \{ broadcastId: string; recipients: number \} \| null \}>/);
});

test("a waiting campaign reads as such and can be cancelled", () => {
  assert.match(PAGE, /scheduled: "Waiting for WhatsApp approval"/);
  assert.match(PAGE, /controlBroadcast\(campaign\.id, "stop"\)/);
  assert.match(PAGE, />\s*Cancel\s*</);
});
