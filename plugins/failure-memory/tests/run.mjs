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
  ledgerPathFor,
  normalizeText,
  redact,
  renderContext,
  selectForReplay,
  signatureFor,
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
  writeFileSync(p, JSON.stringify({ cwd, schema: 1, entries }, null, 2), "utf8");
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
  assertEqual(l.schema, 1, "schema");
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

check("ledger with a foreign shape is recovered too", () => {
  const d = freshDataDir();
  const p = ledgerPathFor(d, PROJECT);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ schema: 99, whatever: true }), "utf8");
  capture(d, bashFailure("npm test"));
  const l = ledgerOf(d);
  assertEqual(l.schema, 1, "schema reset");
  assertEqual(l.entries.length, 1, "entry recorded");
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

// --- summary ---------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
