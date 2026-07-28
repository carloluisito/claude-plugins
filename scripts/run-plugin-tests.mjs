#!/usr/bin/env node
// Runs every plugin's own test suite and aggregates the result.
//
// Discovery order per plugins/<name>/:
//   1. package.json with a "test" script  ->  npm test  (deps installed first)
//   2. tests/run.mjs                      ->  node tests/run.mjs
// A plugin with neither is an error in validate-repo.mjs, not here.
//
// Zero dependencies. Exit 0 = all suites passed (or none exist yet).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_DIR = join(ROOT, "plugins");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (r.error) {
    console.error(`  could not execute ${cmd}: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

if (!existsSync(PLUGINS_DIR)) {
  console.log("No plugins/ directory yet — nothing to test.");
  process.exit(0);
}

const dirs = readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("."))
  .map((d) => d.name)
  .sort();

if (dirs.length === 0) {
  console.log("No plugins yet — nothing to test.");
  process.exit(0);
}

const failed = [];
const skipped = [];

for (const name of dirs) {
  const dir = join(PLUGINS_DIR, name);
  const pkgPath = join(dir, "package.json");

  let hasNpmTest = false;
  if (existsSync(pkgPath)) {
    try {
      hasNpmTest = Boolean(JSON.parse(readFileSync(pkgPath, "utf8"))?.scripts?.test);
    } catch (e) {
      console.error(`\n=== ${name} ===\n  package.json is invalid JSON — ${e.message}`);
      failed.push(name);
      continue;
    }
  }

  console.log(`\n=== ${name} ===`);

  if (hasNpmTest) {
    // Prefer a reproducible install; fall back when there is no lockfile.
    const installArgs = existsSync(join(dir, "package-lock.json")) ? ["ci"] : ["install"];
    if (run(NPM, installArgs, dir) !== 0) {
      console.error(`  npm ${installArgs[0]} failed`);
      failed.push(name);
      continue;
    }
    if (run(NPM, ["test", "--silent"], dir) !== 0) failed.push(name);
    continue;
  }

  if (existsSync(join(dir, "tests", "run.mjs"))) {
    if (run(process.execPath, [join("tests", "run.mjs")], dir) !== 0) failed.push(name);
    continue;
  }

  console.log("  no test suite found (validate-repo.mjs reports this as an error)");
  skipped.push(name);
}

console.log("");
if (skipped.length) console.log(`Untested plugins: ${skipped.join(", ")}`);

if (failed.length) {
  console.error(`FAILED — test suites failed for: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`OK — ${dirs.length - skipped.length}/${dirs.length} plugin test suite(s) passed`);
process.exit(0);
