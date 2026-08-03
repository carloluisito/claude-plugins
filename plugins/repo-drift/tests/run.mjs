#!/usr/bin/env node
// Tests for repo-drift.
//
// Two kinds of test live here. Unit tests call into scripts/lib.mjs directly,
// which is how the rendering rules (no imperatives, length budget, ref
// clamping) get checked against the string the plugin would actually emit.
// End-to-end tests spawn scripts/drift.mjs with synthetic hook payloads on
// stdin against real throwaway git repositories, because the interesting
// behaviour of this plugin is what it does when git, the filesystem, or the
// payload is not what it hoped for.
//
// Plain Node, no dependencies. Run: node tests/run.mjs

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_SESSIONS,
  PRUNE_DAYS,
  RENDER_BUDGET,
  describeDrift,
  emptyState,
  fingerprintOf,
  pruneSessions,
  readState,
  recordFingerprint,
  resolveDataDir,
  sameFingerprint,
  statePathFor,
  writeStateAtomic,
} from "../scripts/lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(HERE, "..");
const SCRIPT = join(PLUGIN, "scripts", "drift.mjs");

// ---------------------------------------------------------------- harness

const failures = [];
let passed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const TEMP_DIRS = [];

function freshDataDir() {
  const dir = mkdtempSync(join(tmpdir(), "repo-drift-data-"));
  TEMP_DIRS.push(dir);
  return dir;
}

function freshProjectDir() {
  const dir = mkdtempSync(join(tmpdir(), "repo-drift-proj-"));
  TEMP_DIRS.push(dir);
  return dir;
}

function cleanupTempDirs() {
  for (const dir of TEMP_DIRS) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* Best effort; a leftover temp dir fails the final check below. */
    }
  }
}

// ------------------------------------------------------------- git fixtures

// Never inherit the developer's git identity, hooks, or signing config: a
// machine with commit.gpgsign on would otherwise fail every fixture commit.
function git(dir, ...args) {
  const r = spawnSync(
    "git",
    [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=repo-drift tests",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd: dir, encoding: "utf8", windowsHide: true },
  );
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout || r.error?.message}`);
  }
  return (r.stdout ?? "").trim();
}

// A repository with exactly one commit on `main`. Anything that needs more
// history adds it explicitly, so each test's setup reads on its own.
function initRepo() {
  const dir = freshProjectDir();
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n", "utf8");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "one");
  return dir;
}

function commitMore(dir, name) {
  writeFileSync(join(dir, name), `${name}\n`, "utf8");
  git(dir, "add", name);
  git(dir, "commit", "-q", "-m", name);
  return git(dir, "rev-parse", "HEAD");
}

// -------------------------------------------------------------- invocation

function run(dataDir, payload, extraEnv) {
  return spawnSync(process.execPath, [SCRIPT, dataDir], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    cwd: payload && typeof payload === "object" && payload.cwd ? payload.cwd : process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
}

// The contract for "said nothing": exit 0, not one byte on stdout, and nothing
// on stderr that a user could see.
function assertSilent(res, where) {
  assertEqual(res.status, 0, `${where}: exit status`);
  assertEqual(res.stdout, "", `${where}: stdout must be empty`);
  assertEqual((res.stderr ?? "").trim(), "", `${where}: stderr must be empty`);
}

// Parse the emitted hook output, asserting it is exactly one JSON object of the
// documented shape, and hand back the injected text.
function injection(res, where) {
  assertEqual(res.status, 0, `${where}: exit status`);
  const raw = res.stdout.trim();
  assert(raw.length > 0, `${where}: expected an injection, got empty stdout`);
  assert(!raw.slice(1).includes("{\"hookSpecificOutput\""), `${where}: more than one object emitted`);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${where}: stdout is not JSON — ${e.message}: ${JSON.stringify(raw)}`);
  }
  const out = parsed?.hookSpecificOutput;
  assert(out && typeof out === "object", `${where}: missing hookSpecificOutput`);
  assertEqual(out.hookEventName, "UserPromptSubmit", `${where}: hookEventName`);
  assert(typeof out.additionalContext === "string", `${where}: additionalContext must be a string`);
  assert(out.additionalContext.length > 0, `${where}: additionalContext must not be empty`);
  return out.additionalContext;
}

