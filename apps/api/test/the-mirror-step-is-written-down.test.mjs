// The deploy is two repos and only one of them was documented.
//
// Development happens in the nexus-agentic-os/ subdirectory of the kova-audio
// monorepo. The VPS clones BullionEdgePro/nexus-agentic-os- -- trailing dash --
// which carries the project FLAT, because /opt/nexus/docker-compose.prod.yml
// has to sit at /opt/nexus. DEPLOY.md documents cloning that repo and
// deploy.sh documents building from it. Nothing documented how the subdirectory
// gets INTO it.
//
// It was hand-run three times. The fourth time cost twenty minutes of reading
// back a transcript to reconstruct what the first three had done, and a step
// reconstructed from memory is a step done differently each time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const MIRROR = readFileSync(join(root, "scripts", "mirror.sh"), "utf8");
const DEPLOY = readFileSync(join(root, "DEPLOY.md"), "utf8");

test("it mirrors the commit, never the working tree", () => {
  // `git archive HEAD:` is the whole safety property. It cannot pick up an
  // uncommitted edit, a node_modules, a .next or a .env, because none of those
  // are in the commit. Copying the working tree instead is how a secret ships.
  assert.match(MIRROR, /git archive "HEAD:\$SUB"/);
  assert.ok(
    !/rsync|cp -r .*\$MONO|cp -a/.test(MIRROR),
    "a working-tree copy would carry .env and node_modules into a public repo"
  );
});

test("it refuses to run on a dirty tree", () => {
  // Mirroring HEAD while the disk says something else deploys a commit behind
  // and passes all ten gates doing it. That already happened once.
  assert.match(MIRROR, /git status --porcelain -- "\$SUB"/);
  assert.match(MIRROR, /REFUSING/);
  const guard = MIRROR.slice(MIRROR.indexOf("REFUSING"));
  assert.match(
    guard.slice(0, guard.indexOf("fi")),
    /exit 1/,
    "the dirty-tree check must stop the mirror, not just warn about it"
  );
});

test("deletions propagate", () => {
  // An unpack over a populated clone adds and overwrites but never removes, so
  // a file deleted upstream would live on in the deploy repo forever -- and a
  // deleted migration or a deleted operator living on in production is the
  // failure this line prevents.
  assert.match(MIRROR, /git ls-tree -r --name-only "HEAD:\$SUB"/);
  assert.match(MIRROR, /git -C "\$WORK" rm -q --ignore-unmatch/);
});

test("it names the source commit", () => {
  // The two repos have unrelated histories. The short sha in the trailer is the
  // only thread tying a deployed image back to the monorepo commit it came
  // from, which is what build-check's stamp is compared against.
  assert.match(MIRROR, /Mirrored from kova-audio \$SRC/);
});

test("DEPLOY.md points at the script", () => {
  // The document that explains the two-repo split is where somebody looks when
  // they need to bridge it.
  assert.match(DEPLOY, /mirror\.sh/);
});
