#!/usr/bin/env node
// Tests for failure-memory. Plain Node, zero dependencies.
// Run from the plugin directory: node tests/run.mjs

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_ENTRIES,
  RENDER_BUDGET,
  SCHEMA,
  decrementEntry,
  firstStage,
  ledgerPathFor,
  normalizeText,
  redact,
  renderContext,
  resolveDataDir,
  selectForReplay,
  shortDate,
  signatureFor,
  sortFlags,
  tokenize,
} from "../scripts/lib.mjs";

import { idFor } from "../scripts/ledger.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..");
const CAPTURE = join(PLUGIN, "scripts", "capture.mjs");
const REPLAY = join(PLUGIN, "scripts", "replay.mjs");
const RESOLVE = join(PLUGIN, "scripts", "resolve.mjs");
const LEDGER = join(PLUGIN, "scripts", "ledger.mjs");

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`FAIL  ${name}\n      ${err && err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`FAIL  ${name}\n      ${err && err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || "not equal"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// --- harness ---------------------------------------------------------------

// Every temp dir this suite creates is registered here and removed once at the
// end of the run. Individual tests may still clean up early to keep disk use
// low during a run, but correctness must not depend on them: check() swallows a
// thrown assertion, so a failing test would otherwise skip its own trailing
// rmSync, and a new test that simply forgets to clean up would leak silently.
const TEMP_DIRS = [];

function freshDataDir() {
  const dir = mkdtempSync(join(tmpdir(), "failure-memory-test-"));
  TEMP_DIRS.push(dir);
  return dir;
}

function cleanupTempDirs() {
  for (const dir of TEMP_DIRS) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort. A directory we cannot remove must not fail the suite.
    }
  }
}

const PROJECT = "/tmp/fixture-project";

function capture(dataDir, payload) {
  const r = spawnSync(process.execPath, [CAPTURE, dataDir], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
  });
  return r;
}

function replay(dataDir, payload = { hook_event_name: "SessionStart", cwd: PROJECT, source: "startup" }) {
  const r = spawnSync(process.execPath, [REPLAY, dataDir], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return r;
}

function resolveHook(dataDir, payload) {
  const r = spawnSync(process.execPath, [RESOLVE, dataDir], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
  });
  return r;
}

function ledgerOf(dataDir, cwd = PROJECT) {
  const p = ledgerPathFor(dataDir, cwd);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function bashFailure(command, error = "Command exited with non-zero status code 1", extra = {}) {
  return {
    session_id: "test-session",
    transcript_path: "/tmp/t.jsonl",
    cwd: PROJECT,
    permission_mode: "default",
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command, description: "test" },
    tool_use_id: "toolu_test",
    error,
    is_interrupt: false,
    duration_ms: 12,
    ...extra,
  };
}

// A PostToolUse payload. Note what is absent: there is no exit code and no
// error field. PostToolUse fires only after a successful call, so the event
// identity is itself the success signal.
function bashSuccess(command, extra = {}) {
  return {
    session_id: "test-session",
    transcript_path: "/tmp/t.jsonl",
    cwd: PROJECT,
    permission_mode: "default",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "test" },
    tool_use_id: "toolu_test",
    duration_ms: 12,
    ...extra,
  };
}

function seedLedger(dataDir, entries, cwd = PROJECT) {
  const p = ledgerPathFor(dataDir, cwd);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ cwd, schema: SCHEMA, entries }, null, 2), "utf8");
  return p;
}

function iso(daysAgo) {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString();
}

// --- capture ---------------------------------------------------------------

console.log("capture");

check("first failure creates one entry with count 1", () => {
  const d = freshDataDir();
  const r = capture(d, bashFailure("npm test"));
  assertEqual(r.status, 0, "exit code");
  const l = ledgerOf(d);
  assert(l, "ledger written");
  assertEqual(l.schema, SCHEMA, "schema");
  assertEqual(l.cwd, PROJECT, "cwd recorded in plain text");
  assertEqual(l.entries.length, 1, "entry count");
  assertEqual(l.entries[0].count, 1, "count");
  assertEqual(l.entries[0].tool, "Bash", "tool");
  assertEqual(l.entries[0].signature, "npm test", "signature");
  rmSync(d, { recursive: true, force: true });
});

check("repeat failure increments count and keeps first_seen", () => {
  const d = freshDataDir();
  capture(d, bashFailure("npm test"));
  const first = ledgerOf(d).entries[0].first_seen;
  capture(d, bashFailure("npm test"));
  const l = ledgerOf(d);
  assertEqual(l.entries.length, 1, "still one entry");
  assertEqual(l.entries[0].count, 2, "count");
  assertEqual(l.entries[0].first_seen, first, "first_seen unchanged");
  assert(l.entries[0].last_seen >= first, "last_seen advanced");
  rmSync(d, { recursive: true, force: true });
});

check("varying operands collapse onto one entry", () => {
  const d = freshDataDir();
  capture(d, bashFailure("npm test -- auth.spec.js"));
  capture(d, bashFailure("npm test -- billing.spec.js"));
  const l = ledgerOf(d);
  assertEqual(l.entries.length, 1, "one entry");
  assertEqual(l.entries[0].count, 2, "count");
  assertEqual(l.entries[0].signature, "npm test", "signature dropped operands");
  rmSync(d, { recursive: true, force: true });
});

check("a pipeline and its bare first stage reach count 2 in the ledger", () => {
  // The end-to-end version of the unit tests below: two invocations that a user
  // would call "the same failure" must reach MIN_COUNT, or nothing is replayed.
  const d = freshDataDir();
  capture(d, bashFailure("npm test | tee out.log"));
  capture(d, bashFailure("npm test"));
  const l = ledgerOf(d);
  assertEqual(l.entries.length, 1, "one entry");
  assertEqual(l.entries[0].count, 2, "count reaches the replay threshold");
  assertEqual(l.entries[0].signature, "npm test", "signature is the failing stage");
  rmSync(d, { recursive: true, force: true });
});

check("reordered flags reach count 2 in the ledger", () => {
  const d = freshDataDir();
  capture(d, bashFailure("cargo build --release --locked"));
  capture(d, bashFailure("cargo build --locked --release"));
  const l = ledgerOf(d);
  assertEqual(l.entries.length, 1, "one entry");
  assertEqual(l.entries[0].count, 2, "count");
  rmSync(d, { recursive: true, force: true });
});

check("distinct commands stay distinct", () => {
  const d = freshDataDir();
  capture(d, bashFailure("npm run build"));
  capture(d, bashFailure("npm run lint"));
  assertEqual(ledgerOf(d).entries.length, 2, "two entries");
  rmSync(d, { recursive: true, force: true });
});

check("interrupted call is not recorded", () => {
  const d = freshDataDir();
  const r = capture(d, bashFailure("npm test", "interrupted", { is_interrupt: true }));
  assertEqual(r.status, 0, "exit code");
  assertEqual(ledgerOf(d), null, "no ledger written");
  rmSync(d, { recursive: true, force: true });
});

check("interrupted call does not disturb an existing ledger", () => {
  const d = freshDataDir();
  capture(d, bashFailure("npm test"));
  const before = JSON.stringify(ledgerOf(d));
  capture(d, bashFailure("npm test", "interrupted", { is_interrupt: true }));
  assertEqual(JSON.stringify(ledgerOf(d)), before, "ledger unchanged");
  rmSync(d, { recursive: true, force: true });
});

