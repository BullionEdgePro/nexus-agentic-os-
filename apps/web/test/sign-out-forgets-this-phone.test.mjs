/**
 * Signing out forgets this phone (phone push review fix, 4 Nov 2026).
 *
 * Sign-out only cleared the cookie, so on a shared phone the last person's
 * alerts -- an admin's chats nobody has taken, message text and all -- kept
 * arriving on the lock screen for whoever signed in next. Now each sign-out link
 * first tells the server to forget this phone (while the session still exists),
 * unsubscribes it in the browser, then signs out. It never holds sign-out up:
 * a server that refuses or never answers still ends signed out, and the link
 * still works as a plain link if the handler never runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { signOutThisBrowser } from "@/lib/sign-out";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const ADDRESS = "https://fcm.googleapis.com/fcm/send/this-phone";

function browser({ subscribed = true, forget = async () => ({ ok: true }) } = {}) {
  const steps = [];
  return {
    steps,
    deps: {
      subscription: async () =>
        subscribed
          ? {
              endpoint: ADDRESS,
              unsubscribe: async () => {
                steps.push("unsubscribe");
                return true;
              },
            }
          : null,
      forget: async (endpoint) => {
        steps.push(`forget ${endpoint}`);
        return forget();
      },
      navigate: (url) => steps.push(`go ${url}`),
      wait: 50,
    },
  };
}

test("signing out forgets this phone on the server, unsubscribes it, then signs out", async () => {
  const b = browser();
  await signOutThisBrowser(b.deps);
  assert.deepEqual(b.steps, [`forget ${ADDRESS}`, "unsubscribe", "go /api/auth/logout"]);
});

test("a server that refuses still leaves the phone unsubscribed and the person signed out", async () => {
  const b = browser({
    forget: async () => {
      throw new Error("503");
    },
  });
  await signOutThisBrowser(b.deps);
  assert.deepEqual(b.steps, [`forget ${ADDRESS}`, "unsubscribe", "go /api/auth/logout"]);
});

test("a server that never answers does not hold sign-out up", async () => {
  const b = browser({ forget: () => new Promise(() => undefined) });
  await signOutThisBrowser(b.deps);
  assert.deepEqual(b.steps, [`forget ${ADDRESS}`, "unsubscribe", "go /api/auth/logout"]);
});

test("a browser with no alerts just signs out", async () => {
  const b = browser({ subscribed: false });
  await signOutThisBrowser(b.deps);
  assert.deepEqual(b.steps, ["go /api/auth/logout"]);
});

test("every sign-out link runs it, and is still a plain link if the handler never does", () => {
  for (const file of ["app/console-shell.tsx", "app/header-menus.tsx", "app/phone-menu.tsx"]) {
    const links = read(file).match(/<a[^>]*href="\/api\/auth\/logout"[^>]*>/g) ?? [];
    assert.ok(links.length >= 1, `${file} has its sign-out link`);
    for (const link of links) assert.match(link, /onClick=\{signOutHere\}/, file);
  }
});

test("the server is asked at /api/me/push/forget", () => {
  const api = read("lib/api.ts");
  const at = api.indexOf("export function forgetPushDevice(");
  assert.ok(at > 0, "forgetPushDevice exists");
  assert.match(api.slice(at, at + 300), /\/api\/me\/push\/forget/);
});
