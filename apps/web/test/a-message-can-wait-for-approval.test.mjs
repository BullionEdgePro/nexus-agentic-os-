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

test("Check again says a released message is going out, and does not offer it for a second send", () => {
  // Review, 3 Nov 2026: it chose the just-approved message with the customers
  // still ticked, one click from sending it to them again.
  const check = PANEL.slice(PANEL.indexOf("async function checkAgain"), PANEL.indexOf("async function fixWithAi"));
  assert.match(check, /const released = fresh\.released \?\? \[\];/);
  assert.match(check, /is going to \$\{going\} \$\{going === 1 \? "customer" : "customers"\} now/);
  assert.match(check, /if \(going\) \{[\s\S]*?onChanged\(\);/);
  assert.match(check, /held\[0\]\.reason/);
  // The approved message is named by its words, not WhatsApp's code name.
  assert.match(check, /templateOptionLabel\(approved\.name, approved\.language\)/);
  assert.match(API, /released\?: Array<\{ broadcastId: string; templateId: string; recipients: number \}>/);
});

test("a campaign that starts waiting, or goes out, shows in Recent campaigns at once", () => {
  assert.match(PANEL, /onCampaignsChanged: \(\) => void;/);
  const submit = PANEL.slice(PANEL.indexOf("async function submit"), PANEL.indexOf("async function checkAgain"));
  assert.match(submit, /if \(sent\.waiting\) onCampaignsChanged\(\);/);
  const check = PANEL.slice(PANEL.indexOf("async function checkAgain"), PANEL.indexOf("async function fixWithAi"));
  assert.match(check, /onCampaignsChanged\(\);/);
  assert.match(PAGE, /<NewApproved[\s\S]*?onCampaignsChanged=\{onSent\}/);
  // The check the page makes by itself on opening a number reloads them too.
  assert.match(PAGE, /if \(fresh\.released\?\.length\) void loadOverview\(business\);/);
});

test("a waiting campaign reads as such and can be cancelled", () => {
  assert.match(PAGE, /scheduled: "Waiting for WhatsApp approval"/);
  assert.match(PAGE, /controlBroadcast\(campaign\.id, "stop"\)/);
  assert.match(PAGE, />\s*Cancel\s*</);
});
