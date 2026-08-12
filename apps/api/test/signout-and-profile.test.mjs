// Sign out was broken in three separate ways at once, and the profile could not
// be edited by the person who owns the platform. Both reported from screenshots;
// neither produced an error anybody saw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const LOGOUT = read("apps", "web", "app", "api", "auth", "logout", "route.ts");
const SHELL = read("apps", "web", "app", "console-shell.tsx");
const MENUS = read("apps", "web", "app", "header-menus.tsx");
const ME = read("apps", "api", "src", "routes", "me.ts");

// ============================================================
// Sign out
// ============================================================

test("the route answers the verb the link actually sends", () => {
  // The rail rendered <a href="/api/auth/logout"> on every screen except the
  // front page, and the route exported only POST. Nine pages answered 405 —
  // a blank error, cookie untouched.
  assert.match(LOGOUT, /export async function GET/);
  assert.match(LOGOUT, /export async function POST/);
  // GET lands the browser back on `/` with a GET of its own.
  assert.match(LOGOUT, /status: 303/);
  // And is not cacheable, or a cached redirect could serve a page rendered
  // from the session this response destroyed.
  assert.match(LOGOUT, /"Cache-Control": "no-store"/);
});

test("the redirect goes somewhere the browser can reach", () => {
  // Production answered `303 -> https://61307059e8b2:3000/`. `new URL("/",
  // req.url)` builds an absolute address from the origin the PROCESS believes
  // it serves, which behind the proxy is the container's hostname. The status
  // code was right and the destination did not exist.
  //
  // A relative Location is resolved by the browser against the address it
  // actually requested, so it cannot be wrong regardless of what the proxy
  // forwards.
  assert.match(LOGOUT, /Location: "\/#signin"/);
  const code = LOGOUT.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  assert.ok(
    !/NextResponse\.redirect/.test(code),
    "redirect() forces an absolute URL built from the container's own origin"
  );
  assert.ok(!/new URL\(/.test(code), "no origin is reconstructed at all");
});

test("both verbs clear the cookie the same way", () => {
  // One helper, so a fix to one path cannot miss the other.
  assert.match(LOGOUT, /function clear\(res: NextResponse\): NextResponse/);
  assert.equal((LOGOUT.match(/return clear\(/g) ?? []).length, 2);
  // And the expiry string itself is built in one place, so the two scopes
  // cannot drift apart in their attributes.
  assert.match(LOGOUT, /function expire\(domain\?: string\): string/);
});

test("there is exactly one way to sign out, and it needs no JavaScript", () => {
  // It used to branch: an <a> with no href on the front page — clickable with
  // a mouse, invisible to a keyboard — and a GET link everywhere else.
  assert.match(SHELL, /<a href="\/api\/auth\/logout" title="Sign out">/);
  assert.ok(!/onSignOut=\{/.test(SHELL), "the rail must not take a click handler");
  assert.ok(!/href=\{onSignOut/.test(SHELL), "no conditional href");
  // The account panel uses the same route rather than its own fetch.
  assert.match(MENUS, /<a className="acct-out" href="\/api\/auth\/logout">/);
});

// ============================================================
// Profile
// ============================================================

test("email is shown and explained, never silently uneditable", () => {
  // A greyed-out box invites a click that does nothing and leaves the reason to
  // be guessed. It is rendered as text with the reason underneath.
  assert.match(MENUS, /<span>Email<\/span>/);
  assert.match(MENUS, /how you sign in — an operator changes it, not this form/);
});

test("a photo can be chosen from disk, resized in the browser", () => {
  // There is no object storage here. The file is drawn to a 256px canvas and
  // sent inline — a phone photo sent raw would be several megabytes and would
  // trip the size cap for no reason the person could act on.
  assert.match(MENUS, /function onPickFile/);
  assert.match(MENUS, /canvas\.toDataURL\("image\/jpeg", 0\.82\)/);
  assert.match(MENUS, /const size = 256;/);
  // Square crop from the centre rather than squashing a portrait.
  assert.match(MENUS, /const side = Math\.min\(img\.width, img\.height\)/);
  // The link field still exists for anything larger.
  assert.match(MENUS, /…or paste a link/);
});

test("the server accepts an uploaded image but refuses one that can execute", () => {
  // SVG is an image and is refused: it can carry <script>, and this value lands
  // in an <img src> on a page other staff load.
  // Substring, not a nested regex. Escaping a pattern that itself contains a
  // pattern is exactly how this assertion broke the first time.
  // The source escapes the slash inside its regex literal, so this checks the
  // two parts that carry the meaning rather than reproducing the escaping.
  assert.ok(ME.includes("(png|jpeg|webp)"), "the accepted formats must be an explicit allow-list");
  assert.ok(ME.includes(";base64,"), "an uploaded image arrives base64-encoded");
  const dataBranch = ME.slice(ME.indexOf('raw.startsWith("data:")'), ME.indexOf("A link. https only"));
  const code = dataBranch.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  assert.ok(!/svg/i.test(code), "svg must not be accepted — it can carry scripts");
  // And a stated cap rather than one discovered when a row stops fitting.
  assert.match(ME, /raw\.length > 200_000/);
});

test("an operator's number is stored but not claimed to route anywhere", () => {
  // Asked for, so it exists. Nothing reads it — unlike employees.whatsapp_number,
  // which the direct-contact link uses — so the UI says so rather than letting
  // somebody set it and wait for customers.
  assert.match(ME, /whatsappNumber: admin\?\.whatsappNumber/);
  assert.match(MENUS, /On record only — operators do not take customer handoffs\./);
  console.log("PASS: one sign-out path, and a profile the owner can actually edit");
});