check("secrets are redacted before persistence", () => {
  const d = freshDataDir();
  capture(
    d,
    bashFailure(
      "TOKEN=ghp_aaaaaaaaaaaaaaaaaaaa npm test",
      "auth failed for token ghp_aaaaaaaaaaaaaaaaaaaa (sk-bbbbbbbbbbbbbbbb)",
    ),
  );
  const text = readFileSync(ledgerPathFor(d, PROJECT), "utf8");
  assert(!text.includes("ghp_"), "no github token prefix on disk");
  assert(!text.includes("sk-"), "no openai key prefix on disk");
  assert(!text.includes("aaaaaaaaaaaaaaaaaaaa"), "no token body on disk");
  const e = ledgerOf(d).entries[0];
  assert(!e.signature.includes("ghp_"), "signature clean");
  assert(!e.error_excerpt.includes("ghp_"), "excerpt clean");
  rmSync(d, { recursive: true, force: true });
});

check("error excerpt is clamped to 300 chars", () => {
  const d = freshDataDir();
  capture(d, bashFailure("npm test", `boom ${"x".repeat(2000)}`));
  assert(ledgerOf(d).entries[0].error_excerpt.length <= 300, "excerpt clamped");
  rmSync(d, { recursive: true, force: true });
});

check("malformed stdin exits 0 and writes nothing", () => {
  const d = freshDataDir();
  const r = capture(d, "this is not json {{{");
  assertEqual(r.status, 0, "exit code");
  assertEqual(ledgerOf(d), null, "no ledger");
  assertEqual(readdirSync(d).length, 0, "data dir untouched");
  rmSync(d, { recursive: true, force: true });
});

check("empty stdin exits 0 and writes nothing", () => {
  const d = freshDataDir();
  const r = capture(d, "");
  assertEqual(r.status, 0, "exit code");
  assertEqual(ledgerOf(d), null, "no ledger");
  rmSync(d, { recursive: true, force: true });
});

check("payload without tool_name is ignored", () => {
  const d = freshDataDir();
  const r = capture(d, { hook_event_name: "PostToolUseFailure", cwd: PROJECT, error: "x" });
  assertEqual(r.status, 0, "exit code");
  assertEqual(ledgerOf(d), null, "no ledger");
  rmSync(d, { recursive: true, force: true });
});

check("corrupt ledger is moved aside and capture recovers", () => {
  const d = freshDataDir();
  const p = ledgerPathFor(d, PROJECT);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "{ not json at all", "utf8");
  const r = capture(d, bashFailure("npm test"));
  assertEqual(r.status, 0, "exit code");
  assert(existsSync(`${p}.corrupt`), "corrupt file quarantined");
  const l = ledgerOf(d);
  assertEqual(l.entries.length, 1, "fresh ledger has the new entry");
  rmSync(d, { recursive: true, force: true });
});

check("ledger with a foreign shape is quarantined and recovered", () => {
  const d = freshDataDir();
  const p = ledgerPathFor(d, PROJECT);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ schema: 99, whatever: true }), "utf8");
  capture(d, bashFailure("npm test"));
  assert(existsSync(`${p}.corrupt`), "unusable shape quarantined");
  const l = ledgerOf(d);
  assertEqual(l.schema, SCHEMA, "schema reset");
  assertEqual(l.entries.length, 1, "entry recorded");
  rmSync(d, { recursive: true, force: true });
});

// A ledger written by another version of this plugin is well-formed but keyed by
// rules we no longer use. It is read as empty so old and new counts never mix --
// and *not* quarantined, because nothing about it is broken.
check("ledger from an older schema reads as empty without quarantining", () => {
  const d = freshDataDir();
  const p = ledgerPathFor(d, PROJECT);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    JSON.stringify({
      cwd: PROJECT,
      schema: SCHEMA - 1,
      entries: [
        {
          tool: "Bash",
          signature: "npm test && npm run lint",
          error_class: "unknown",
          error_excerpt: "boom",
          count: 7,
          first_seen: iso(5),
          last_seen: iso(1),
        },
      ],
    }),
    "utf8",
  );
  capture(d, bashFailure("npm test"));
  assert(!existsSync(`${p}.corrupt`), "not quarantined -- it was never corrupt");
  const l = ledgerOf(d);
  assertEqual(l.schema, SCHEMA, "schema rewritten");
  assertEqual(l.entries.length, 1, "old entries dropped");
  assertEqual(l.entries[0].count, 1, "count restarts rather than inheriting 7");
  rmSync(d, { recursive: true, force: true });
});

check("ledger from a newer schema is left intact on disk, not quarantined", () => {
  const d = freshDataDir();
  const p = ledgerPathFor(d, PROJECT);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ cwd: PROJECT, schema: SCHEMA + 1, entries: [] }), "utf8");
  const r = capture(d, bashFailure("npm test"));
  assertEqual(r.status, 0, "exit code");
  assert(!existsSync(`${p}.corrupt`), "a newer version's ledger is not destroyed");
  rmSync(d, { recursive: true, force: true });
});

check("no temp files are left behind", () => {
  const d = freshDataDir();
  capture(d, bashFailure("npm test"));
  const files = readdirSync(join(d, "ledger"));
  assert(!files.some((f) => f.includes(".tmp-")), `temp file left: ${files.join(",")}`);
  assert(!files.some((f) => f.endsWith(".lock")), `lock left: ${files.join(",")}`);
  rmSync(d, { recursive: true, force: true });
});

check("ledger is capped at MAX_ENTRIES", () => {
  const d = freshDataDir();
  const seeded = [];
  for (let i = 0; i < MAX_ENTRIES; i += 1) {
    seeded.push({
      tool: "Bash",
      signature: `cmd-${i}`,
      error_excerpt: "boom",
      count: 5,
      first_seen: iso(2),
      last_seen: iso(1),
    });
  }
  seedLedger(d, seeded);
  capture(d, bashFailure("brand new command"));
  const l = ledgerOf(d);
  assert(l.entries.length <= MAX_ENTRIES, `entries ${l.entries.length} <= ${MAX_ENTRIES}`);
  rmSync(d, { recursive: true, force: true });
});

check("expired entries are dropped on write", () => {
  const d = freshDataDir();
  seedLedger(d, [
    { tool: "Bash", signature: "ancient", error_excerpt: "boom", count: 9, first_seen: iso(400), last_seen: iso(365) },
  ]);
  capture(d, bashFailure("npm test"));
  const sigs = ledgerOf(d).entries.map((e) => e.signature);
  assert(!sigs.includes("ancient"), "expired entry dropped");
  assert(sigs.includes("npm test"), "new entry kept");
  rmSync(d, { recursive: true, force: true });
});

check("Edit failures key on extension plus error class", () => {
  const d = freshDataDir();
  const base = {
    hook_event_name: "PostToolUseFailure",
    cwd: PROJECT,
    tool_name: "Edit",
    error: "String to replace not found in file.",
    is_interrupt: false,
  };
  capture(d, { ...base, tool_input: { file_path: "/a/b/one.ts", old_string: "x", new_string: "y" } });
  capture(d, { ...base, tool_input: { file_path: "/c/d/two.ts", old_string: "p", new_string: "q" } });
  const l = ledgerOf(d);
  assertEqual(l.entries.length, 1, "collapsed to one entry");
  assertEqual(l.entries[0].count, 2, "count");
  assertEqual(l.entries[0].signature, "*.ts no-match", "signature");
  rmSync(d, { recursive: true, force: true });
});

check("separate projects get separate ledgers", () => {
  const d = freshDataDir();
  capture(d, { ...bashFailure("npm test"), cwd: "/tmp/project-a" });
  capture(d, { ...bashFailure("npm test"), cwd: "/tmp/project-b" });
  assertEqual(readdirSync(join(d, "ledger")).length, 2, "two ledger files");
  assertEqual(ledgerOf(d, "/tmp/project-a").entries.length, 1, "project a");
  assertEqual(ledgerOf(d, "/tmp/project-b").entries.length, 1, "project b");
  rmSync(d, { recursive: true, force: true });
});

// --- replay ----------------------------------------------------------------

console.log("replay");