function storedFingerprint(dataDir, cwd, sessionId) {
  const path = statePathFor(resolveDataDir(dataDir), cwd);
  return readState(path, cwd).sessions[sessionId]?.fingerprint ?? null;
}

// ============================================================ structural

check("the hook is declared in hooks/hooks.json only, never in plugin.json", () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN, "hooks", "hooks.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"));

  const events = Object.keys(hooks.hooks ?? {});
  assertEqual(events.join(","), "UserPromptSubmit", "hooks.json should declare exactly one event");
  assertEqual(hooks.hooks.UserPromptSubmit.length, 1, "one matcher group");
  assertEqual(hooks.hooks.UserPromptSubmit[0].hooks.length, 1, "one command");

  // Declaring hooks in both files makes Claude Code report "Duplicate hooks
  // file detected" and register *none* of them — a silent, total failure that
  // `claude plugin validate` does not catch. This is the regression guard.
  assert(!("hooks" in manifest), "plugin.json must not declare a `hooks` field");
});

check("the hook command is relocatable and time-bounded", () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN, "hooks", "hooks.json"), "utf8"));
  const entry = hooks.hooks.UserPromptSubmit[0].hooks[0];
  assertEqual(entry.type, "command", "hook type");
  assert(
    entry.command.includes("${CLAUDE_PLUGIN_ROOT}"),
    "command must locate its script via ${CLAUDE_PLUGIN_ROOT}",
  );
  assert(!/[A-Za-z]:[\\/]/.test(entry.command), "command must not contain an absolute path");
  assert(
    typeof entry.timeout === "number" && entry.timeout > 0 && entry.timeout <= 10,
    "command needs a small timeout: it runs before every prompt",
  );
});

check("the plugin declares no runtime dependencies", () => {
  assert(
    !existsSync(join(PLUGIN, "package.json")) &&
      !existsSync(join(PLUGIN, "node_modules")),
    "repo-drift must be plain Node with no dependency surface",
  );
});

// The README tells a reader to open one of these files and says what they will
// find. A live install caught it naming two fields that do not exist (`cwd` and
// `updated`, for what are really `project` and `last_seen`), which every test
// here passed straight through: the code was right and the prose describing it
// was wrong. Nothing but comparing the two catches that, so this compares them.
check("the README documents the state file this plugin actually writes", () => {
  const dir = initRepo();
  const dataDir = freshDataDir();
  run(dataDir, { cwd: dir, session_id: "s1" });

  const written = JSON.parse(
    readFileSync(statePathFor(resolveDataDir(dataDir), dir), "utf8"),
  );
  const readme = readFileSync(join(PLUGIN, "README.md"), "utf8");

  const block = readme.match(/```json\n([\s\S]*?)```/)?.[1];
  assert(block, "the README must show the state file's shape as a json block");
  const documented = JSON.parse(block.replace(/…/g, ""));

  const session = Object.values(written.sessions)[0];
  const documentedSession = Object.values(documented.sessions)[0];

  assertEqual(
    Object.keys(documented).sort().join(","),
    Object.keys(written).sort().join(","),
    "documented top-level fields must be the ones actually written",
  );
  assertEqual(
    Object.keys(documentedSession).sort().join(","),
    Object.keys(session).sort().join(","),
    "documented per-session fields must be the ones actually written",
  );
  assertEqual(
    Object.keys(documentedSession.fingerprint).sort().join(","),
    Object.keys(session.fingerprint).sort().join(","),
    "documented fingerprint fields must be the ones actually written",
  );

  // Types matter as much as names: `last_seen` reads as a timestamp either way,
  // and an epoch number in the docs would send a reader looking for the wrong
  // thing. This is the half of the defect that a key comparison alone misses.
  for (const key of Object.keys(session)) {
    assertEqual(
      typeof documentedSession[key],
      typeof session[key],
      `documented type of \`${key}\``,
    );
  }

  // Every field name the prose mentions has to be a field that exists.
  for (const named of readme.match(/`(project|cwd|last_seen|updated|schema)`/g) ?? []) {
    const field = named.replaceAll("`", "");
    assert(
      field in written || field in session,
      `README refers to a \`${field}\` field that is never written`,
    );
  }
});

