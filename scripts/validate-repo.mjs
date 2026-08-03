#!/usr/bin/env node
// Structural validator for this marketplace repository.
//
// This is the authoritative CI gate: zero dependencies, deterministic, and it
// mirrors the rules that `claude plugin validate` enforces plus the extra
// layout rules in CONVENTIONS.md. It must pass before a PR can merge.
//
// Usage: node scripts/validate-repo.mjs
// Exit 0 = clean. Exit 1 = at least one error.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MARKETPLACE = join(ROOT, ".claude-plugin", "marketplace.json");
const PLUGINS_DIR = join(ROOT, "plugins");

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

// Declared up front: report() can run before the manifest is parsed (e.g. when
// the file is missing), and a `const` would be in its temporal dead zone there.
let mp = null;

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Semver, per semver.org (no leading "v").
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
// Names that impersonate an official Anthropic/Claude marketplace are rejected
// by `claude plugin validate`. Fail fast here with the same rule so a bad name
// never reaches a commit.
const IMPERSONATES = /^(claude|anthropic)([-_.]|$)/i;

function readJson(path, label) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    err(`${label}: cannot read ${path}`);
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    err(`${label}: invalid JSON — ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------- marketplace

if (!existsSync(MARKETPLACE)) {
  err(".claude-plugin/marketplace.json is missing — it is the marketplace catalog");
  report();
}

mp = readJson(MARKETPLACE, "marketplace.json");
if (!mp) report();

if (typeof mp.name !== "string" || !mp.name) {
  err("marketplace.json: `name` is required and must be a non-empty string");
} else {
  if (!KEBAB.test(mp.name)) {
    err(`marketplace.json: \`name\` "${mp.name}" must be kebab-case (a-z, 0-9, hyphens)`);
  }
  if (IMPERSONATES.test(mp.name)) {
    err(
      `marketplace.json: \`name\` "${mp.name}" impersonates an official Anthropic/Claude ` +
        `marketplace and will be rejected at install time`,
    );
  }
  // Renaming the marketplace orphans every existing install, because each user
  // registers only one marketplace per name. Treat it as frozen.
  if (mp.name !== "carloluisito-plugins") {
    err(
      `marketplace.json: \`name\` is frozen at "carloluisito-plugins" but found ` +
        `"${mp.name}". Renaming breaks every existing install (see CONVENTIONS.md).`,
    );
  }
}

if (!mp.owner || typeof mp.owner !== "object" || Array.isArray(mp.owner)) {
  err("marketplace.json: `owner` is required and must be an object");
} else if (typeof mp.owner.name !== "string" || !mp.owner.name) {
  err("marketplace.json: `owner.name` is required and must be a non-empty string");
}

if (!Array.isArray(mp.plugins)) {
  err("marketplace.json: `plugins` is required and must be an array");
  report();
}

if (mp.plugins.length === 0) {
  warn("marketplace.json: no plugins listed yet (expected while the marketplace is new)");
}

// ------------------------------------------------------------ plugin entries

const seen = new Map();
const listedDirs = new Set();