check("absent ledger emits nothing at all", () => {
  const d = freshDataDir();
  const r = replay(d);
  assertEqual(r.status, 0, "exit code");
  assertEqual(r.stdout.trim(), "", "no stdout");
  rmSync(d, { recursive: true, force: true });
});

check("empty ledger emits nothing at all", () => {
  const d = freshDataDir();
  seedLedger(d, []);
  const r = replay(d);
  assertEqual(r.status, 0, "exit code");
  assertEqual(r.stdout.trim(), "", "no stdout");
  rmSync(d, { recursive: true, force: true });
});

check("count 1 entries are not rendered", () => {
  const d = freshDataDir();
  seedLedger(d, [
    { tool: "Bash", signature: "flaky once", error_excerpt: "boom", count: 1, first_seen: iso(1), last_seen: iso(1) },
  ]);
  const r = replay(d);
  assertEqual(r.stdout.trim(), "", "no additionalContext for a single failure");
  rmSync(d, { recursive: true, force: true });
});

check("stale entries are not rendered", () => {
  const d = freshDataDir();
  seedLedger(d, [
    { tool: "Bash", signature: "old news", error_excerpt: "boom", count: 9, first_seen: iso(80), last_seen: iso(45) },
  ]);
  assertEqual(replay(d).stdout.trim(), "", "outside the 30 day window");
  rmSync(d, { recursive: true, force: true });
});

check("repeated recent failure is emitted as valid SessionStart JSON", () => {
  const d = freshDataDir();
  seedLedger(d, [
    { tool: "Bash", signature: "npm test", error_excerpt: "exit 1", count: 4, first_seen: iso(5), last_seen: iso(1) },
  ]);
  const r = replay(d);
  assertEqual(r.status, 0, "exit code");
  const out = JSON.parse(r.stdout);
  assertEqual(out.hookSpecificOutput.hookEventName, "SessionStart", "hookEventName");
  assert(typeof out.hookSpecificOutput.additionalContext === "string", "additionalContext is a string");
  assert(out.hookSpecificOutput.additionalContext.includes("npm test"), "mentions the failure");
  assert(out.hookSpecificOutput.additionalContext.includes("4x"), "mentions the count");
  rmSync(d, { recursive: true, force: true });
});

check("rendered context stays inside the budget with a full ledger", () => {
  const d = freshDataDir();
  const seeded = [];
  for (let i = 0; i < MAX_ENTRIES; i += 1) {
    seeded.push({
      tool: "Bash",
      signature: `a-long-recurring-command-signature-number-${i} ${"y".repeat(80)}`,
      error_excerpt: "z".repeat(300),
      count: 2 + (i % 7),
      first_seen: iso(10),
      last_seen: iso(1),
    });
  }
  seedLedger(d, seeded);
  const out = JSON.parse(replay(d).stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert(ctx.length <= RENDER_BUDGET, `context ${ctx.length} <= ${RENDER_BUDGET}`);
  assert(ctx.length > 200, "context is not trivially empty");
  rmSync(d, { recursive: true, force: true });
});

check("worst offenders are rendered first", () => {
  const d = freshDataDir();
  seedLedger(d, [
    { tool: "Bash", signature: "rare", error_excerpt: "boom", count: 2, first_seen: iso(3), last_seen: iso(1) },
    { tool: "Bash", signature: "frequent", error_excerpt: "boom", count: 20, first_seen: iso(3), last_seen: iso(1) },
  ]);
  const ctx = JSON.parse(replay(d).stdout).hookSpecificOutput.additionalContext;
  assert(ctx.indexOf("frequent") < ctx.indexOf("rare"), "highest count first");
  rmSync(d, { recursive: true, force: true });
});

check("replay tolerates a corrupt ledger", () => {
  const d = freshDataDir();
  const p = ledgerPathFor(d, PROJECT);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "!!! not json", "utf8");
  const r = replay(d);
  assertEqual(r.status, 0, "exit code");
  assertEqual(r.stdout.trim(), "", "no stdout");
  rmSync(d, { recursive: true, force: true });
});

check("replay tolerates malformed stdin", () => {
  const d = freshDataDir();
  const r = spawnSync(process.execPath, [REPLAY, d], { input: "not json", encoding: "utf8" });
  assertEqual(r.status, 0, "exit code");
  rmSync(d, { recursive: true, force: true });
});

// --- unit ------------------------------------------------------------------

console.log("units");

