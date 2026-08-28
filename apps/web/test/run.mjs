/**
 * Runs the console's render tests.
 *
 * A wrapper rather than an npm script, because the run needs one environment
 * variable and `VAR=x cmd` is not portable to Windows, where this repository is
 * developed. Adding cross-env for a single variable is a dependency for a line
 * of shell.
 *
 * WHY THE VARIABLE. Next builds with `"jsx": "preserve"` — it does its own JSX
 * transform — so tsx falls back to the classic runtime and every component
 * throws "React is not defined" the moment it renders. `tsconfig.test.json`
 * changes that one setting and nothing else, so the tests compile the same
 * sources the build does.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", "test/*.test.mjs"],
  {
    cwd: web,
    stdio: "inherit",
    env: { ...process.env, TSX_TSCONFIG_PATH: "tsconfig.test.json" },
  }
);

process.exit(result.status ?? 1);