mp.plugins.forEach((entry, i) => {
  const at = `marketplace.json plugins[${i}]`;

  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    err(`${at}: must be an object`);
    return;
  }

  const name = entry.name;
  if (typeof name !== "string" || !name) {
    err(`${at}: \`name\` is required and must be a non-empty string`);
    return;
  }
  if (!KEBAB.test(name)) {
    err(`${at} (${name}): \`name\` must be kebab-case (a-z, 0-9, hyphens)`);
  }
  if (seen.has(name)) {
    err(`${at} (${name}): duplicate plugin name, already declared at plugins[${seen.get(name)}]`);
  }
  seen.set(name, i);

  if (typeof entry.description !== "string" || entry.description.trim().length < 10) {
    err(`${at} (${name}): \`description\` is required and must be a real sentence (>=10 chars)`);
  }
  if (typeof entry.version !== "string" || !SEMVER.test(entry.version)) {
    err(`${at} (${name}): \`version\` is required and must be semver, e.g. "1.0.0"`);
  }

  // CONVENTIONS.md: plugins in this repo are local and live at ./plugins/<name>.
  // External `source` objects (github/git) are intentionally not allowed here.
  if (typeof entry.source !== "string") {
    err(
      `${at} (${name}): \`source\` must be the string "./plugins/${name}". ` +
        `External sources are not allowed in this marketplace (see CONVENTIONS.md).`,
    );
    return;
  }
  const expected = `./plugins/${name}`;
  if (entry.source !== expected) {
    err(`${at} (${name}): \`source\` must be exactly "${expected}", found "${entry.source}"`);
    return;
  }

  // ------------------------------------------------------ the plugin itself
  const dir = join(ROOT, "plugins", name);
  listedDirs.add(name);

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    err(`${at} (${name}): source directory plugins/${name}/ does not exist`);
    return;
  }

  const manifestPath = join(dir, ".claude-plugin", "plugin.json");
  if (!existsSync(manifestPath)) {
    err(`plugins/${name}: missing .claude-plugin/plugin.json (every plugin needs its own manifest)`);
    return;
  }

  const pj = readJson(manifestPath, `plugins/${name}/.claude-plugin/plugin.json`);
  if (!pj) return;

  if (pj.name !== name) {
    err(
      `plugins/${name}: plugin.json \`name\` is "${pj.name}" but the marketplace entry ` +
        `and directory say "${name}" — all three must match`,
    );
  }
  if (typeof pj.description !== "string" || pj.description.trim().length < 10) {
    err(`plugins/${name}: plugin.json \`description\` is required and must be a real sentence`);
  }
  if (typeof pj.version !== "string" || !SEMVER.test(pj.version)) {
    err(`plugins/${name}: plugin.json \`version\` is required and must be semver`);
  } else if (entry.version && pj.version !== entry.version) {
    err(
      `plugins/${name}: version mismatch — plugin.json says "${pj.version}", ` +
        `marketplace.json says "${entry.version}". Bump both together.`,
    );
  }

  // Quality bar from CONVENTIONS.md.
  if (!existsSync(join(dir, "README.md"))) {
    err(`plugins/${name}: missing README.md (users need to know what it does and how to use it)`);
  }
  if (!existsSync(join(dir, "CHANGELOG.md"))) {
    err(`plugins/${name}: missing CHANGELOG.md (published software needs a change record)`);
  }

  const hasTests =
    existsSync(join(dir, "tests", "run.mjs")) ||
    (existsSync(join(dir, "package.json")) &&
      (readJson(join(dir, "package.json"), `plugins/${name}/package.json`)?.scripts?.test ?? null) !==
        null);
  if (!hasTests) {
    err(
      `plugins/${name}: no tests found. Provide tests/run.mjs or a package.json "test" ` +
        `script so CI can verify it (see CONVENTIONS.md).`,
    );
  }

  // A plugin that contributes nothing is a packaging mistake.
  const contributes = ["skills", "commands", "agents", "hooks", "lsp", ".mcp.json"].some((c) =>
    existsSync(join(dir, c)),
  );
  if (!contributes && !pj.mcpServers && !pj.hooks && !pj.commands && !pj.agents && !pj.skills) {
    err(
      `plugins/${name}: contributes nothing — expected at least one of skills/, commands/, ` +
        `agents/, hooks/, lsp/, .mcp.json, or the equivalent field in plugin.json`,
    );
  }
});

// ------------------------------------------------- orphaned plugin directories

if (existsSync(PLUGINS_DIR)) {
  for (const d of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    if (!listedDirs.has(d.name)) {
      err(
        `plugins/${d.name}/ exists but is not listed in marketplace.json — ` +
          `unlisted plugins are invisible to users. List it or remove it.`,
      );
    }
  }
}

// ------------------------------------------------- front-door discoverability

// marketplace.json is the source of truth for what ships, but README.md is what
// a stranger actually reads before deciding to install anything. A plugin the
// front page never mentions is effectively undiscoverable no matter how well it
// is catalogued. Nothing else ties these two files together, and the drift is
// silent — every other check passes while the README claims the shelf is empty.
const README = join(ROOT, "README.md");
if (!existsSync(README)) {
  err("README.md is missing — it is the front page users read before installing anything");
} else {
  const readme = readFileSync(README, "utf8");
  for (const name of seen.keys()) {
    if (!readme.includes(name)) {
      err(
        `README.md never mentions "${name}", but marketplace.json ships it — ` +
          `readers of the front page cannot discover it. List it under ` +
          `"Available plugins" with a one-line description.`,
      );
    }
  }
}

// ------------------------------------------------------------------- reporting

function report() {
  for (const w of warnings) console.log(`warning  ${w}`);
  for (const e of errors) console.error(`ERROR    ${e}`);

  const n = mp?.plugins?.length ?? 0;
  if (errors.length === 0) {
    console.log(
      `\nOK — marketplace "${mp?.name ?? "?"}" valid, ${n} plugin${n === 1 ? "" : "s"} listed` +
        (warnings.length ? `, ${warnings.length} warning(s)` : ""),
    );
    process.exit(0);
  }
  console.error(`\nFAILED — ${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(1);
}

report();