check("redact handles common credential shapes", () => {
  const cases = [
    ["API_KEY=abcdef123456", "abcdef123456"],
    ["password=hunter2hunter2", "hunter2hunter2"],
    ["Authorization: Bearer abc.def.ghi", "abc.def.ghi"],
    ["ghp_0123456789abcdefghij", "ghp_"],
    ["sk-0123456789abcdefghij", "sk-"],
    ["AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
    ["xoxb-123456789012-abcdefghijkl", "xoxb-"],
  ];
  for (const [input, mustNotAppear] of cases) {
    const out = redact(input);
    assert(!out.includes(mustNotAppear), `"${input}" -> "${out}" still contains ${mustNotAppear}`);
  }
});

check("redaction runs before generic collapsing so no prefix survives", () => {
  // ghp_aaaa... has an all-hex body; a naive hex rule would leave "ghp_<hex>".
  const out = normalizeText("failed with ghp_aaaaaaaaaaaaaaaaaaaa");
  assert(!out.includes("ghp_"), `prefix leaked: ${out}`);
});

check("normalizeText collapses paths, hashes and numbers", () => {
  assertEqual(normalizeText("cannot open /home/me/project/file.ts"), "cannot open <path>", "posix path");
  assertEqual(normalizeText("cannot open C:\\Users\\me\\file.ts"), "cannot open <path>", "windows path");
  assertEqual(normalizeText("bad ref deadbeef1234"), "bad ref <hex>", "hash");
  assertEqual(normalizeText("exit code 137"), "exit code <n>", "integer");
  assertEqual(normalizeText("a   b\n c"), "a b c", "whitespace");
});

check("signatureFor is stable across varying operands", () => {
  const a = signatureFor("Bash", { command: "pytest -- tests/test_a.py" }, "exit 1");
  const b = signatureFor("Bash", { command: "pytest -- tests/test_b.py" }, "exit 1");
  assertEqual(a, b, "same signature");
});

check("signatureFor does not confuse --flags with a bare --", () => {
  const a = signatureFor("Bash", { command: "npm run build --if-present" }, "exit 1");
  assert(a.includes("--if-present"), `flag was stripped: ${a}`);
});

check("signatureFor is clamped", () => {
  const sig = signatureFor("Bash", { command: "x".repeat(5000) }, "exit 1");
  assert(sig.length <= 200, `signature length ${sig.length}`);
});

// --- signature normalization (issue #3) ------------------------------------
//
// Each pair below is the whole point of the feature. When two invocations of the
// same failing command produce two signatures, they land as two entries of count
// 1, MIN_COUNT is never reached, and nothing is ever replayed -- the plugin
// silently does nothing. Where a pair is genuinely ambiguous the rule errs toward
// keeping them apart: a duplicate row is untidy, but a wrongly merged row gives
// advice about a command the user never ran.

const sigOf = (command) => signatureFor("Bash", { command }, "exit 1");

const COLLAPSES = [
  ["flag order", "cargo build --release --locked", "cargo build --locked --release"],
  ["&& list", "npm test && npm run lint", "npm test"],
  ["flag order with values", "pytest -x --maxfail=1", "pytest --maxfail=3 -x"],
  ["pipeline", "npm test | tee out.log", "npm test"],
  ["; list", "make build; make test", "make build"],
];

for (const [label, a, b] of COLLAPSES) {
  check(`signatureFor collapses ${label}: ${a} == ${b}`, () => {
    assertEqual(sigOf(a), sigOf(b), `"${a}" vs "${b}"`);
  });
}

const STAY_DISTINCT = [
  ["different scripts", "npm test", "npm run build"],
  ["flag values that are not flags", "git commit -m one", "git commit -m two"],
  ["different file operands", "node scripts/build.mjs", "node scripts/test.mjs"],
  ["separator inside quotes", 'echo "a && b"', 'echo "a"'],
];

for (const [label, a, b] of STAY_DISTINCT) {
  check(`signatureFor keeps ${label} distinct: ${a} != ${b}`, () => {
    assert(sigOf(a) !== sigOf(b), `both collapsed to "${sigOf(a)}"`);
  });
}

check("an unterminated quote is left uncut rather than guessed at", () => {
  // Cutting here would mean inventing where the quote was meant to close, which
  // is how two unrelated failures get merged. capture.mjs must also survive it.
  const sig = sigOf('npm test "unterminated');
  assert(sig.includes("unterminated"), `command was cut: ${sig}`);
  assert(sigOf('npm test "unterminated') !== sigOf("npm test"), "not merged with the bare command");
});

check("a command that is only a separator still yields a signature", () => {
  assertEqual(sigOf("| npm test"), "(empty command)", "empty first stage");
  assertEqual(sigOf(""), "(empty command)", "empty command");
});

check("normalization never throws on adversarial input", () => {
  const nasty = [
    "",
    " ",
    "|",
    ";;;",
    "&&",
    '"',
    "'",
    "\\",
    "\\\\|",
    'a "b \'c |; && \\',
    "-".repeat(500),
    "| | | ; && '",
    "npm test 'a\\'b'",
    " [31m|",
    "x".repeat(10_000),
  ];
  for (const command of nasty) {
    const sig = signatureFor("Bash", { command }, "exit 1");
    assert(typeof sig === "string" && sig.length > 0, `no signature for ${JSON.stringify(command)}`);
    assert(sig.length <= 200, `signature too long for ${JSON.stringify(command)}`);
  }
});

check("tokenize keeps quoted runs in one token", () => {
  assertEqual(tokenize('echo "a b"').length, 2, 'echo "a b"');
  assertEqual(tokenize("echo 'a b' c").join("|"), "echo|'a b'|c", "single quotes");
  assertEqual(tokenize("  a   b  ").join("|"), "a|b", "collapses whitespace");
  assertEqual(tokenize("a\\ b").length, 1, "escaped space does not split");
  assertEqual(tokenize("").length, 0, "empty");
});

check("firstStage cuts only on unquoted separators", () => {
  assertEqual(firstStage("a && b"), "a ", "&&");
  assertEqual(firstStage("a | b"), "a ", "pipe");
  assertEqual(firstStage("a ; b"), "a ", "semicolon");
  assertEqual(firstStage('a "b && c"'), 'a "b && c"', "quoted && untouched");
  assertEqual(firstStage("a 'b | c'"), "a 'b | c'", "quoted pipe untouched");
  assertEqual(firstStage("a \\| b"), "a \\| b", "escaped pipe untouched");
  assertEqual(firstStage("a & b"), "a & b", "single & is not a separator we cut on");
  assertEqual(firstStage('a "unterminated | b'), 'a "unterminated | b', "open quote: no cut");
});

check("sortFlags sorts a pure flag tail and leaves a mixed tail alone", () => {
  assertEqual(sortFlags("cmd --b --a"), "cmd --a --b", "pure flag tail sorted");
  assertEqual(sortFlags("cmd -b -a -c"), "cmd -a -b -c", "short flags sorted");
  assertEqual(sortFlags("cmd --flag value"), "cmd --flag value", "flag with a value untouched");
  assertEqual(sortFlags("cmd b a"), "cmd b a", "no flags at all untouched");
  assertEqual(sortFlags("cmd --only"), "cmd --only", "single flag untouched");
  assertEqual(sortFlags(""), "", "empty");
});

check("shortDate never prints Invalid Date, NaN or undefined", () => {
  assertEqual(shortDate("2026-07-28T10:11:12.000Z"), "2026-07-28", "iso timestamp");
  assertEqual(shortDate("2026-07-28"), "2026-07-28", "bare date");
  for (const bad of [undefined, null, "", "not a date", {}, NaN, "0000-13-45T99"]) {
    const out = shortDate(bad);
    assert(typeof out === "string", `non-string for ${JSON.stringify(bad)}`);
    for (const needle of ["Invalid", "NaN", "undefined"]) {
      assert(!out.includes(needle), `${JSON.stringify(bad)} -> "${out}" contains ${needle}`);
    }
  }
});

// --- rendered context (issue #3, D4) ---------------------------------------

check("rendered lines carry the count and both dates", () => {
  const ctx = renderContext([
    {
      tool: "Bash",
      signature: "npm test",
      count: 4,
      first_seen: "2026-06-01T00:00:00.000Z",
      last_seen: "2026-07-20T00:00:00.000Z",
      error_excerpt: "exit 1",
    },
  ]);
  assert(ctx.includes("4x"), `count missing: ${ctx}`);
  assert(ctx.includes("first 2026-06-01"), `first_seen missing: ${ctx}`);
  assert(ctx.includes("last 2026-07-20"), `last_seen missing: ${ctx}`);
});

check("an entry with no first_seen still renders cleanly", () => {
  // Entries written by an earlier build, or a ledger hand-edited by a user, can
  // be missing a date. Printing "first Invalid Date" would be worse than
  // printing no date at all.
  const ctx = renderContext([
    { tool: "Bash", signature: "npm test", count: 2, last_seen: "2026-07-20T00:00:00.000Z", error_excerpt: "boom" },
  ]);
  for (const needle of ["Invalid Date", "NaN", "undefined"]) {
    assert(!ctx.includes(needle), `rendered "${needle}": ${ctx}`);
  }
  assert(ctx.includes("last 2026-07-20"), "the date it does have is still shown");
  assert(!ctx.includes("first "), "no empty first clause");
});

check("an entry with no dates at all renders without a dangling comma", () => {
  const ctx = renderContext([
    { tool: "Bash", signature: "npm test", count: 2, error_excerpt: "boom" },
  ]);
  assert(ctx.includes("(failed 2x)"), `malformed count clause: ${ctx}`);
});

check("an entry with no error text renders without a dangling separator", () => {
  // Reachable in the field: excerptFor() returns "" whenever the captured
  // payload had no usable error string, so this is the shape a real ledger row
  // takes -- not a synthetic edge case. A trailing " -- " reads as truncated
  // error text, which is the opposite of what an empty excerpt means.
  for (const excerpt of ["", "   ", undefined]) {
    const label = JSON.stringify(excerpt);
    const ctx = renderContext([
      { tool: "Bash", signature: "npm test", count: 2, last_seen: iso(1), error_excerpt: excerpt },
    ]);
    const line = ctx.split("\n")[1];
    assert(line !== undefined, `no line rendered for excerpt ${label}`);
    assert(!/--\s*$/.test(line), `dangling separator for excerpt ${label}: ${JSON.stringify(line)}`);
    assert(
      !line.includes("undefined") && !line.includes("null"),
      `placeholder leaked into the line for excerpt ${label}: ${JSON.stringify(line)}`,
    );
    assert(
      line.endsWith(")"),
      `line should end at the count clause for excerpt ${label}: ${JSON.stringify(line)}`,
    );
  }
});

check("an entry with error text still renders the separator and the text", () => {
  const ctx = renderContext([
    { tool: "Bash", signature: "npm test", count: 2, last_seen: iso(1), error_excerpt: "exit 1" },
  ]);
  assert(ctx.includes(") -- exit 1"), `separator lost: ${ctx}`);
});

check("the injected header is an observation, not an instruction", () => {
  const ctx = renderContext([
    { tool: "Bash", signature: "npm test", count: 2, last_seen: iso(1), error_excerpt: "boom" },
  ]);
  const header = ctx.split("\n")[0];
  // The user never sees injected context. A stale instruction steers the model
  // with nothing on screen to explain why; a stale observation can be weighed
  // and discarded. Only our own template text is checked -- error_excerpt is
  // verbatim tool output and may contain an imperative of its own.
  const imperatives = [
    "avoid ",
    "do not ",
    "don't ",
    "you should",
    "make sure",
    "remember to",
    "be careful",
    "consider ",
    "try ",
    "use ",
    "prefer ",
    "always ",
    "never ",
  ];
  const lower = header.toLowerCase();
  for (const needle of imperatives) {
    assert(!lower.includes(needle), `header instructs ("${needle}"): ${header}`);
  }
  assert(lower.includes("failed"), `header does not state the fact: ${header}`);
});

check("rendered context stays inside RENDER_BUDGET", () => {
  const entries = Array.from({ length: 200 }, (_, i) => ({
    tool: "Bash",
    signature: `command number ${i} ${"y".repeat(150)}`,
    count: 5,
    first_seen: iso(10),
    last_seen: iso(1),
    error_excerpt: "z".repeat(300),
  }));
  const ctx = renderContext(entries);
  assert(ctx.length <= RENDER_BUDGET, `rendered ${ctx.length} > ${RENDER_BUDGET}`);
  assert(ctx.split("\n").length > 1, "at least one entry still rendered");
});

check("selectForReplay filters on count and recency", () => {
  const entries = [
    { tool: "Bash", signature: "a", count: 1, last_seen: iso(1), error_excerpt: "" },
    { tool: "Bash", signature: "b", count: 3, last_seen: iso(1), error_excerpt: "" },
    { tool: "Bash", signature: "c", count: 3, last_seen: iso(60), error_excerpt: "" },
  ];
  const got = selectForReplay(entries, Date.now()).map((e) => e.signature);
  assertEqual(got.join(","), "b", "only b qualifies");
});

check("renderContext returns empty string for no entries", () => {
  assertEqual(renderContext([]), "", "empty");
});

// --- resolve / decrement on success (issue #4) ------------------------------

console.log("resolve");

check("two failures then two successes clears the entry", () => {
  const d = freshDataDir();
  capture(d, bashFailure("npm test"));
  capture(d, bashFailure("npm test"));
  assertEqual(ledgerOf(d).entries[0].count, 2, "seeded to 2");
  resolveHook(d, bashSuccess("npm test"));
  assertEqual(ledgerOf(d).entries[0].count, 1, "first success walks it back");
  resolveHook(d, bashSuccess("npm test"));
  assertEqual(ledgerOf(d).entries.length, 0, "second success removes it");
});

check("one failure then one success clears the entry", () => {
  const d = freshDataDir();
  capture(d, bashFailure("cargo build"));
  assertEqual(ledgerOf(d).entries.length, 1, "seeded");
  resolveHook(d, bashSuccess("cargo build"));
  assertEqual(ledgerOf(d).entries.length, 0, "entry gone at zero, not left sitting at count 0");
});

check("two failures then one success leaves count 1 and stops replay", () => {
  const d = freshDataDir();
  capture(d, bashFailure("pytest -x"));
  capture(d, bashFailure("pytest -x"));
  resolveHook(d, bashSuccess("pytest -x"));
  const entries = ledgerOf(d).entries;
  assertEqual(entries.length, 1, "entry survives");
  assertEqual(entries[0].count, 1, "count decremented to 1");
  assertEqual(selectForReplay(entries, Date.now()).length, 0, "below MIN_COUNT, so not replayed");
  const r = replay(d);
  assertEqual(r.stdout.trim(), "", "replay injects nothing");
});

check("a success never lowers a count below zero", () => {
  const d = freshDataDir();
  capture(d, bashFailure("make"));
  resolveHook(d, bashSuccess("make"));
  resolveHook(d, bashSuccess("make"));
  resolveHook(d, bashSuccess("make"));
  assertEqual(ledgerOf(d).entries.length, 0, "still just gone");
});

check("a success with no matching signature leaves the file byte-identical", () => {
  const d = freshDataDir();
  capture(d, bashFailure("npm test"));
  const p = ledgerPathFor(d, PROJECT);
  const bytesBefore = readFileSync(p);
  const r = resolveHook(d, bashSuccess("git status"));
  assertEqual(r.status, 0, "exits 0");
  assert(bytesBefore.equals(readFileSync(p)), "ledger bytes unchanged");
});

check("a success with no ledger file creates no file", () => {
  const d = freshDataDir();
  const r = resolveHook(d, bashSuccess("echo hi"));
  assertEqual(r.status, 0, "exits 0");
  assertEqual(ledgerOf(d), null, "no ledger");
  // Not even the containing directory: a success must be completely inert.
  assert(!existsSync(dirname(ledgerPathFor(d, PROJECT))), "no ledger directory created");
});

check("a decrement does not refresh last_seen", () => {
  const d = freshDataDir();
  const stamp = iso(8);
  seedLedger(d, [
    { tool: "Bash", signature: "npm test", count: 3, first_seen: iso(9), last_seen: stamp, error_excerpt: "x" },
  ]);
  resolveHook(d, bashSuccess("npm test"));
  const e = ledgerOf(d).entries[0];
  assertEqual(e.count, 2, "decremented");
  assertEqual(e.last_seen, stamp, "last_seen byte-identical");
  // Guards the reason it matters: a refreshed last_seen would hold a
  // half-cleared entry inside the replay window forever.
  assert(Date.now() - Date.parse(e.last_seen) > 7 * 86_400_000, "still ~8 days old, not now");
});

check("capture and decrement key on the identical string", () => {
  // The one silent failure mode of this hook: if the two paths ever normalized
  // differently, counts would simply never go down and nothing would look
  // wrong. So assert against the shared exported function rather than a
  // hardcoded expectation, which would drift with it.
  for (const command of [
    "npm test",
    "  NPM   test  ",
    "git commit -m 'a message with spaces'",
    "curl -sSL https://example.com/x?token=abc123",
    "docker run --rm -it -v /a:/b alpine sh -c 'exit 1'",
    "node /tmp/nonce-9182734/script.mjs --port 5173",
  ]) {
    const captureKey = signatureFor("Bash", { command }, "Command exited with non-zero status code 1");
    const resolveKey = signatureFor("Bash", { command }, undefined);
    assertEqual(resolveKey, captureKey, `signature drift for: ${command}`);
  }
});

check("a Bash key never depends on the error text, end to end", () => {
  // Consequence of the above, verified through the real processes rather than
  // the library: capture writes a key resolve can find with no error text at all.
  const d = freshDataDir();
  capture(d, bashFailure("pnpm -r build", "ELIFECYCLE  Command failed with exit code 2"));
  capture(d, bashFailure("pnpm -r build", "a totally different error string"));
  assertEqual(ledgerOf(d).entries.length, 1, "one entry despite differing errors");
  resolveHook(d, bashSuccess("pnpm -r build"));
  resolveHook(d, bashSuccess("pnpm -r build"));
  assertEqual(ledgerOf(d).entries.length, 0, "cleared without ever seeing the error text");
});

check("a successful Edit, Write, Task or mcp__ call is refused", () => {
  // These tools are not in the matcher, and the script refuses them anyway in
  // case a user copies the hook into their own settings with a wider matcher.
  // Their ledger keys fold errorClass(error) in, so a success -- which carries
  // no error -- could only reconstruct the wrong key and clear the wrong row.
  const d = freshDataDir();
  capture(
    d,
    bashFailure("x", "boom", {
      tool_name: "Edit",
      tool_input: { file_path: "/a/b.ts", old_string: "a", new_string: "b" },
    }),
  );
  const p = ledgerPathFor(d, PROJECT);
  const bytesBefore = readFileSync(p);
  for (const [tool_name, tool_input] of [
    ["Edit", { file_path: "/a/b.ts", old_string: "a", new_string: "b" }],
    ["Write", { file_path: "/a/b.ts", content: "x" }],
    ["Task", { subagent_type: "Explore", prompt: "p" }],
    ["mcp__github__create_issue", { title: "t" }],
  ]) {
    const r = resolveHook(d, bashSuccess("ignored", { tool_name, tool_input }));
    assertEqual(r.status, 0, `${tool_name} exits 0`);
  }
  assert(bytesBefore.equals(readFileSync(p)), "ledger untouched by non-Bash successes");
});

check("resolve survives junk it is handed", () => {
  const d = freshDataDir();
  capture(d, bashFailure("npm test"));
  const p = ledgerPathFor(d, PROJECT);
  const bytesBefore = readFileSync(p);
  for (const junk of ["", "not json", "null", "[]", '{"tool_name":"Bash"}', '{"tool_name":"Bash","tool_input":null}']) {
    const r = resolveHook(d, junk);
    assertEqual(r.status, 0, `exits 0 for: ${junk.slice(0, 20)}`);
  }
  assert(bytesBefore.equals(readFileSync(p)), "ledger untouched");
});

check("an interrupted call is not treated as a success", () => {
  const d = freshDataDir();
  capture(d, bashFailure("npm test"));
  capture(d, bashFailure("npm test"));
  resolveHook(d, bashSuccess("npm test", { is_interrupt: true }));
  assertEqual(ledgerOf(d).entries[0].count, 2, "count untouched");
});

check("a success against a foreign schema is ignored", () => {
  const d = freshDataDir();
  const p = ledgerPathFor(d, PROJECT);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    JSON.stringify({ cwd: PROJECT, schema: 99, entries: [{ tool: "Bash", signature: "npm test", count: 2 }] }, null, 2),
    "utf8",
  );
  const bytesBefore = readFileSync(p);
  const r = resolveHook(d, bashSuccess("npm test"));
  assertEqual(r.status, 0, "exits 0");
  assert(bytesBefore.equals(readFileSync(p)), "left alone for the failure path to deal with");
});

