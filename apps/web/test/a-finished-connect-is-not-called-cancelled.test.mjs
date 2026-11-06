/**
 * A WhatsApp connect Meta finished is not called "cancelled" (5 Nov 2026).
 *
 * +971 58 848 3731 (SFS International Real Estate LLC) was connected at Meta --
 * CONNECTED, on the Business app, our app receiving its webhooks -- and Nexus
 * never heard: no connect request reached the server, so no person held the
 * number and 34 customer messages in a day went to nobody. Meta's window had
 * finished (it says so in a window message) but its login callback came back
 * without the one-time code, and this file called that "cancelled" -- which
 * the screens then replaced with a generic "could not be connected".
 *
 * Now a finish without a code says what happened and what to do, and both
 * screens show the window's own words.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

// A browser with Meta's SDK already loaded; each run scripts what Meta does.
let script = () => {};
const listeners = new Set();
globalThis.window = {
  FB: { init() {}, login: (callback) => script(callback) },
  addEventListener: (type, fn) => type === "message" && listeners.add(fn),
  removeEventListener: (type, fn) => listeners.delete(fn),
};
const fromMeta = (payload) => {
  for (const fn of [...listeners]) fn({ origin: "https://www.facebook.com", data: JSON.stringify(payload) });
};
const finished = {
  type: "WA_EMBEDDED_SIGNUP",
  event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
  data: { phone_number_id: "1273619879166296", waba_id: "3575951989231746" },
};

const { launchWhatsAppSignup, SignupStopped } = await import("../lib/whatsapp-signup.ts");
const provider = { appId: "app", configId: "config", graphVersion: "v21.0" };

test("Meta finished but handed back no code: said plainly, with the way out", async () => {
  script = (callback) => {
    fromMeta(finished);
    callback({ authResponse: null });
  };
  await assert.rejects(launchWhatsAppSignup(provider), (err) => {
    assert.ok(err instanceof SignupStopped);
    assert.match(err.message, /Meta finished connecting/);
    assert.match(err.message, /not saved/);
    assert.match(err.message, /Connect WhatsApp again/);
    return true;
  });
});

test("Meta's finish arriving just after its callback is still heard (review, 5 Nov 2026)", async () => {
  script = (callback) => {
    callback({ authResponse: null });
    setTimeout(() => fromMeta(finished), 200);
  };
  await assert.rejects(launchWhatsAppSignup(provider), (err) => err instanceof SignupStopped && /Meta finished connecting/.test(err.message));
  assert.equal(listeners.size, 0, "the window message listener goes once it has decided");
});

test("closed before finishing: still cancelled", async () => {
  script = (callback) => {
    fromMeta({ type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: { current_step: "PHONE_NUMBER_SETUP" } });
    callback({ authResponse: null });
  };
  await assert.rejects(launchWhatsAppSignup(provider), (err) => err instanceof SignupStopped && /cancelled/.test(err.message));
});

test("a code comes back: the ids Meta sent ride along", async () => {
  script = (callback) => {
    fromMeta(finished);
    callback({ authResponse: { code: "one-time" } });
  };
  assert.deepEqual(await launchWhatsAppSignup(provider), {
    code: "one-time",
    wabaId: "3575951989231746",
    phoneNumberId: "1273619879166296",
  });
});

test("both screens show the window's own words instead of a generic failure", () => {
  for (const screen of ["../app/deck/my-clients/connections.tsx", "../app/deck/team/whatsapp-setup.tsx"]) {
    assert.match(read(screen), /instanceof SignupStopped/, `${screen} must show what Meta's window said`);
  }
});