// ============================================================ rendering

const FP = (branch, head, ops = []) => ({ branch, head, ops });

check("nothing is said when there is no previous fingerprint", () => {
  assertEqual(describeDrift(null, FP("main", "a".repeat(40))), "", "no prior means no note");
});

check("nothing is said when the fingerprint is unchanged", () => {
  const fp = FP("main", "a".repeat(40));
  assertEqual(describeDrift(fp, { ...fp }), "", "identical fingerprints");
  assert(sameFingerprint(fp, { ...fp }), "sameFingerprint should agree");
});

check("a branch change names both branches", () => {
  const text = describeDrift(FP("main", "a".repeat(40)), FP("feat/auth", "a".repeat(40)));
  assert(text.includes("main"), "old branch");
  assert(text.includes("feat/auth"), "new branch");
  assert(!text.includes("HEAD:"), "HEAD did not move, so it should not be reported");
});

check("a HEAD move on the same branch names both short shas", () => {
  const text = describeDrift(FP("main", "a".repeat(40)), FP("main", "b".repeat(40)));
  assert(text.includes("aaaaaaa"), "old sha");
  assert(text.includes("bbbbbbb"), "new sha");
  assert(!text.includes("branch:"), "branch did not change");
});

check("an in-progress operation is named, and so is its disappearance", () => {
  const started = describeDrift(FP("main", "a".repeat(40)), FP("main", "a".repeat(40), ["merge"]));
  assert(/in progress: merge/.test(started), `expected a merge note, got: ${started}`);

  const finished = describeDrift(FP("main", "a".repeat(40), ["rebase"]), FP("main", "a".repeat(40)));
  assert(/in progress: nothing/.test(finished), `expected an all-clear, got: ${finished}`);
  assert(finished.includes("rebase"), "the finished note should say what ended");
});

check("a detached HEAD is described as a state, not as a ref named HEAD", () => {
  const text = describeDrift(FP("main", "a".repeat(40)), FP("HEAD", "b".repeat(40)));
  assert(text.includes("detached HEAD"), `expected "detached HEAD", got: ${text}`);
});

check("an absurd branch name is truncated", () => {
  const long = `feat/${"x".repeat(300)}`;
  const text = describeDrift(FP("main", "a".repeat(40)), FP(long, "a".repeat(40)));
  assert(!text.includes("x".repeat(60)), "a 300-char ref must not be emitted whole");
  assert(text.length <= RENDER_BUDGET, "still within budget");
});

check("every injection stays under 400 characters", () => {
  const cases = [
    describeDrift(FP("main", "a".repeat(40)), FP("feat/auth", "b".repeat(40), ["merge"])),
    describeDrift(
      FP(`release/${"y".repeat(200)}`, "a".repeat(40), ["rebase", "cherry-pick"]),
      FP(`hotfix/${"z".repeat(200)}`, "b".repeat(40), ["merge", "cherry-pick", "rebase"]),
    ),
  ];
  for (const text of cases) {
    assert(text.length > 0, "these cases should all produce a note");
    assert(text.length < 400, `injection too long (${text.length}): ${text}`);
    assert(text.length <= RENDER_BUDGET, "budget is the tighter bound");
  }
});

check("the injection states a fact and never issues an instruction", () => {
  // The model receives this without the user seeing it. An observation it can
  // weigh costs nothing when irrelevant; an instruction steers the turn with
  // nothing on screen to explain why.
  const banned = [
    "re-read",
    "reread",
    "you must",
    "you should",
    "make sure",
    "be sure to",
    "please",
    "do not",
    "don't",
    "remember to",
    "consider",
    "should probably",
  ];
  const cases = [
    describeDrift(FP("main", "a".repeat(40)), FP("feat/auth", "a".repeat(40))),
    describeDrift(FP("main", "a".repeat(40)), FP("main", "b".repeat(40))),
    describeDrift(FP("main", "a".repeat(40)), FP("main", "a".repeat(40), ["merge"])),
    describeDrift(FP("main", "a".repeat(40), ["rebase"]), FP("HEAD", "b".repeat(40))),
  ];
  for (const text of cases) {
    assert(text.length > 0, "case produced no note");
    const lower = text.toLowerCase();
    for (const phrase of banned) {
      assert(!lower.includes(phrase), `injection contains the imperative "${phrase}": ${text}`);
    }
  }
});