check("decrementEntry returns null when nothing matches", () => {
  const entries = [{ tool: "Bash", signature: "a", count: 2 }];
  assertEqual(decrementEntry(entries, { tool: "Bash", signature: "b" }), null, "unknown signature");
  assertEqual(decrementEntry(entries, { tool: "Edit", signature: "a" }), null, "right signature, wrong tool");
  assertEqual(decrementEntry([], { tool: "Bash", signature: "a" }), null, "empty list");
  assertEqual(decrementEntry(undefined, { tool: "Bash", signature: "a" }), null, "no list at all");
});

check("decrementEntry does not mutate its input", () => {
  const entries = [{ tool: "Bash", signature: "a", count: 3, last_seen: "2026-01-01T00:00:00.000Z" }];
  const out = decrementEntry(entries, { tool: "Bash", signature: "a" });
  assertEqual(entries[0].count, 3, "original untouched");
  assertEqual(out[0].count, 2, "copy decremented");
  assertEqual(out[0].last_seen, "2026-01-01T00:00:00.000Z", "last_seen carried through unchanged");
});

check("decrementEntry treats a missing count as a single observation", () => {
  const out = decrementEntry([{ tool: "Bash", signature: "a" }], { tool: "Bash", signature: "a" });
  assertEqual(out.length, 0, "dropped rather than left at NaN");
});

