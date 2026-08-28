/**
 * The mistake this repository has made thirteen times.
 *
 * ============================================================
 * WHY A GUARD AND NOT MORE CARE
 * ============================================================
 *
 * The recurrence register counts eleven instances of one defect: asking "who
 * are this business's customers" with `organization_id`. Broadcasts made it
 * twelve and thirteen on 2026-08-27 — the send audience and the count shown
 * beside it — and that one would have put a retail promotion in front of a law
 * firm's clients.
 *
 * It keeps happening because the wrong thing is EASIER TO WRITE than the right
 * one. On a shared number every contact row belongs to the number's owner, so
 * `where organization_id = $1` compiles, runs, returns rows, and answers a
 * different question than the one asked. Nothing fails.
 *
 * Every existing gate misses it, and for a reason worth stating: `rls-preflight`
 * scans for queries with NO tenant context, and the broadcast query had one.
 * Its context was right. Its predicate was wrong. Those are different faults and
 * only one of them was being looked for.
 *
 * `contacts.ts` defines `contactServedBy` once, under a comment saying it exists
 * so the predicate is not "written out a fourth time". Care was not the missing
 * ingredient — it was written down and the fourth copy happened anyway.
 *
 * ============================================================
 * WHAT COUNTS AS THE MISTAKE
 * ============================================================
 *
 * Filtering THE CONTACTS TABLE by organization_id. Not mentioning contacts —
 * most queries that join it filter tasks or conversations or lead_assessments,
 * which genuinely belong to one business, and flagging those would make this
 * noise. A noisy guard is one somebody switches off.
 *
 * Two things are deliberately allowed:
 *
 *   An IDENTITY LOOKUP — `organization_id = $1 and wa_id = $2` asks "is this
 *   person on file for this number", which is exactly how the webhook keys a
 *   contact and how the probes find rows they seeded. Correct, and must stay.
 *
 *   Anything already using `contactServedBy` or `served_organization_ids`,
 *   which is the right question asked the right way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");

/** The file that DEFINES the predicate is the one place allowed to spell it. */
const DEFINES_IT = "packages/db/src/contacts.ts";

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Every backtick string in a file, with `${...}` spans skipped.
 *
 * Skipped rather than stripped: a nested template inside an interpolation would
 * otherwise end the literal early, which is the bug that made an earlier audit
 * in this suite report live endpoints as unreachable.
 */
function sqlLiterals(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] !== "`") {
      i += 1;
      continue;
    }
    let j = i + 1;
    let depth = 0;
    while (j < src.length) {
      if (src[j] === "\\") {
        j += 2;
        continue;
      }
      if (src[j] === "$" && src[j + 1] === "{") {
        depth += 1;
        j += 2;
        continue;
      }
      if (depth > 0 && src[j] === "}") {
        depth -= 1;
        j += 1;
        continue;
      }
      if (depth === 0 && src[j] === "`") break;
      j += 1;
    }
    out.push(src.slice(i + 1, j));
    i = j + 1;
  }
  return out;
}

/** Does this statement filter the CONTACTS table itself by organization_id? */
export function filtersContactsByOrg(sql) {
  const flat = sql.replace(/\s+/g, " ");
  if (!/\b(?:from|join|update|delete from)\s+contacts\b/i.test(flat)) return false;

  const alias = /\b(?:from|join|update|delete from)\s+contacts\s+(?:as\s+)?([a-z][a-z0-9_]*)\b/i.exec(flat);
  const aliasName = alias?.[1]?.toLowerCase();
  const notAnAlias = ["on", "where", "set", "using", "left", "right", "inner", "join", "group", "order"];

  if (aliasName && !notAnAlias.includes(aliasName)) {
    // Built with a string so the word boundary is a boundary. Writing `\b`
    // inside a template literal produces a BACKSPACE character, which silently
    // matches nothing — the first draft of this scanner did exactly that.
    return new RegExp("\\b" + aliasName + "\\.organization_id\\s*=", "i").test(flat);
  }

  // Unaliased: a bare organization_id is the contacts column only when contacts
  // is the only table in play. Otherwise it belongs to somebody else.
  const tables = flat.match(/\b(?:from|join)\s+([a-z_]+)/gi) ?? [];
  return tables.every((t) => /contacts\b/i.test(t)) && /\borganization_id\s*=/.test(flat);
}

const isIdentityLookup = (sql) => /\bwa_id\s*=/.test(sql);
const asksItProperly = (sql) => /served_organization_ids|contactServedBy/.test(sql);