// ============================================================ state file

check("state is keyed on the project path, and the path leaks nothing about it", () => {
  const a = statePathFor("/data", "/home/someone/secret-project");
  const b = statePathFor("/data", "/home/someone/other-project");
  assert(a !== b, "different projects must not share a state file");
  assert(!a.includes("secret-project"), "the filename must not embed the project path");
  assertEqual(a, statePathFor("/data", "/home/someone/secret-project"), "keying must be stable");
});

check("an unexpanded placeholder is never used as a data directory", () => {
  const resolved = resolveDataDir("${CLAUDE_PLUGIN_DATA}");
  assert(
    !resolved.includes("${"),
    `a literal placeholder would create a junk directory: ${resolved}`,
  );
  assertEqual(resolveDataDir("/real/dir"), "/real/dir", "a real value is used as given");
});

check("sessions not seen in a week are dropped on write", () => {
  const now = Date.parse("2026-01-20T00:00:00.000Z");
  const old = new Date(now - (PRUNE_DAYS + 1) * 86400000).toISOString();
  const sessions = {
    stale: { fingerprint: FP("main", "a".repeat(40)), last_seen: old },
    live: { fingerprint: FP("main", "a".repeat(40)), last_seen: new Date(now).toISOString() },
  };
  const pruned = pruneSessions(sessions, now);
  assert(!("stale" in pruned), "a week-old session should be gone");
  assert("live" in pruned, "a current session should survive");
});

check("an unparseable timestamp is treated as ancient rather than kept forever", () => {
  const now = Date.now();
  const pruned = pruneSessions(
    { junk: { fingerprint: FP("main", "a".repeat(40)), last_seen: "not a date" } },
    now,
  );
  assert(!("junk" in pruned), "a session with no usable timestamp must not be immortal");
});

check("the session count is capped", () => {
  const now = Date.now();
  const sessions = {};
  for (let i = 0; i < MAX_SESSIONS + 25; i += 1) {
    sessions[`s${i}`] = {
      fingerprint: FP("main", "a".repeat(40)),
      // Younger ids first, so the cap is observably keeping the freshest.
      last_seen: new Date(now - i * 1000).toISOString(),
    };
  }
  const pruned = pruneSessions(sessions, now);
  assertEqual(Object.keys(pruned).length, MAX_SESSIONS, "cap not applied");
  assert("s0" in pruned, "the freshest session must survive the cap");
  assert(!(`s${MAX_SESSIONS + 24}` in pruned), "the oldest session must be dropped by the cap");
});

check("a corrupt state file reads as empty rather than throwing", () => {
  const dataDir = freshDataDir();
  const path = join(dataDir, "state.json");
  for (const body of ["", "   ", "{", "null", "[]", '{"schema":999,"sessions":{}}', '{"schema":1}']) {
    writeFileSync(path, body, "utf8");
    const state = readState(path, "/proj");
    assertEqual(
      JSON.stringify(state),
      JSON.stringify(emptyState("/proj")),
      `corrupt body ${JSON.stringify(body)} should read as empty`,
    );
  }
});

check("a state entry of the wrong shape is discarded, not trusted", () => {
  const dataDir = freshDataDir();
  const path = join(dataDir, "state.json");
  writeFileSync(
    path,
    JSON.stringify({
      schema: 1,
      project: "/proj",
      sessions: {
        good: { fingerprint: { head: "a".repeat(40), branch: "main", ops: ["merge", 7] } },
        noFingerprint: { last_seen: new Date().toISOString() },
        badHead: { fingerprint: { head: 12, branch: "main" } },
      },
    }),
    "utf8",
  );
  const state = readState(path, "/proj");
  assertEqual(Object.keys(state.sessions).join(","), "good", "only the well-formed entry survives");
  assertEqual(state.sessions.good.fingerprint.ops.join(","), "merge", "non-string ops are dropped");
});