check("decrementEntry only touches the row it matched", () => {
  const entries = [
    { tool: "Bash", signature: "a", count: 2 },
    { tool: "Bash", signature: "b", count: 2 },
  ];
  const out = decrementEntry(entries, { tool: "Bash", signature: "b" });
  assertEqual(out[0].count, 2, "a untouched");
  assertEqual(out[1].count, 1, "b decremented");
});

check("plugin makes no network calls", () => {
  const banned = [
    "node:http",
    "node:https",
    "node:net",
    "node:dgram",
    "node:tls",
    "fetch(",
    "XMLHttpRequest",
    "WebSocket",
    "require('http",
    'require("http',
  ];
  for (const file of ["lib.mjs", "capture.mjs", "replay.mjs", "resolve.mjs"]) {
    const src = readFileSync(join(PLUGIN, "scripts", file), "utf8");
    for (const needle of banned) {
      assert(!src.includes(needle), `${file} references ${needle}`);
    }
  }
});

check("README documents the caveats a user needs", () => {
  const readme = readFileSync(join(PLUGIN, "README.md"), "utf8");
  for (const needle of ["ledger", "Nothing leaves your machine", "Restart Claude Code", "--keep-data"]) {
    assert(readme.includes(needle), `README missing: ${needle}`);
  }
});

// The Bash-only asymmetry is the single thing about this plugin a user is most
// likely to be surprised by: they fix an Edit failure and it keeps being
// replayed. Asserted here so the section cannot quietly be dropped -- and
// resolve.mjs names it by heading in its own header comment.
// The README's one verification step is "open the ledger file", so the path it
// gives has to be one a reader can actually resolve. Both documented paths are
// pinned here, and the fallback is asserted against the code that produces it so
// the two cannot drift apart in silence.
check("README gives a ledger path a reader can resolve", () => {
  const readme = readFileSync(join(PLUGIN, "README.md"), "utf8");
  const manifest = JSON.parse(
    readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"),
  );

  assert(
    !readme.includes("<plugin data dir>"),
    "README still uses the unresolved <plugin data dir> placeholder",
  );

  // Normal install. Claude Code derives the directory name from the plugin
  // identifier "<plugin>@<marketplace>"; the marketplace name is frozen.
  const installed = `~/.claude/plugins/data/${manifest.name}-carloluisito-plugins/ledger/`;
  assert(readme.includes(installed), `README does not document the installed path: ${installed}`);

  // Fallback, for when ${CLAUDE_PLUGIN_DATA} does not expand. Compare against
  // what resolveDataDir() really returns rather than a copy of it.
  const saved = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;
  let actual;
  try {
    actual = resolveDataDir(undefined);
  } finally {
    if (saved !== undefined) process.env.CLAUDE_PLUGIN_DATA = saved;
  }
  assert(
    actual === join(homedir(), ".claude", "plugins", "data", manifest.name),
    `fallback data dir moved to ${actual}; README says ~/.claude/plugins/data/${manifest.name}`,
  );
  assert(
    readme.includes(`~/.claude/plugins/data/${manifest.name}/ledger/`),
    "README does not document the fallback path",
  );

  // ~/.claude is a default, not a fixed root.
  assert(readme.includes("CLAUDE_CONFIG_DIR"), "README does not mention the config-dir override");
});

check("README documents that only Bash entries self-clear", () => {
  const readme = readFileSync(join(PLUGIN, "README.md"), "utf8");
  assert(
    readme.includes("## What self-clears and what does not"),
    "README missing the self-clearing section",
  );
  assert(readme.includes("Only \`Bash\` entries self-clear"), "README does not state the Bash-only limit");
  assert(/Three hooks/.test(readme), "README still describes two hooks");
});

