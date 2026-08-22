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
import { execSync } from "node:child_process";
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

test("the exec bit is re-asserted from the source tree", () => {
  // core.fileMode is false on the dev machine and tar drops the mode, so
  // `add -A` re-records whatever the mirror already had. Existing executables
  // keep 755 BY LUCK -- nothing preserved them, they were simply never changed
  // -- and a NEW executable is recorded 644 on the commit that introduces it.
  //
  // mirror.sh was its own proof: it shipped 644 in both repos because it was
  // the newest script and had no prior mode to inherit. It ran anyway from Git
  // Bash, which honours the filesystem rather than the index, and would have
  // failed with "Permission denied" for anyone who cloned on Linux.
  assert.match(MIRROR, /ls-tree -r "HEAD:\$SUB"[\s\S]*?100755/);
  assert.match(MIRROR, /update-index --chmod=\+x/);

  // FROM THE SOURCE, NOT THE MIRROR. Reading the mirror's HEAD can only
  // re-assert bits on files it already has, which is the same blind spot one
  // step along -- a new executable still lands 644.
  const block = MIRROR.slice(MIRROR.indexOf("THE EXEC BIT DOES NOT SURVIVE"));
  const cmd = block.slice(0, block.indexOf("update-index"));
  assert.match(cmd, /git -C "\$MONO" ls-tree/);
  assert.ok(!/git -C "\$WORK" ls-tree/.test(cmd), "it is reading the mirror's own modes again");
});

test("a demoted executable stops the push", () => {
  // Silent until something will not run. On 2026-08-19 the manual steps
  // demoted verify-all.sh, which is how the ten gates are run on the VPS.
  assert.match(MIRROR, /mode change .* => 100644/);
  const guard = MIRROR.slice(MIRROR.indexOf("REFUSING: something executable"));
  assert.match(guard.slice(0, guard.indexOf("fi")), /exit 1/);
});

test("mirror.sh is itself executable", () => {
  // The bug that produced the guard above. Asserted on the recorded mode,
  // because that is the thing that was wrong -- the file was runnable on the
  // machine that wrote it the entire time.
  const mode = execSync('git ls-files -s -- nexus-agentic-os/scripts/mirror.sh', {
    cwd: join(root, ".."),
    encoding: "utf8",
  }).trim();
  assert.match(mode, /^100755 /, `mirror.sh is recorded as ${mode.split(" ")[0]}`);
});