check("writes are atomic and leave no temporary files behind", () => {
  const dataDir = freshDataDir();
  const path = join(dataDir, "nested", "state.json");
  writeStateAtomic(path, emptyState("/proj"));
  assert(existsSync(path), "the state file should exist");
  const leftovers = readdirSync(join(dataDir, "nested")).filter((f) => f.includes(".tmp-"));
  assertEqual(leftovers.length, 0, `temporary files left behind: ${leftovers.join(", ")}`);
});

check("recording one session's fingerprint preserves the others", () => {
  const dataDir = freshDataDir();
  const path = join(dataDir, "state.json");
  const now = Date.now();
  recordFingerprint(path, "/proj", "a", FP("main", "a".repeat(40)), now);
  recordFingerprint(path, "/proj", "b", FP("feat", "b".repeat(40)), now);
  const state = readState(path, "/proj");
  assertEqual(state.sessions.a?.fingerprint.branch, "main", "session a survived");
  assertEqual(state.sessions.b?.fingerprint.branch, "feat", "session b was added");
});

// ============================================================ fingerprinting

check("a repository fingerprints to its branch, HEAD, and in-flight operations", () => {
  const dir = initRepo();
  const fp = fingerprintOf(dir);
  assert(fp, "expected a fingerprint");
  assertEqual(fp.branch, "main", "branch");
  assertEqual(fp.head, git(dir, "rev-parse", "HEAD"), "head");
  assertEqual(fp.ops.join(","), "", "no operation in flight");
});

check("an in-progress merge is detected without walking the worktree", () => {
  const dir = initRepo();
  writeFileSync(join(dir, ".git", "MERGE_HEAD"), `${git(dir, "rev-parse", "HEAD")}\n`, "utf8");
  assertEqual(fingerprintOf(dir).ops.join(","), "merge", "MERGE_HEAD should read as a merge");
});

check("an in-progress rebase is detected in either of its two layouts", () => {
  const merge = initRepo();
  mkdirSync(join(merge, ".git", "rebase-merge"));
  assertEqual(fingerprintOf(merge).ops.join(","), "rebase", "rebase-merge");

  const apply = initRepo();
  mkdirSync(join(apply, ".git", "rebase-apply"));
  assertEqual(fingerprintOf(apply).ops.join(","), "rebase", "rebase-apply");
});

check("a linked worktree fingerprints against its own git dir, not the main one", () => {
  // In a linked worktree `.git` is a *file* and the per-worktree MERGE_HEAD
  // lives under <main>/.git/worktrees/<name>/. Hardcoding ".git/" here would
  // silently never see an in-progress merge in a worktree.
  const main = initRepo();
  const linked = join(main, "..", `wt-${Math.random().toString(36).slice(2, 8)}`);
  TEMP_DIRS.push(resolve(linked));
  git(main, "worktree", "add", "-q", "-b", "side", linked);

  const fp = fingerprintOf(linked);
  assert(fp, "expected a fingerprint from the linked worktree");
  assertEqual(fp.branch, "side", "the worktree has its own branch");

  const gitDir = spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd: linked,
    encoding: "utf8",
    windowsHide: true,
  }).stdout.trim();
  writeFileSync(join(gitDir, "MERGE_HEAD"), `${fp.head}\n`, "utf8");
  assertEqual(fingerprintOf(linked).ops.join(","), "merge", "per-worktree MERGE_HEAD");

  // Leave nothing registered in the main repo for the cleanup pass to trip on.
  rmSync(join(gitDir, "MERGE_HEAD"), { force: true });
  try {
    git(main, "worktree", "remove", "--force", linked);
  } catch {
    /* rmSync in cleanup will take it. */
  }
});

check("a directory that is not a repository has no fingerprint", () => {
  assertEqual(fingerprintOf(freshProjectDir()), null, "not a repo");
});

