#!/usr/bin/env node
// Tests for failure-memory. Plain Node, zero dependencies.
// Run from the plugin directory: node tests/run.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_ENTRIES,
  RENDER_BUDGET,
  SCHEMA,
  firstStage,
  ledgerPathFor,
  normalizeText,
  redact,
  renderContext,
  selectForReplay,
  shortDate,
  signatureFor,
  sortFlags,
  tokenize,
} from "../scripts/lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..");
const CAPTURE = join(PLUGIN, "scripts", "capture.mjs");
const REPLAY = join(PLUGIN, "scripts", "replay.mjs");

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || "not equal"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// --- harness ---------------------------------------------------------------

function freshDataDir() {
  return mkdtempSync(join(tmpdir(), "failure-memory-test-"));
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
  for (const file of ["lib.mjs", "capture.mjs", "replay.mjs"]) {
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

check("hooks.json registers both events with no absolute paths", () => {
  const raw = readFileSync(join(PLUGIN, "hooks", "hooks.json"), "utf8");
  const hooks = JSON.parse(raw).hooks;
  assert(Array.isArray(hooks.PostToolUseFailure), "PostToolUseFailure present");
  assert(Array.isArray(hooks.SessionStart), "SessionStart present");
  assertEqual(
    hooks.PostToolUseFailure[0].matcher,
    "Bash|Edit|Write|NotebookEdit|Task|mcp__.*",
    "capture matcher",
  );
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

// --- summary ---------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
