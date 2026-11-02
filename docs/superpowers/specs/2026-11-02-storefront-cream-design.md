# The storefront in Cream — design

Date: 2 Nov 2026 · Part 3 of the Cream redesign (part 1: foundation, live; part 2a:
six admin pages, live at 3ff79ef). Approved in conversation section by section.

## What it is for

The public storefront at nexusagenticos.com becomes a **product site that wins other
businesses**: a business owner should understand what Nexus does within seconds, see the
real product rather than stock images, and tap **WhatsApp** to talk to it. Staff and admin
sign-in stay, but are secondary.

What the owner said: product site first; get in touch by **chatting on WhatsApp**; the
number comes from **a site setting filled in later** (email until then); restyle **in
place** (today's sections and animations, recoloured); light and dark **follow the
visitor**, with the sun/moon switch; this round covers the storefront **plus the admin and
staff sign-in**. Assumptions: only true claims and numbers; sign-in behaviour unchanged;
phone first; reduced motion respected.

Out of scope this round: /links (customer links and QR), privacy, terms, data deletion,
the 404 and error pages (they keep today's look).

## 1. Look and theme

- The storefront's own Clear Sky palette (`.deck-root.lp` in `app/landing.css`: `--sky`,
  `--sky-grad`, `--btn-grad`, `--signal` blues) is replaced by the console's Cream tokens
  (`--paper`, `--pebble`, `--ink`, `--slate`, `--mist`, `--hairline`, `--st-mustard`,
  `--st-forest`, `--st-terra`, `--st-ink` and their `--on-*`), so site and product match.
- Light: the blue sky blooms (`.lp-sky .lp-bloom`) become a warm sunrise on cream — soft
  mustard and terracotta light behind the headline, a fine paper grain.
- Dark (Warm Night): the same scene after dusk — a deep warm night with faint twinkling
  stars; the blooms dim to lamplight.
- The circuit traces and pulses beside the headline, the switchboard's orbit and links, and
  the counting stats stay, recoloured: pulses become mustard light on dark lines.
- Cards and buttons take the console's look (rounded cards, soft lift, pill buttons). The
  primary button is a solid forest-green WhatsApp pill; secondary buttons are paper pills.
- Type: the headline in Instrument Serif (already loaded, `lib/fonts.ts`), Manrope for the
  rest, IBM Plex Mono where the page already uses mono.
- Following the visitor: with no saved choice the storefront and /admin open in Cream or
  Warm Night to match `prefers-color-scheme`; the sun/moon switch (`app/theme-toggle.tsx`,
  key `nexus-theme`) flips it and is remembered — the same choice the console reads. A saved
  choice applies before first paint (`THEME_BOOT`), as today; the system default is applied
  by a small inline script on the two public pages (`PUBLIC_THEME_BOOT`, `lib/theme.ts`) that
  sets `data-theme="dark"` without saving it — a script rather than a media query, which would
  copy the whole Warm Night token block a second time — so nothing flashes. The console's own
  default (light when no choice) is unchanged: signing in clears a dark that was only the
  device's (`forgetSystemTheme`).
- Every animation stops under `prefers-reduced-motion: reduce`. All text ≥ 4.5:1 in both
  themes.

## 2. Page structure and the WhatsApp button

Order stays; the emphasis moves to selling.

1. **Top bar** — brand; Product · Switchboard · How it works · Customer links; the
   sun/moon switch; a quiet **Sign in** (to `#signin`); the green **Chat on WhatsApp** pill.
2. **Headline** — "The agentic inbox for *every* WhatsApp conversation" and today's
   subtitle. Primary **Chat with Nexus on WhatsApp**, secondary **See it work** (`#tour`).
   "Enter the console" goes (Sign in in the top bar replaces it). The inbox mock-up and its
   two floating notes stay, as cream cards.
3. The channel strip, "WhatsApp on a phone is a black box", the self-turning tour, the
   switchboard, the four stats and the journey — restyled, same words. The stats are true
   product facts (businesses on one number, the 24 h pause, two checks per reply, four
   channels) and stay.
4. **New closing band, "Talk to the agent yourself"** — one line saying the button opens
   WhatsApp to a number Nexus answers, and the green button again.
5. **Team sign-in** — a compact cream card under "Staff of a Nexus business?". Form,
   validation, wording, "Keep me signed in", the show/hide control and the staff-only login
   (`mode: "staff"`) behave exactly as today.
6. Footer as today.

**The WhatsApp button**

- The number is read on the server from `NEXUS_SALES_WHATSAPP` (digits only, e.g.
  `9715…`; anything else is ignored) in `app/page.tsx` and passed to the landing as a prop,
  so a change needs a restart, never a rebuild (the page is already
  `export const dynamic = "force-dynamic"`, so the value is read per request, not baked in
  at build).
- Set: every WhatsApp button is `https://wa.me/<number>?text=<encoded>` with the prefilled
  "Hi Nexus, I'd like to see how it works for my business".
- Not set: every WhatsApp button becomes **Email us**, a `mailto:` to the contact address
  the public pages already publish (`app/privacy/page.tsx`), so there is never a dead link.
- Both are real links with names that say where they go; the WhatsApp ones open in a new
  tab with `rel="noopener"`.

## 3. Sign-in pages and phones

**Admin entrance (`app/admin/page.tsx`, `admin.css`)** — a two-part sign-in: on the left a
dark panel in the console dock's style (the Nexus mark, "Administrator sign-in", three of
the coloured glass icon tiles as a quiet nod to the console); on the right the paper card
with Email, Password, the existing note, error line and "Back to Nexus". One column on a
phone (the dark panel becomes a band on top). Follows light/dark like the storefront.
Fields, button rules, error wording and the separate admin login path unchanged.

**Phones (375 px)** — the top bar holds the brand, the sun/moon switch and the WhatsApp
button as an icon-and-word pill; the section links fold into a small menu (a real
`<button aria-expanded>` with the links in a list). Headline text first, then the inbox
mock-up scaled down. The tour and switchboard keep working; the switchboard ring scales to
fit. A floating **WhatsApp** pill appears once the visitor scrolls past the headline and
hides over the closing band. Nothing scrolls sideways; tap targets ≥ 44 px.

## Testing

- Render tests: the WhatsApp buttons with the setting (wa.me link, encoded prefilled text,
  new tab) and without it (Email us, mailto to the published address); a malformed setting
  falls back to email.
- Theme: the storefront and /admin carry the Warm Night tokens under
  `prefers-color-scheme: dark` unless `data-theme="light"`, and under `data-theme="dark"`;
  the console's default stays light (existing guard tests keep passing).
- The existing guard tests on the staff-only and admin login paths keep passing unchanged;
  the custom-property and pure-black guards cover the new CSS.
- Browser (stand-in data, local preview): the storefront and /admin at 1280 px and 375 px in
  Cream and Warm Night; a contrast probe over every text element; reduced motion; keyboard
  through the top bar, the phone menu, the tour tabs and both forms; no sideways scroll.

## Deploy

Only on the owner's "Deploy it": merge, push main, `scripts/deploy.sh` on the VPS. No
database change. When the sales number exists, add `NEXUS_SALES_WHATSAPP=<digits>` to the
server's environment for the web container and restart it; until then the buttons say
Email us.
