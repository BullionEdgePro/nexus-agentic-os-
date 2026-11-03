/**
 * An admin connects like staff (3 Nov 2026, spec
 * 2026-11-03-admin-connections-design.md §2): Connections is in the admin's
 * sidebar too, an admin picks which business they are connecting for, and every
 * call names it. Staff see no picker and no change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { connectionsPath, setConnectionsBusiness } from "@/lib/api";
import { BusinessPicker } from "@/app/deck/my-clients/connections";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Connections is in both sidebars", () => {
  const nav = read("lib/nav.tsx");
  const at = nav.indexOf('href: "/deck/connections"');
  const item = nav.slice(at, nav.indexOf("icon:", at));
  assert.doesNotMatch(item, /staffOnly|operatorOnly/);
});

test("an admin's calls name the business; staff's never do", () => {
  setConnectionsBusiness(null);
  assert.equal(connectionsPath("/api/connections/gmail/start"), "/api/connections/gmail/start");
  setConnectionsBusiness("sfs-international");
  assert.equal(connectionsPath("/api/connections/gmail/start"), "/api/connections/gmail/start?business=sfs-international");
  assert.equal(connectionsPath("/api/connections?x=1"), "/api/connections?x=1&business=sfs-international");
  setConnectionsBusiness(null);
  const api = read("lib/api.ts");
  assert.equal((api.match(/request\("\/api\/connections/g) ?? []).length, 0, "a connections call bypasses connectionsPath");
  assert.equal((api.match(/request\(connectionsPath\("\/api\/connections/g) ?? []).length, 18);
});

test("the picker is a labelled choice of every business", () => {
  const html = renderToStaticMarkup(
    createElement(BusinessPicker, {
      businesses: [
        { slug: "sfs-international", name: "SFS International" },
        { slug: "zipicka", name: "Zipicka" },
      ],
      value: "zipicka",
      onChange: () => undefined,
    })
  );
  assert.match(html, /<label class="cnx-business"><span>Connect for<\/span><select>/);
  assert.match(html, /<option value="sfs-international">SFS International<\/option>/);
  assert.match(html, /<option value="zipicka" selected="">Zipicka<\/option>/);
});

test("only an admin sees the picker, and an unchosen business shows no cards", () => {
  const panel = read("app/deck/my-clients/connections.tsx");
  assert.match(panel, /businesses \? \(\s*<BusinessPicker/);
  assert.match(panel, /"nexus-connections-business"/);
  assert.match(panel, /Choose a business to connect your accounts for\./);
  // Storage can throw (private mode): both the write and the read are wrapped.
  assert.match(panel, /try \{\s*if \(slug\) localStorage\.setItem\(BUSINESS_KEY, slug\);/);
  assert.match(panel, /try \{\s*setConnectionsBusiness\(localStorage\.getItem\(BUSINESS_KEY\)\);/);
});

test("an admin's seat says Admin on the Team screen", () => {
  const team = read("app/deck/team/team-workspace.tsx");
  assert.match(team, /member\.adminId && member\.jobTitle !== "Admin" \? " · Admin" : ""/);
  assert.match(read("lib/api.ts"), /export interface TeamMember \{[\s\S]*?adminId\?: string \| null;/);
});
