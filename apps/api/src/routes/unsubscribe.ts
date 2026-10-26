import { Hono } from "hono";
import { unsubscribeByToken } from "@nexus/db";
import { logger } from "../lib/logger.js";

/**
 * The unsubscribe link at the foot of every campaign email (26 Oct 2026).
 *
 * Public, like /links: the person clicking it is a customer, signed in to
 * nothing. Mounted outside /api, so none of the session middleware applies.
 *
 * The token rides in the query (`/unsubscribe?t=…`), not the path: it is a
 * capability for one recipient of one campaign, not the id of a row anybody
 * can address, and the bare-id route check is right to treat a path parameter
 * as the latter.
 *
 * GET shows a button and changes nothing — mail scanners open every link in a
 * message, and one that unsubscribed on GET would unsubscribe people who never
 * clicked. POST (that button, or Gmail's one-click List-Unsubscribe-Post) does it.
 *
 * Every answer is the same page whatever the token: a token that names nobody
 * says "you're unsubscribed" too, so guessing tokens learns nothing.
 */
export const unsubscribeRoute = new Hono();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The link a campaign email carries. */
export function unsubscribeUrl(base: string, token: string): string {
  return `${base}/unsubscribe?t=${encodeURIComponent(token)}`;
}

function page(title: string, body: string, form?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fb;font:16px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1f2937}
main{max-width:420px;margin:16px;padding:28px;background:#fff;border:1px solid #e5e7eb;border-radius:14px;text-align:center}
h1{font-size:20px;margin:0 0 8px}p{margin:0 0 18px;color:#4b5563}
button{font:inherit;font-weight:600;color:#fff;background:#1f4fd6;border:0;border-radius:999px;padding:11px 22px;cursor:pointer}</style></head>
<body><main><h1>${title}</h1><p>${body}</p>${form ?? ""}</main></body></html>`;
}

const DONE = page(
  "You're unsubscribed",
  "You won't get campaign emails from this business any more. Replies to your own messages still reach you."
);

unsubscribeRoute.get("/", (c) => {
  const token = c.req.query("t") ?? "";
  return c.html(
    page(
      "Unsubscribe from these emails?",
      "You'll stop getting campaign emails from this business.",
      `<form method="post" action="/unsubscribe?t=${encodeURIComponent(token)}"><button type="submit">Unsubscribe</button></form>`
    )
  );
});

unsubscribeRoute.post("/", async (c) => {
  const token = c.req.query("t") ?? "";
  if (UUID.test(token)) {
    try {
      await unsubscribeByToken(token);
    } catch (err) {
      logger.error({ err }, "Unsubscribe could not be recorded");
      return c.html(page("Something went wrong", "Your unsubscribe could not be saved just now. Please try the link again."), 500);
    }
  }
  return c.html(DONE);
});