const files = [...walk(join(root, "packages")), ...walk(join(root, "apps", "api", "src"))];

test("the scanner still finds SQL to look at", () => {
  // A floor. Two regexes away from passing vacuously forever, on a guard whose
  // whole subject is a mistake that produces no error.
  assert.ok(files.length >= 100, `only ${files.length} source files found`);
  const withSql = files.filter((f) => sqlLiterals(readFileSync(f, "utf8")).some((s) => /select|insert|update/i.test(s)));
  assert.ok(withSql.length >= 15, `only ${withSql.length} files with SQL — the literal parser has stopped matching`);
});

test("it recognises the defect it was built for", () => {
  // THE ACTUAL QUERY, as broadcasts.ts carried it until 2026-08-27. A guard
  // that cannot be shown to catch its own founding case is decoration, and this
  // one has to survive every future refactor of the scanner above.
  const shipped = `select id, wa_id, display_name from contacts
     where organization_id = $1 and attributes @> $2::jsonb`;
  assert.equal(filtersContactsByOrg(shipped), true, "the original defect is no longer detected");
  assert.equal(asksItProperly(shipped), false);
  assert.equal(isIdentityLookup(shipped), false, "it must not be waved through as an identity lookup");

  // And the count beside it, which disagreed with the audience it described.
  const count = `select count(*)::text as total
       from contacts
      where organization_id = $1 and coalesce(wa_id, '') <> ''`;
  assert.equal(filtersContactsByOrg(count), true, "the reachable-count defect is no longer detected");
  // `coalesce(wa_id, '') <> ''` is not an identity lookup: it asks whether a
  // number exists at all, not whether it is a particular person's.
  assert.equal(isIdentityLookup(count), false, "an existence check is not an identity lookup");

  // The aliased form, which is how it would come back after a tidy-up.
  assert.equal(
    filtersContactsByOrg("select ct.id from contacts ct where ct.organization_id = $1"),
    true,
    "an alias must not hide it"
  );
});

test("it leaves the correct spellings alone", () => {
  // The right question, both ways it is written.
  assert.equal(
    asksItProperly("select ct.id from contacts ct where ${contactServedBy(\"$1\")}"),
    true
  );
  assert.equal(
    asksItProperly("select id from contacts ct where $1::uuid = any (ct.served_organization_ids)"),
    true
  );

  // An identity lookup, which is how the probes find a row they seeded.
  assert.equal(
    isIdentityLookup("select id from contacts where organization_id = $1 and wa_id = $2"),
    true
  );

  // A WRITE is not a filter, so it is never reached. Asserted rather than
  // assumed, because the webhook's upsert is keyed on (owner, wa_id) and is the
  // one place organization_id on contacts is unambiguously right -- a guard
  // that flagged it would be arguing with the architecture rather than with a
  // mistake. My first draft of this test claimed the insert was an "identity
  // lookup"; it is not, it is simply not a lookup at all.
  assert.equal(
    filtersContactsByOrg("insert into contacts (organization_id, wa_id) values ($1, $2)"),
    false,
    "an insert is not a filter and must never be flagged"
  );

  // A join whose organization_id belongs to the OTHER table. Flagging these is
  // what would have made this guard noise.
  assert.equal(
    filtersContactsByOrg("select t.id from tasks t join contacts ct on ct.id = t.contact_id where t.organization_id = $1"),
    false,
    "the filter is on tasks, not on contacts"
  );
  assert.equal(
    filtersContactsByOrg("select c.id from conversations c join contacts ct on ct.id = c.contact_id where c.organization_id = $1"),
    false,
    "the filter is on conversations, whose organization_id is the number's owner by design"
  );
});

test("nothing in the codebase asks whose customers these are the wrong way", () => {
  const offenders = [];
  for (const file of files) {
    const rel = relative(root, file).replace(/\\/g, "/");
    if (rel === DEFINES_IT) continue;
    for (const sql of sqlLiterals(readFileSync(file, "utf8"))) {
      if (asksItProperly(sql) || isIdentityLookup(sql)) continue;
      if (!filtersContactsByOrg(sql)) continue;
      offenders.push(`${rel}\n      ${sql.replace(/\s+/g, " ").trim().slice(0, 120)}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "these ask 'whose customers are these' with organization_id, which on a shared number is\n" +
      "the number's owner and not the business serving them:\n\n  " +
      offenders.join("\n\n  ") +
      "\n\nUse contactServedBy from packages/db/src/contacts.ts. If the query really does mean\n" +
      "the owning row — an identity lookup keyed on wa_id — say so in the SQL."
  );
});