check("hooks.json registers all three events with no absolute paths", () => {
  const raw = readFileSync(join(PLUGIN, "hooks", "hooks.json"), "utf8");
  const hooks = JSON.parse(raw).hooks;
  assert(Array.isArray(hooks.PostToolUseFailure), "PostToolUseFailure present");
  assert(Array.isArray(hooks.PostToolUse), "PostToolUse present");
  assert(Array.isArray(hooks.SessionStart), "SessionStart present");
  assertEqual(
    hooks.PostToolUseFailure[0].matcher,
    "Bash|Edit|Write|NotebookEdit|Task|mcp__.*",
    "capture matcher",
  );
  // Exactly Bash, and no wider. Every other tool's ledger key folds the error
  // text in, so a success could not reconstruct it -- see resolve.mjs.
  assertEqual(hooks.PostToolUse[0].matcher, "Bash", "resolve matcher is exactly Bash");
  assertEqual(hooks.PostToolUse.length, 1, "one PostToolUse matcher only");
  assert(hooks.SessionStart[0].matcher === undefined, "SessionStart has no matcher");
  assert(raw.includes("${CLAUDE_PLUGIN_ROOT}"), "uses CLAUDE_PLUGIN_ROOT");
  assert(!/[A-Za-z]:\\\\/.test(raw) && !raw.includes('"/home/') && !raw.includes('"/Users/'), "no absolute paths");
});

check("plugin.json does not re-declare the auto-discovered hooks file", () => {
  // Regression: declaring "hooks": "./hooks/hooks.json" in plugin.json makes
  // Claude Code refuse to load the plugin entirely -- "Duplicate hooks file
  // detected: ... resolves to already-loaded file". hooks/hooks.json is picked
  // up by convention; manifest.hooks is only for ADDITIONAL hook files.
  // Every repo validator passed while the plugin could not load at all.
  const manifest = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"));
  const declared = manifest.hooks;
  if (declared === undefined) return;
  const refs = Array.isArray(declared) ? declared : [declared];
  for (const ref of refs) {
    const normalized = String(ref).replace(/\\/g, "/").replace(/^\.\//, "");
    assert(
      normalized !== "hooks/hooks.json",
      `plugin.json declares ${ref}, which is already auto-loaded by convention`,
    );
  }
});

// --- concurrency ------------------------------------------------------------

console.log("concurrency");

function spawnHook(script, dataDir, payload) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [script, dataDir], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("close", (code) => res(code));
    child.on("error", () => res(-1));
    child.stdin.end(JSON.stringify(payload));
  });
}

await checkAsync("a concurrent decrement and capture does not lose a write", async () => {
  const d = freshDataDir();
  // Two signatures, seeded well above 1 so that neither run can legitimately
  // delete a row -- which would make a lost write look like a real clear.
  seedLedger(d, [
    { tool: "Bash", signature: "npm test", count: 8, first_seen: iso(2), last_seen: iso(1), error_excerpt: "x" },
    { tool: "Bash", signature: "git push", count: 8, first_seen: iso(2), last_seen: iso(1), error_excerpt: "y" },
  ]);

  const jobs = [];
  for (let i = 0; i < 6; i += 1) {
    jobs.push(spawnHook(RESOLVE, d, bashSuccess("npm test")));
    jobs.push(spawnHook(CAPTURE, d, bashFailure("git push")));
  }
  const codes = await Promise.all(jobs);
  for (const code of codes) assertEqual(code, 0, "every hook exited 0");

  const ledger = ledgerOf(d);
  assert(ledger, "ledger still readable");
  assertEqual(ledger.schema, SCHEMA, "schema intact");
  assertEqual(ledger.entries.length, 2, "both rows survived -- no torn or clobbered file");

  const decremented = ledger.entries.find((e) => e.signature === "npm test");
  const incremented = ledger.entries.find((e) => e.signature === "git push");
  assert(decremented, "decremented row present");
  assert(incremented, "incremented row present");

  // The lock drops an observation rather than blocking, so exact totals are not
  // guaranteed. What must hold is that writes moved in the right direction and
  // the file is never left corrupt or half-written.
  assert(decremented.count < 8, `decrements landed (count ${decremented.count})`);
  assert(decremented.count >= 2, `no row deleted from a count of 8 (count ${decremented.count})`);
  assert(incremented.count > 8, `increments landed (count ${incremented.count})`);
});

// --- ledger cli ------------------------------------------------------------

console.log("ledger cli");

// The CLI hashes the cwd it is actually running in, and the string Node reports
// there is not always the one handed to spawn (short names, drive-letter case).
// So ask the child itself, and seed the fixture under exactly that key.
function childCwd(dir) {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(process.cwd())"], {
    cwd: dir,
    encoding: "utf8",
  });
  return r.stdout;
}

function freshProjectDir() {
  const dir = mkdtempSync(join(tmpdir(), "failure-memory-proj-"));
  TEMP_DIRS.push(dir);
  return dir;
}

function fixtureProject() {
  const dir = freshProjectDir();
  return { dir, cwd: childCwd(dir) };
}

function ledgerCli(args, { dataDir, cwd }) {
  return spawnSync(process.execPath, [LEDGER, ...args, "--data", dataDir], {
    cwd,
    encoding: "utf8",
  });
}

// Three entries: one replay-eligible, one too rare, one too old.
function ledgerFixture() {
  return [
    { tool: "Bash", signature: "npm test", error_excerpt: "npm: command not found", count: 4, first_seen: iso(9), last_seen: iso(1) },
    { tool: "Bash", signature: "git push --force origin main", error_excerpt: "GH006 Protected branch update failed", count: 1, first_seen: iso(3), last_seen: iso(3) },
    { tool: "Write", signature: "Write scripts/ledger.mjs", error_excerpt: "File has not been read yet", count: 3, first_seen: iso(120), last_seen: iso(90) },
  ];
}

// Rows are "<mark> <id>  ..." with mark "*" or " ". Match the id shape rather
// than the leading "* ", or the legend line ("* = replayed into new sessions
// here: ...") is read as an entry.
const ROW = /^(\*| ) ([0-9a-f]{8}) /;

function rowIds(stdout, { starred }) {
  return stdout
    .split("\n")
    .map((line) => ROW.exec(line))
    .filter((m) => m && (m[1] === "*") === starred)
    .map((m) => m[2])
    .sort();
}

function starredIds(stdout) {
  return rowIds(stdout, { starred: true });
}

check("list reports a project that has no ledger yet", () => {
  const d = freshDataDir();
  const p = fixtureProject();
  const r = ledgerCli(["list"], { dataDir: d, cwd: p.dir });
  assertEqual(r.status, 0, "exit code");
  assert(/No ledger yet/.test(r.stdout), `says so: ${r.stdout}`);
  assert(r.stdout.includes(ledgerPathFor(d, p.cwd)), "names where it would live");
});

// The starred rows are the plugin's claim about what SessionStart will replay.
// If that claim drifts from selectForReplay() the listing misinforms, which is
// worse than not having a listing at all.
check("the starred rows are exactly the rows replay would show", () => {
  const d = freshDataDir();
  const p = fixtureProject();
  const entries = ledgerFixture();
  seedLedger(d, entries, p.cwd);

  const r = ledgerCli(["list"], { dataDir: d, cwd: p.dir });
  assertEqual(r.status, 0, "exit code");

  const expected = selectForReplay(entries).map(idFor).sort();
  assertEqual(expected.length, 1, "fixture has exactly one eligible entry");
  assertEqual(starredIds(r.stdout).join(","), expected.join(","), "starred ids");
  assert(/replayed at session start: 1/.test(r.stdout), "eligible count stated");

  // The other two are listed, just not starred -- an unmarked row is the signal
  // that an entry is recorded but silent, which is what the skill tells the user.
  const ineligible = entries.filter((e) => !selectForReplay(entries).includes(e)).map(idFor).sort();
  assertEqual(rowIds(r.stdout, { starred: false }).join(","), ineligible.join(","), "unstarred ids");
});