check("a repository with no commits yet has no fingerprint", () => {
  const dir = freshProjectDir();
  git(dir, "init", "-q", "-b", "main");
  assertEqual(fingerprintOf(dir), null, "unborn HEAD has nothing to compare");
});

// ============================================================ end to end

check("the first prompt in a session says nothing and stores a baseline", () => {
  const dataDir = freshDataDir();
  const dir = initRepo();
  const res = run(dataDir, { cwd: dir, session_id: "s1" });
  assertSilent(res, "first prompt");
  const stored = storedFingerprint(dataDir, dir, "s1");
  assert(stored, "a baseline should have been stored");
  assertEqual(stored.branch, "main", "stored branch");
});

check("a second prompt with nothing moved says nothing at all", () => {
  const dataDir = freshDataDir();
  const dir = initRepo();
  run(dataDir, { cwd: dir, session_id: "s1" });
  assertSilent(run(dataDir, { cwd: dir, session_id: "s1" }), "second prompt");
});

check("switching branch between prompts is reported once, then goes quiet", () => {
  const dataDir = freshDataDir();
  const dir = initRepo();
  run(dataDir, { cwd: dir, session_id: "s1" });

  git(dir, "checkout", "-q", "-b", "feat/auth");
  const text = injection(run(dataDir, { cwd: dir, session_id: "s1" }), "branch change");
  assert(text.includes("main"), `should name the old branch: ${text}`);
  assert(text.includes("feat/auth"), `should name the new branch: ${text}`);
  assert(text.length < 400, "under the injection budget");

  // Reported once. Repeating it every prompt would be noise, and the model
  // already has the fact.
  assertSilent(run(dataDir, { cwd: dir, session_id: "s1" }), "prompt after the report");
});

check("a commit landing between prompts is reported as a HEAD move", () => {
  const dataDir = freshDataDir();
  const dir = initRepo();
  const before = git(dir, "rev-parse", "HEAD");
  run(dataDir, { cwd: dir, session_id: "s1" });

  const after = commitMore(dir, "b.txt");
  const text = injection(run(dataDir, { cwd: dir, session_id: "s1" }), "head move");
  assert(text.includes(before.slice(0, 7)), `should name the old sha: ${text}`);
  assert(text.includes(after.slice(0, 7)), `should name the new sha: ${text}`);
});

check("a merge left in progress between prompts is reported", () => {
  const dataDir = freshDataDir();
  const dir = initRepo();
  run(dataDir, { cwd: dir, session_id: "s1" });

  writeFileSync(join(dir, ".git", "MERGE_HEAD"), `${git(dir, "rev-parse", "HEAD")}\n`, "utf8");
  const text = injection(run(dataDir, { cwd: dir, session_id: "s1" }), "merge in progress");
  assert(/in progress: merge/.test(text), `should report the merge: ${text}`);
});

check("a rebase left in progress between prompts is reported", () => {
  const dataDir = freshDataDir();
  const dir = initRepo();
  run(dataDir, { cwd: dir, session_id: "s1" });

  mkdirSync(join(dir, ".git", "rebase-merge"));
  const text = injection(run(dataDir, { cwd: dir, session_id: "s1" }), "rebase in progress");
  assert(/in progress: rebase/.test(text), `should report the rebase: ${text}`);
});

check("checking out and coming back between prompts says nothing", () => {
  // Only the state at prompt time matters. Reporting a round trip that ended
  // where it started would be a false alarm.
  const dataDir = freshDataDir();
  const dir = initRepo();
  run(dataDir, { cwd: dir, session_id: "s1" });

  git(dir, "checkout", "-q", "-b", "detour");
  git(dir, "checkout", "-q", "main");
  assertSilent(run(dataDir, { cwd: dir, session_id: "s1" }), "round trip");
});

check("a detached HEAD that does not move says nothing on the second prompt", () => {
  const dataDir = freshDataDir();
  const dir = initRepo();
  const first = git(dir, "rev-parse", "HEAD");
  commitMore(dir, "b.txt");
  git(dir, "checkout", "-q", first);

  run(dataDir, { cwd: dir, session_id: "s1" });
  assertSilent(run(dataDir, { cwd: dir, session_id: "s1" }), "detached, unchanged");
});

