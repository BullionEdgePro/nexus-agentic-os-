/**
 * The org charts, rendered for real (owner-approved 14 Oct 2026): a "Team &
 * structure" tab per company with the owner on top, live badges and vacancies;
 * and one group chart of every company under the owner.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { OrgChartView, HqGroupChart } from "@/app/deck/hq/org-chart";

const node = (id, kind, name, title, over = {}) => ({ id, kind, name, title, department: null, avatarUrl: null, onShift: null, whatsappConnected: null, onNexus: kind === "staff", memberId: null, children: [], ...over });

const CHART = {
  headcount: 4,
  vacancies: 1,
  departments: ["Sales"],
  root: node("owner", "owner", "Atif Ali Ali Said", "Owner of all 5 companies", {
    children: [
      node("e:e2", "staff", "Aqib Sarosh", "Operations", {
        onShift: true,
        whatsappConnected: true,
        children: [
          node("e:e1", "staff", "Abdul Basit", "Real Estate Agent", { department: "Sales", onShift: false, whatsappConnected: true }),
          node("m:v1", "vacancy", "Hiring: Marketing manager", null, { memberId: "v1" }),
        ],
      }),
      node("m:p1", "manual", "Sara K.", "Accountant", { memberId: "p1", department: "Finance" }),
    ],
  }),
};

const render = (chart = CHART) => renderToStaticMarkup(createElement(OrgChartView, { slug: "sfs-international", chart, onChanged: () => {} }));

test("the owner is on top of the company, named as owner of every company", () => {
  const html = render();
  assert.match(html, /Atif Ali Ali Said/);
  assert.match(html, /Owner of all 5 companies/);
  assert.ok(html.indexOf("Atif Ali Ali Said") < html.indexOf("Aqib Sarosh"), "the owner comes first");
});

test("people show their title, department and live badges", () => {
  const html = render();
  for (const text of ["Aqib Sarosh", "Operations", "Abdul Basit", "Real Estate Agent", "Sales", "On shift", "WhatsApp"]) assert.ok(html.includes(text), text);
});

test("people not on Nexus and open roles are marked as such", () => {
  const html = render();
  assert.match(html, /Sara K\./);
  assert.match(html, /Not on Nexus/);
  assert.match(html, /Hiring: Marketing manager/);
  assert.match(html, /hq-org-card vacancy/);
});

test("the summary counts people and open roles", () => {
  const html = render();
  assert.match(html, /4 people/);
  assert.match(html, /1 open role/);
});

test("a company with no team says so and offers the first step", () => {
  const html = render({ headcount: 0, vacancies: 0, departments: [], root: node("owner", "owner", "Atif Ali Ali Said", "Owner of all 5 companies") });
  assert.match(html, /No team yet — add the first person/);
});

test("the group chart puts every company under the owner", () => {
  const html = renderToStaticMarkup(createElement(HqGroupChart, {
    group: {
      owner: { name: "Atif Ali Ali Said", title: "Owner" },
      companies: [
        { slug: "sfs-international", name: "SFS International", logoUrl: null, headcount: 3, vacancies: 0, departments: [] },
        { slug: "abr", name: "ABR Advocates", logoUrl: null, headcount: 0, vacancies: 0, departments: [] },
      ],
    },
  }));
  assert.match(html, /Atif Ali Ali Said/);
  assert.match(html, /Owner of 2 companies/);
  assert.match(html, /SFS International/);
  assert.match(html, /3 people/);
  assert.match(html, /No team yet/);
  assert.match(html, /href="\/deck\/hq\/sfs-international#team"/);
});
