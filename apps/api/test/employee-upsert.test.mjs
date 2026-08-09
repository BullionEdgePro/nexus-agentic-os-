// Saving an employee again must not erase what the form left out.
//
// `createEmployee` upserts on (organization_id, employee_code) so re-submitting
// someone is a friendly update rather than a duplicate-key error. The first
// version wrote `email = excluded.email` for every column, so a save that
// carried only a corrected name set the rest to NULL: the person's email, job
// title and WhatsApp number vanished, and with the email went the address they
// sign in with — while their access code stayed valid and unusable.
//
// Nothing errored, every unit test passed, and it took running the real query
// against the real database to see it. This asserts the SQL itself, because the
// defect lives in the ON CONFLICT clause and nowhere else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(
  join(here, "..", "..", "..", "packages", "db", "src", "employees.ts"),
  "utf8"
);

/** The ON CONFLICT ... DO UPDATE SET block of the upsert. */
function conflictClause() {
  const start = SOURCE.indexOf("on conflict (organization_id, employee_code) do update set");
  assert.ok(start > -1, "the upsert's ON CONFLICT clause has moved or been removed");
  const end = SOURCE.indexOf("returning", start);
  return SOURCE.slice(start, end);
}

test("optional fields are preserved, not overwritten with null", () => {
  const clause = conflictClause();

  // Every column a person might legitimately omit when re-saving.
  for (const column of [
    "email",
    "job_title",
    "department",
    "whatsapp_number",
    "timezone",
    "languages",
    "skills",
    "twin_enabled",
    "ai_personality",
    "response_style",
    "human_first",
  ]) {
    const assignment = new RegExp(`${column}\\s*=\\s*([^,\\n]+)`).exec(clause);
    assert.ok(assignment, `${column} is no longer assigned in the upsert`);
    assert.match(
      assignment[1],
      /coalesce\(/,
      `${column} is assigned directly — an omitted value would erase the stored one`
    );
    assert.ok(
      !/excluded\./.test(assignment[1]),
      `${column} reads from excluded, which has already lost the "not provided" distinction`
    );
  }
});

test("the required field is still always written", () => {
  // full_name is mandatory on the way in, so a save must actually apply it —
  // preserving it would make correcting a spelling impossible.
  assert.match(conflictClause(), /full_name\s*=\s*excluded\.full_name/);
});

test("re-saving reactivates someone taken off the rota", () => {
  // Adding a person back is the natural way to undo a removal, and it must not
  // silently leave them deactivated.
  assert.match(conflictClause(), /is_active\s*=\s*true/);
});

test("omitted arrays are passed as null so coalesce can preserve them", () => {
  // `?? []` would send an empty array, which is a real value meaning "clear the
  // list" — coalesce cannot tell that apart from an intentional blank.
  assert.match(SOURCE, /input\.languages \?\? null/);
  assert.match(SOURCE, /input\.skills \?\? null/);
  // And the INSERT path still needs its own default, since the columns are NOT
  // NULL and would reject an explicit null on first save.
  assert.match(SOURCE, /coalesce\(\$9::text\[\],'\{\}'\)/);
  assert.match(SOURCE, /coalesce\(\$10::text\[\],'\{\}'\)/);
  console.log("PASS: re-saving an employee cannot erase the fields it did not mention");
});