check("entering a detached HEAD between prompts is reported as such", () => {
  const dataDir = freshDataDir();
  const dir = initRepo();
  const first = git(dir, "rev-parse", "HEAD");
  commitMore(dir, "b.txt");

  run(dataDir, { cwd: dir, session_id: "s1" });
  git(dir, "checkout", "-q", first);
  const text = injection(run(dataDir, { cwd: dir, session_id: "s1" }), "detaching");
  assert(text.includes("detached HEAD"), `should name the state: ${text}`);
});

check("two sessions in one project do not consume each other's fingerprint", () => {
  const dataDir = freshDataDir();
  const dir = initRepo();

  // Both sessions take a baseline, and neither one's baseline counts as the
  // other's previous turn.
  assertSilent(run(dataDir, { cwd: dir, session_id: "A" }), "A first");
  assertSilent(run(dataDir, { cwd: dir, session_id: "B" }), "B first");
  assertSilent(run(dataDir, { cwd: dir, session_id: "A" }), "A unchanged");

  git(dir, "checkout", "-q", "-b", "feat/auth");
  const a = injection(run(dataDir, { cwd: dir, session_id: "A" }), "A after branch change");
  assert(a.includes("feat/auth"), "A should be told");
  // B has not had a turn since the change, so it is still owed the note.
  const b = injection(run(dataDir, { cwd: dir, session_id: "B" }), "B after branch change");
  assert(b.includes("feat/auth"), "B should be told independently of A");
});

check("two projects do not share state", () => {
  const dataDir = freshDataDir();
  const one = initRepo();
  const two = initRepo();
  run(dataDir, { cwd: one, session_id: "s1" });
  // Same session id, different project: the second project has no baseline of
  // its own yet, so it must stay quiet rather than diff against the first.
  assertSilent(run(dataDir, { cwd: two, session_id: "s1" }), "second project");
});

check("a missing session id degrades to a single shared bucket instead of failing", () => {
  const dataDir = freshDataDir();
  const dir = initRepo();
  assertSilent(run(dataDir, { cwd: dir }), "no session id, first prompt");
  git(dir, "checkout", "-q", "-b", "feat/auth");
  const text = injection(run(dataDir, { cwd: dir }), "no session id, after change");
  assert(text.includes("feat/auth"), "one session still works without an id");
});

// ============================================================ degrading

check("a project that is not a git repository is silent", () => {
  assertSilent(run(freshDataDir(), { cwd: freshProjectDir(), session_id: "s1" }), "not a repo");
});

check("git missing from PATH is silent", () => {
  const dir = initRepo();
  // Keep the rest of the environment: on Windows, stripping SystemRoot breaks
  // Node itself, which would make this test pass for the wrong reason.
  const res = run(freshDataDir(), { cwd: dir, session_id: "s1" }, { PATH: "", Path: "" });
  assertSilent(res, "no git on PATH");
});

check("an unwritable data directory costs the note, not the session", () => {
  const dir = initRepo();
  // A *file* where the data directory should be: both the read and the
  // mkdir/rename fail, which is the worst case.
  const blocked = join(freshDataDir(), "not-a-directory");
  writeFileSync(blocked, "occupied\n", "utf8");
  assertSilent(run(blocked, { cwd: dir, session_id: "s1" }), "data dir is a file");
});

