// A phone that can be told (spec 2026-10-09-nexus-mobile-app-design.md,
// "Push notifications", data). One row per installed device that said yes to
// notifications, keyed by the push service's endpoint so a phone that
// re-subscribes refreshes its row instead of becoming two devices that both
// buzz. A row belongs to ONE person (the session that registered it), and
// nothing here lets one person read, change or remove someone else's device.
// Pinned as text: the migration runs as the owner via psql, and the module's
// guarantees live in its SQL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8").replace(/\r\n/g, "\n");
const MIGRATION = read("packages", "db", "migrations", "095-a-phone-that-can-be-told.sql");
const MODULE = read("packages", "db", "src", "push-subscriptions.ts");
const INDEX = read("packages", "db", "src", "index.ts");

/** The body of one exported function, up to the next top-level export. */
function fn(name) {
  const at = MODULE.indexOf(`export async function ${name}(`);
  assert.ok(at > -1, `${name} is exported`);
  const next = MODULE.indexOf("\nexport ", at + 1);
  return MODULE.slice(at, next === -1 ? undefined : next);
}

test("a device is one row, however many times it subscribes", () => {
  assert.match(MIGRATION, /create table if not exists push_subscriptions/);
  assert.match(MIGRATION, /endpoint\s+text not null unique/);
  assert.match(MIGRATION, /subject_kind\s+text not null check \(subject_kind in \('employee', ?'operator'\)\)/);
  assert.match(MIGRATION, /subject_id\s+text not null/);
  // The same key readerOf gives a person everywhere else, so a session's
  // identity and a device's owner compare as one string.
  assert.match(MIGRATION, /case subject_kind when 'employee' then 'e:' else 'o:' end \|\| subject_id/);
});

test("a new device stays quiet about message text and alerts only for its own chats", () => {
  assert.match(MIGRATION, /mode\s+text not null default 'mine' check \(mode in \('mine', ?'all', ?'paused'\)\)/);
  assert.match(MIGRATION, /previews\s+boolean not null default false/);
});

test("devices are tenant data behind row-level security", () => {
  assert.match(MIGRATION, /alter table push_subscriptions enable row level security/);
  assert.match(MIGRATION, /create policy push_subscriptions_tenant_isolation on push_subscriptions/);
  assert.match(MIGRATION, /organization_id::text = current_setting\('app\.current_org', true\)/);
  assert.match(MIGRATION, /current_setting\('app\.tenant_scope', true\) = 'all'/);
  assert.match(MIGRATION, /grant select, insert, update, delete on push_subscriptions to nexus_app/);
});

test("re-subscribing refreshes the keys and keeps the person's choices", () => {
  const body = fn("upsertPushSubscription");
  assert.match(body, /on conflict \(endpoint\) do update/);
  const update = body.slice(body.indexOf("do update"));
  assert.ok(!/previews\s*=/.test(update), "previews survives a re-subscribe");
  assert.ok(!/mode\s*=/.test(update), "mode survives a re-subscribe");
});

test("only the person who owns a device can change or remove it", () => {
  assert.match(fn("updatePushPreferences"), /and subject = \$\d/);
  assert.match(fn("deletePushSubscription"), /and subject = \$\d/);
});

test("a dead device is dropped and a failing one is counted", () => {
  const body = fn("recordPushOutcome");
  assert.match(body, /delete from push_subscriptions/);
  assert.match(body, /failure_count = failure_count \+ 1/);
  assert.match(body, /last_success_at = now\(\), failure_count = 0/);
});

test("finding who to tell crosses businesses only with a reason", () => {
  assert.match(fn("listPushSubscriptionsForSubjects"), /withAllTenants\("push: who to tell"/);
  assert.match(INDEX, /export \* from "\.\/push-subscriptions\.js";/);
});
