// Nothing tied a running container to a revision.
//
// The deploy is three hand-run docker builds across two repositories, and the
// documented command was `build api worker` -- `web` was left to whoever
// remembered it. Every gate talks to the API, so a forgotten web build is a
// deploy where all nine gates pass and the screen nobody looks away from is
// still showing yesterday's code.
//
// On 2026-08-19 the web image happened to be current. Establishing that meant
// reading `docker image inspect --format {{.Created}}` against `git log -1 --
// apps/web` and comparing two timestamps by eye, in different timezones. That
// is a habit, not a check, and it is the kind that holds until it matters.
//
// So each image carries the commit it was built from, build-check compares all
// three against the working copy, and it runs FIRST -- before every gate whose
// answer would otherwise be about a build nobody had established the age of.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const COMPOSE = read("docker-compose.prod.yml");
const VERIFY = read("scripts", "verify-all.sh");
const CHECK = read("scripts", "build-check.sh");
const DEPLOY = read("scripts", "deploy.sh");

test("every image stamps the commit it was built from", () => {
  for (const file of ["Dockerfile.api", "Dockerfile.web"]) {
    const df = read(file);
    assert.match(df, /ARG GIT_COMMIT=unknown/, `${file} must accept the commit`);
    assert.match(df, /ENV NEXUS_COMMIT=\$GIT_COMMIT/, `${file} must expose it at runtime`);
  }
});

test("all three services pass the argument through", () => {
  // Three, not two. api and worker share Dockerfile.api and are separate
  // services, and web is the one the old deploy command left out.
  const occurrences = COMPOSE.split("GIT_COMMIT: ${GIT_COMMIT:-unknown}").length - 1;
  assert.equal(occurrences, 3, "api, worker and web must each pass GIT_COMMIT");
});

test("no build block declares args twice", () => {
  // The web service already had an `args:` block for its NEXT_PUBLIC_* values,
  // and adding a second one is valid-looking YAML that the parser rejects
  // outright: "mapping key args already defined". The deploy script caught it
  // on the first run and refused to build, which is the right outcome and one
  // round-trip later than a test.
  //
  // Counted per build block rather than per file, because three services each
  // having one `args:` is correct and a naive whole-file count cannot tell that
  // from one service having three.
  const blocks = COMPOSE.split(/^  (?=\w)/m);
  for (const block of blocks) {
    if (!block.includes("build:")) continue;
    const name = block.split(":")[0];
    const count = (block.match(/^      args:$/gm) ?? []).length;
    assert.ok(count <= 1, `${name} declares args ${count} times — that YAML will not parse`);
  }
});

test("a build that forgets the argument is reported, not tolerated", () => {
  // The default is "unknown" rather than a stale value or a failed build: an
  // image nobody can date is exactly the state this mechanism exists to end,
  // so it has to be visible rather than fatal at build time.
  assert.match(CHECK, /built without GIT_COMMIT/);
  assert.match(CHECK, /NO STAMP/);
  // "cannot tell" and "wrong" are different findings and need different actions.
  assert.match(CHECK, /STALE, working copy is/);
});

test("build-check runs first", () => {
  const gates = VERIFY.slice(VERIFY.indexOf("GATES=("), VERIFY.indexOf(")", VERIFY.indexOf("GATES=(")));
  const listed = gates.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("GATES"));
  assert.equal(listed[0], "build-check",
    "a gate that passes against a stale build has verified the stale build");
  assert.ok(listed.includes("schema-drift-check"));

  // EVERY LISTED GATE CAN ACTUALLY RUN, instead of a hard-coded count.
  //
  // The count was 10 and adding an eleventh gate failed this test, which is a
  // tripwire doing its job -- but the only thing it could catch was somebody
  // adding a gate, which is the safe change. A typo in the list passes a count
  // and then fails at 3am with "no such file", and the run reports a broken
  // gate as a broken deploy.
  //
  // So it checks the property the count was standing in for: nothing is listed
  // here that verify-all cannot execute.
  const runnable = (gate) =>
    existsSync(join(root, "scripts", `${gate}.sh`)) ||
    existsSync(join(root, "apps", "api", "src", "scripts", `${gate}.ts`));
  for (const gate of listed) {
    assert.ok(runnable(gate), `verify-all lists ${gate}, and neither scripts/${gate}.sh nor apps/api/src/scripts/${gate}.ts exists`);
  }
  assert.ok(listed.length >= 10, `gates were removed: ${listed.length} left`);
});

test("the deploy script builds web too", () => {
  // The whole point. The old instruction was `build api worker`.
  assert.match(DEPLOY, /build api worker web/);
  assert.match(DEPLOY, /up -d --no-deps api worker web/);
  assert.match(DEPLOY, /export GIT_COMMIT/);
  // And it verifies itself rather than trusting that it worked.
  assert.match(DEPLOY, /\.\/scripts\/build-check\.sh/);
});

test("a stale checkout is a failure, not a note", () => {
  // build-check compares images to the WORKING COPY. That answers "was this
  // built from what is checked out", not "is what is checked out current", and
  // the two came apart on 2026-08-19: a pull aborted on an untracked file,
  // deploy.sh correctly refused to continue, and the verify run afterwards
  // reported all three images matching -- because they matched a checkout one
  // commit old. Ten gates passed against a build without the commit they were
  // verifying.
  assert.match(CHECK, /rev-list --count HEAD\.\.origin\/main/);
  assert.match(CHECK, /behind origin\/main/);
  // And it must FAIL. A warning printed above three green ticks reads as green,
  // which is exactly how the stale build got through.
  assert.match(CHECK, /FAIL - images match the working copy, but the working copy is/);
  // The fetch is best-effort: no network is a reason to say so, not a reason to
  // fail a check about images.
  assert.match(CHECK, /git fetch --quiet origin main 2>\/dev\/null/);
});
