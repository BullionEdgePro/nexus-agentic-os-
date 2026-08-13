// Every call that GENERATES TEXT is Anthropic. The one call that embeds is not,
// because Anthropic has no embeddings endpoint — its API is Messages, Batches,
// Files, token counting and model listing.
//
// That split is the whole design, and it is the kind of fact that drifts: the
// next person adding a summarising helper reaches for whichever client they saw
// last. These tests make the boundary explicit rather than conventional.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const AGENTS_DIR = join(root, "packages", "agents", "src");
const agentFiles = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".ts"));

// The two files allowed to mention Google at all, and why.
const MAY_MENTION_GOOGLE = new Set([
  // The retired implementation. Kept as a file, referenced by nothing.
  "gemini-domain-agent.ts",
  // Pings BOTH vendors on purpose: chat models on Anthropic, the embedding
  // model on Gemini. Splitting it would mean one of them stopped being checked.
  "preflight.ts",
]);

/** Source with comments removed. Prose about the seam is not a use of it. */
const codeOnly = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

test("no agent code reaches for Google except where it must", () => {
  // Comments are stripped first, and the first run of this test is why: it
  // flagged anthropic-text.ts, whose only mention of GEMINI_API_KEY is the
  // paragraph explaining that embeddings stay there. A scan that cannot tell
  // an explanation from a call punishes writing the explanation down.
  const offenders = agentFiles.filter((file) => {
    if (MAY_MENTION_GOOGLE.has(file)) return false;
    return /GoogleGenAI|@google\/genai|GEMINI_API_KEY/.test(
      codeOnly(readFileSync(join(AGENTS_DIR, file), "utf8"))
    );
  });
  assert.deepEqual(offenders, [], `these still call Google: ${offenders.join(", ")}`);
});

test("the customer reply path runs on Anthropic", () => {
  // The switchboard is what picks the agent for an inbound message. If this
  // regresses, every customer of every business is talking to the other vendor.
  const switchboard = read("packages", "agents", "src", "switchboard.ts");
  assert.match(switchboard, /import \{ AnthropicDomainAgent \} from "\.\/domain-agent\.js"/);
  const code = switchboard.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  assert.ok(!/new GeminiDomainAgent\(/.test(code), "the Gemini agent must not be constructed");
  assert.equal((code.match(/new AnthropicDomainAgent\(/g) ?? []).length, 3);
});

test("an employee twin keeps its own knowledge scope", () => {
  // The Gemini agent took a third constructor argument that the Anthropic one
  // did not. Dropping it compiles and runs — and every twin silently answers
  // from the tenant default, its own SOPs never retrieved. The switchboard
  // passes it; the agent must accept and forward it.
  const agent = read("packages", "agents", "src", "domain-agent.ts");
  assert.match(agent, /private readonly employeeId: string \| null = null/);
  assert.match(agent, /employeeId: this\.employeeId/);
});

test("the four short-text helpers share one client", () => {
  // Four copies of the same request shape meant four places to change and three
  // chances to miss one.
  for (const file of ["contact-recall.ts", "handover.ts", "bi-copilot.ts"]) {
    const src = readFileSync(join(AGENTS_DIR, file), "utf8");
    assert.match(src, /import \{ completeText \} from "\.\/anthropic-text\.js"/, file);
  }
});

test("a failed helper returns null rather than a plausible string", () => {
  // Callers treat these as best-effort: recall skips the note, the brief falls
  // back to the transcript, the copilot declines to route. A helper that
  // returned "" or an apology would be indistinguishable from a real answer.
  const helper = read("packages", "agents", "src", "anthropic-text.ts");
  assert.match(helper, /Promise<string \| null>/);
  assert.match(helper, /return text \|\| null;/);
  assert.match(helper, /catch \{\s*return null;\s*\}/);
});

test("embeddings stay on Gemini, and say why", () => {
  // Not an oversight to tidy later: the 393 stored vectors came from this
  // model, vectors from another embedder are not comparable to them, and
  // switching means re-embedding everything with retrieval dark until it ends.
  const embed = read("packages", "knowledge", "src", "embed.ts");
  assert.match(embed, /gemini-embedding-001/);
  const helper = read("packages", "agents", "src", "anthropic-text.ts");
  assert.match(helper, /Anthropic has no embeddings endpoint/);
});

test("stored model ids move with the code", () => {
  // AnthropicDomainAgent passes agent_configs.model straight to the Messages
  // API. A row still naming a Gemini model does not degrade — it 404s on every
  // message that tenant receives.
  const migration = read("packages", "db", "migrations", "030-anthropic-models.sql");
  assert.match(migration, /update agent_configs/);
  assert.match(migration, /where model like 'gemini%'/);
  // And refuses to finish quietly if anything was missed.
  assert.match(migration, /raise exception/);
  console.log("PASS: generation is Anthropic, embeddings are not, and the seam is named");
});