check("a truncated or invalid state file is treated as no baseline and overwritten", () => {
  const dataDir = freshDataDir();
  const dir = initRepo();
  const path = statePathFor(resolveDataDir(dataDir), dir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{"schema":1,"sessions":{"s1":{"fing', "utf8");

  // No usable baseline, so nothing to report — and the garbage must not survive.
  assertSilent(run(dataDir, { cwd: dir, session_id: "s1" }), "corrupt state");
  const stored = storedFingerprint(dataDir, dir, "s1");
  assert(stored, "the corrupt file should have been replaced with a real baseline");
  assertEqual(stored.branch, "main", "stored branch after recovery");
});

check("empty or malformed stdin is silent, not a crash", () => {
  const dataDir = freshDataDir();
  for (const body of ["", "   ", "not json", "[]", "null", '{"cwd":42}', "\u0000"]) {
    const res = spawnSync(process.execPath, [SCRIPT, dataDir], {
      input: body,
      cwd: freshProjectDir(),
      encoding: "utf8",
      windowsHide: true,
    });
    assertSilent(res, `stdin ${JSON.stringify(body)}`);
  }
});

check("a payload naming a directory that does not exist is silent", () => {
  // Claude Code always spawns the hook somewhere real, but the cwd it reports in
  // the payload can name a directory that has since been deleted. Spawn from a
  // live directory so this exercises the plugin rather than spawnSync itself.
  const dataDir = freshDataDir();
  const res = spawnSync(process.execPath, [SCRIPT, dataDir], {
    input: JSON.stringify({ cwd: join(freshProjectDir(), "gone"), session_id: "s1" }),
    cwd: freshProjectDir(),
    encoding: "utf8",
    windowsHide: true,
  });
  assertSilent(res, "payload cwd points at a deleted directory");
});

check("the note is emitted even when the fingerprint cannot be persisted", () => {
  // Criterion: a hook killed for exceeding its timeout has its output
  // discarded, so the fingerprint must not advance before the bytes are out.
  // The kill *timing* is not deterministically testable; what is testable is
  // the invariant it protects — a failed write must still let the note through
  // and must leave the baseline unadvanced, so the next prompt says it again.
  const dataDir = freshDataDir();
  const dir = initRepo();
  run(dataDir, { cwd: dir, session_id: "s1" });

  const path = statePathFor(resolveDataDir(dataDir), dir);

  // Making the write fail is platform-specific, and assuming otherwise is how
  // this passed on Windows and failed on Linux CI. The write is
  // `writeFileSync(tmp)` then `renameSync(tmp, path)`; `rename(2)` never
  // consults the target file's mode, only write+execute on the containing
  // directory. So a read-only *file* blocks it on Windows only, and a read-only
  // *directory* blocks it (at temp creation) on POSIX only, because Windows
  // ignores directory modes. Apply both and let each platform use the one that
  // bites. Both leave reads working, which the test needs: 0o555 keeps r and x
  // on the directory, 0o444 keeps r on the file.
  const stateDir = dirname(path);
  chmodSync(path, 0o444);
  chmodSync(stateDir, 0o555);

  // If a future platform (or running as root) blocks neither, the write
  // succeeds and the baseline assertion below fails loudly. That is the
  // intended failure mode — this must never pass vacuously.
  try {
    git(dir, "checkout", "-q", "-b", "feat/auth");
    const text = injection(run(dataDir, { cwd: dir, session_id: "s1" }), "unwritable state");
    assert(text.includes("feat/auth"), "the note must still be emitted");

    const stored = storedFingerprint(dataDir, dir, "s1");
    assertEqual(stored?.branch, "main", "the baseline must not have advanced");

    const leftovers = readdirSync(dirname(path)).filter((f) => f.includes(".tmp-"));
    assertEqual(leftovers.length, 0, `failed write left temp files: ${leftovers.join(", ")}`);

    // Because the baseline did not advance, the drift is still owed and is
    // reported again rather than lost.
    const again = injection(run(dataDir, { cwd: dir, session_id: "s1" }), "repeat after failure");
    assert(again.includes("feat/auth"), "an undelivered note must not be swallowed");
  } finally {
    // Directory first: the file chmod needs the directory traversable, and the
    // suite's own cleanup needs it writable again.
    chmodSync(stateDir, 0o755);
    chmodSync(path, 0o666);
  }
});

// ============================================================ hygiene

cleanupTempDirs();

check("the suite leaves no temp directories behind", () => {
  const leaked = TEMP_DIRS.filter((d) => existsSync(d));
  assertEqual(leaked.length, 0, `leaked: ${leaked.join(", ")}`);
});

// ============================================================ report

for (const f of failures) console.error(`FAIL  ${f}`);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