check("every seeded entry appears in the listing, starred or not", () => {
  const d = freshDataDir();
  const p = fixtureProject();
  const entries = ledgerFixture();
  seedLedger(d, entries, p.cwd);

  const r = ledgerCli(["list"], { dataDir: d, cwd: p.dir });
  for (const entry of entries) {
    assert(r.stdout.includes(idFor(entry)), `id for ${entry.signature} shown`);
  }
  assert(/entries:  3/.test(r.stdout), "total stated");
});

check("a full ledger stays inside the output budget and says what it omitted", () => {
  const d = freshDataDir();
  const p = fixtureProject();
  const entries = [];
  for (let i = 0; i < MAX_ENTRIES; i += 1) {
    entries.push({
      tool: "Bash",
      signature: `command-number-${i} ${"x".repeat(120)}`,
      error_excerpt: "boom",
      count: 3,
      first_seen: iso(5),
      last_seen: iso(1),
    });
  }
  seedLedger(d, entries, p.cwd);

  const r = ledgerCli(["list"], { dataDir: d, cwd: p.dir });
  assertEqual(r.status, 0, "exit code");
  assert(r.stdout.length < 10_000, `output bounded (${r.stdout.length} chars)`);
  assert(/not shown/.test(r.stdout), "omission stated rather than silent");
  assert(r.stdout.includes(ledgerPathFor(d, p.cwd)), "points at the file for the rest");
});

check("forget removes only the named entry and leaves the others untouched", () => {
  const d = freshDataDir();
  const p = fixtureProject();
  const entries = ledgerFixture();
  const path = seedLedger(d, entries, p.cwd);

  const target = idFor(entries[1]);
  const r = ledgerCli(["forget", target], { dataDir: d, cwd: p.dir });
  assertEqual(r.status, 0, "exit code");
  assert(r.stdout.includes("Forgot 1 entry"), `reports the removal: ${r.stdout}`);

  const after = JSON.parse(readFileSync(path, "utf8"));
  assertEqual(after.schema, SCHEMA, "schema preserved");
  assertEqual(after.cwd, p.cwd, "cwd preserved");
  // Deep equality including key order: counts and timestamps of the survivors
  // must come through the rewrite unchanged, not recomputed.
  assertEqual(
    JSON.stringify(after.entries),
    JSON.stringify([entries[0], entries[2]]),
    "survivors byte-identical",
  );
});

check("forget takes several ids at once", () => {
  const d = freshDataDir();
  const p = fixtureProject();
  const entries = ledgerFixture();
  const path = seedLedger(d, entries, p.cwd);

  const r = ledgerCli(["forget", idFor(entries[0]), idFor(entries[2])], { dataDir: d, cwd: p.dir });
  assertEqual(r.status, 0, "exit code");
  const after = JSON.parse(readFileSync(path, "utf8"));
  assertEqual(JSON.stringify(after.entries), JSON.stringify([entries[1]]), "one survivor");
});

// An id is derived from the entry's own content, so removing an unrelated row
// must not renumber anything. If ids were positional, a listing pasted into a
// later turn would delete the wrong entry.
check("an id does not change when an unrelated entry is removed", () => {
  const d = freshDataDir();
  const p = fixtureProject();
  const entries = ledgerFixture();
  seedLedger(d, entries, p.cwd);

  const before = ledgerCli(["list"], { dataDir: d, cwd: p.dir }).stdout;
  const keeperId = idFor(entries[0]);
  assert(before.includes(keeperId), "keeper listed before");

  ledgerCli(["forget", idFor(entries[1])], { dataDir: d, cwd: p.dir });
  const after = ledgerCli(["list"], { dataDir: d, cwd: p.dir }).stdout;
  assert(after.includes(keeperId), "keeper keeps its id after an unrelated removal");
});

check("forget with an unknown id changes nothing", () => {
  const d = freshDataDir();
  const p = fixtureProject();
  const path = seedLedger(d, ledgerFixture(), p.cwd);
  const before = readFileSync(path, "utf8");

  const r = ledgerCli(["forget", "deadbeef"], { dataDir: d, cwd: p.dir });
  assertEqual(r.status, 0, "exit code");
  assert(/Nothing was changed/.test(r.stdout), `says so: ${r.stdout}`);
  assertEqual(readFileSync(path, "utf8"), before, "file untouched");
});

check("forget with no id at all changes nothing", () => {
  const d = freshDataDir();
  const p = fixtureProject();
  const path = seedLedger(d, ledgerFixture(), p.cwd);
  const before = readFileSync(path, "utf8");

  const r = ledgerCli(["forget"], { dataDir: d, cwd: p.dir });
  assertEqual(r.status, 0, "exit code");
  assert(/needs at least one entry id/.test(r.stdout), `asks for one: ${r.stdout}`);
  assertEqual(readFileSync(path, "utf8"), before, "file untouched");
});

// readLedger() quarantines a corrupt file by renaming it. That is right for a
// hook and wrong for an inspector: looking at a broken ledger must not be the
// thing that moves it out of the way.
check("a corrupt ledger is reported and left exactly where it is", () => {
  const d = freshDataDir();
  const p = fixtureProject();
  const path = ledgerPathFor(d, p.cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{ not json at all", "utf8");

  for (const args of [["list"], ["forget", "deadbeef"]]) {
    const r = ledgerCli(args, { dataDir: d, cwd: p.dir });
    assertEqual(r.status, 0, `exit code for ${args[0]}`);
    assert(/could not be read|not valid JSON|Nothing was changed/i.test(r.stdout), `${args[0]} explains: ${r.stdout}`);
    assertEqual(readFileSync(path, "utf8"), "{ not json at all", `${args[0]} left the file alone`);
    const siblings = readdirSync(dirname(path));
    assertEqual(
      siblings.filter((f) => f.endsWith(".corrupt")).length,
      0,
      `${args[0]} did not quarantine the file`,
    );
  }
});

check("a ledger from another schema is reported, not overwritten", () => {
  const d = freshDataDir();
  const p = fixtureProject();
  const path = ledgerPathFor(d, p.cwd);
  mkdirSync(dirname(path), { recursive: true });
  const foreign = JSON.stringify({ cwd: p.cwd, schema: SCHEMA + 97, entries: [] }, null, 2);
  writeFileSync(path, foreign, "utf8");

  const r = ledgerCli(["list"], { dataDir: d, cwd: p.dir });
  assertEqual(r.status, 0, "exit code");
  assert(/schema/i.test(r.stdout), `mentions the schema: ${r.stdout}`);
  assertEqual(readFileSync(path, "utf8"), foreign, "file untouched");
});

// withLock() creates the ledger directory as a side effect. Inspecting a project
// that has never recorded a failure must not leave a data directory behind.
check("neither command creates a data directory that did not exist", () => {
  const parent = freshDataDir();
  const absent = join(parent, "not-created-yet");
  const p = fixtureProject();

  for (const args of [["list"], ["forget", "deadbeef"]]) {
    const r = ledgerCli(args, { dataDir: absent, cwd: p.dir });
    assertEqual(r.status, 0, `exit code for ${args[0]}`);
    assertEqual(existsSync(absent), false, `${args[0]} created nothing`);
  }
});

check("an unknown command explains itself instead of failing the turn", () => {
  const d = freshDataDir();
  const p = fixtureProject();
  const r = ledgerCli(["explode"], { dataDir: d, cwd: p.dir });
  assertEqual(r.status, 0, "exit code");
  assert(/Unknown command/.test(r.stdout), `names the problem: ${r.stdout}`);
  assert(/list|forget/.test(r.stdout), "names what it does accept");
});

// --- summary ---------------------------------------------------------------

cleanupTempDirs();
check("the suite leaves no temp directories behind", () => {
  const leaked = TEMP_DIRS.filter((dir) => existsSync(dir));
  assertEqual(
    leaked.length,
    0,
    `leaked ${leaked.length} of ${TEMP_DIRS.length} temp dirs, e.g. ${leaked[0]}`,
  );
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
