// The health strip can reach the health it reports.
//
// FOUND ON SCREEN 22 OCT 2026: the Overview always said "Health unknown". The
// web app calls the API cross-origin (api.nexusagenticos.com) with credentials,
// and only /api/* carried the CORS headers that allow it — /health/jobs sat
// outside them, so the browser blocked every check and the strip could only
// ever say it did not know. Same origins, same credentials as /api/*.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(join(here, "..", "src", "index.ts"), "utf8");

test("/health/* answers the web app's origins, like /api/*", () => {
  assert.match(INDEX, /app\.use\("\/health\/\*", cors\(\{ origin: env\.webOrigins, credentials: true \}\)\)/);
  assert.ok(
    INDEX.indexOf('app.use("/health/*", cors(') < INDEX.indexOf('"/health/jobs"'),
    "the CORS layer is registered before the route it covers"
  );
});
