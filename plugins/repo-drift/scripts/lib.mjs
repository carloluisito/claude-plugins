// Shared helpers for repo-drift.
//
// Everything here is pure Node with no dependencies. The hook that uses it runs
// on the interactive path — every prompt the user submits waits on it — so the
// cost of each function is part of its contract, not an implementation detail.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const SCHEMA = 1;

// A fingerprint is only meaningful for the life of a session. Anything a week
// stale belongs to a session that will never submit another prompt.
export const PRUNE_DAYS = 7;

// A hard ceiling in case a single project somehow accumulates sessions faster
// than PRUNE_DAYS retires them. Oldest go first.
export const MAX_SESSIONS = 100;

// Branch names have no length limit. Truncate so one absurd ref cannot blow the
// injection budget.
export const MAX_REF = 40;

// The injection is competing with the user's own prompt for the model's
// attention. Short is the point, not a limitation.
export const RENDER_BUDGET = 380;

// git here is a single O(1) plumbing call. If it has not answered in two
// seconds something is badly wrong with the environment and staying silent
// beats making the user wait.
export const GIT_TIMEOUT_MS = 2000;

const HEADER = "Repository state changed since your previous turn in this session:";
const FOOTER = "Files read earlier in this session may no longer match what is on disk.";

// ------------------------------------------------------------------ data dir

export function resolveDataDir(argvValue) {
  const candidates = [argvValue, process.env.CLAUDE_PLUGIN_DATA];
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const v = c.trim();
    if (!v) continue;
    // An unexpanded placeholder would otherwise create a literal
    // "${CLAUDE_PLUGIN_DATA}" directory and state would silently go nowhere.
    if (v.includes("${")) continue;
    return v;
  }
  return join(homedir(), ".claude", "plugins", "data", "repo-drift");
}

// The path is a hash so it leaks nothing about the user's directory layout. The
// plain project path is stored inside the file, where it is only useful to
// somebody who can already read the file.
export function statePathFor(dataDir, cwd) {
  const key = createHash("sha256").update(String(cwd)).digest("hex").slice(0, 16);
  return join(dataDir, `${key}.json`);
}

// ---------------------------------------------------------------- fingerprint

function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

// Which multi-step git operation, if any, is mid-flight. This matters because a
// conflicted merge or a paused rebase does not move HEAD, so without it the
// most disruptive state changes are the ones this plugin would miss.
//
// `gitDir` must come from git itself: in a linked worktree the per-worktree
// MERGE_HEAD lives under .git/worktrees/<name>/, not in the .git of the
// checkout, and in that layout .git is a file rather than a directory.
function opsIn(gitDir) {
  const ops = [];
  if (exists(join(gitDir, "MERGE_HEAD"))) ops.push("merge");
  if (exists(join(gitDir, "CHERRY_PICK_HEAD"))) ops.push("cherry-pick");
  if (exists(join(gitDir, "rebase-merge")) || exists(join(gitDir, "rebase-apply"))) {
    ops.push("rebase");
  }
  return ops;
}

/**
 * A cheap, complete-enough description of where the repository is standing.
 *
 * Cost is independent of worktree size: one `git rev-parse` (which reads refs,
 * not files) plus four stat calls. `git status` would be correct and is
 * deliberately not used — it walks the worktree, and this runs before every
 * prompt.
 *
 * Returns null when there is nothing to fingerprint: not a repository, git not
 * installed, a repository with no commits yet. Callers treat null as "say
 * nothing", never as an error.
 */
export function fingerprintOf(cwd) {
  let r;
  try {
    // Argument order is load-bearing. `--abbrev-ref` is sticky: it applies to
    // every rev after it, so `--abbrev-ref HEAD HEAD` prints the branch twice.
    // Asking for the sha before the flag is what gets both values from one call.
    r = spawnSync("git", ["rev-parse", "--git-dir", "HEAD", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    return null;
  }
  if (!r || r.error || r.status !== 0 || typeof r.stdout !== "string") return null;

  const lines = r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 3) return null;

  const [gitDir, head, branch] = lines;
  if (!/^[0-9a-f]{40,64}$/.test(head)) return null;
  if (!branch) return null;

  // --git-dir answers relatively (".git") in a normal checkout and absolutely
  // in a linked worktree.
  return { head, branch, ops: opsIn(resolve(cwd, gitDir)) };
}

export function sameFingerprint(a, b) {
  if (!a || !b) return false;
  return a.head === b.head && a.branch === b.branch && a.ops.join(",") === b.ops.join(",");
}

// ---------------------------------------------------------------- rendering

function clampRef(value) {
  const v = String(value ?? "");
  // git says "HEAD" for a detached head, which reads as a ref name rather than
  // a state. Name the state.
  if (v === "HEAD") return "detached HEAD";
  return v.length > MAX_REF ? `${v.slice(0, MAX_REF - 1)}…` : v;
}

function shortSha(value) {
  return String(value ?? "").slice(0, 7);
}

/**
 * What to tell the model, or "" when there is nothing to tell it.
 *
 * Deliberately a statement of fact with no instruction in it. The model gets
 * this without the user seeing it; an observation it can weigh costs nothing
 * when it is irrelevant, whereas an instruction steers the turn with nothing on
 * screen to explain why.
 */
export function describeDrift(prev, next) {
  if (!prev || !next) return "";

  const lines = [];
  if (prev.branch !== next.branch) {
    lines.push(`  branch: ${clampRef(prev.branch)} -> ${clampRef(next.branch)}`);
  }
  if (prev.head !== next.head) {
    lines.push(`  HEAD: ${shortSha(prev.head)} -> ${shortSha(next.head)}`);
  }
  const before = (prev.ops ?? []).join(", ");
  const after = (next.ops ?? []).join(", ");
  if (before !== after) {
    lines.push(
      after
        ? `  in progress: ${after}`
        : `  in progress: nothing (was ${before})`,
    );
  }
  if (lines.length === 0) return "";

  // Drop detail rather than emit a sentence cut in half. The header and footer
  // are what make the rest legible, so they are the last things to go.
  const kept = lines.slice();
  let out = [HEADER, ...kept, FOOTER].join("\n");
  while (out.length > RENDER_BUDGET && kept.length > 1) {
    kept.pop();
    out = [HEADER, ...kept, FOOTER].join("\n");
  }
  return out.length > RENDER_BUDGET ? `${out.slice(0, RENDER_BUDGET - 1)}…` : out;
}

// -------------------------------------------------------------------- state

export function emptyState(cwd) {
  return { schema: SCHEMA, project: String(cwd), sessions: {} };
}

function cleanEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fp = value.fingerprint;
  if (!fp || typeof fp !== "object" || Array.isArray(fp)) return null;
  if (typeof fp.head !== "string" || typeof fp.branch !== "string") return null;
  const ops = Array.isArray(fp.ops) ? fp.ops.filter((o) => typeof o === "string") : [];
  return {
    fingerprint: { head: fp.head, branch: fp.branch, ops },
    last_seen: typeof value.last_seen === "string" ? value.last_seen : new Date(0).toISOString(),
  };
}

/**
 * Read stored fingerprints for one project.
 *
 * Anything unreadable, unparseable, or the wrong shape reads as empty. This
 * state is disposable — losing it costs one missed note, so there is nothing
 * here worth quarantining or repairing, and the next write overwrites it.
 */
export function readState(path, cwd) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return emptyState(cwd);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyState(cwd);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyState(cwd);
  if (parsed.schema !== SCHEMA) return emptyState(cwd);
  if (!parsed.sessions || typeof parsed.sessions !== "object" || Array.isArray(parsed.sessions)) {
    return emptyState(cwd);
  }

  const sessions = {};
  for (const [id, value] of Object.entries(parsed.sessions)) {
    const entry = cleanEntry(value);
    if (entry) sessions[id] = entry;
  }
  return { schema: SCHEMA, project: String(cwd), sessions };
}

function ageMs(lastSeen, nowMs) {
  const t = Date.parse(lastSeen);
  // An unparseable timestamp is treated as ancient: it cannot be shown to be
  // current, and keeping it forever is how a cap gets defeated.
  return Number.isFinite(t) ? nowMs - t : Number.POSITIVE_INFINITY;
}

export function pruneSessions(sessions, nowMs) {
  const cutoff = PRUNE_DAYS * 24 * 60 * 60 * 1000;
  const live = Object.entries(sessions).filter(([, v]) => ageMs(v.last_seen, nowMs) <= cutoff);
  live.sort((a, b) => ageMs(a[1].last_seen, nowMs) - ageMs(b[1].last_seen, nowMs));
  return Object.fromEntries(live.slice(0, MAX_SESSIONS));
}

/**
 * Replace the state file in one step.
 *
 * A reader either sees the previous file or the new one, never a half-written
 * one, because rename is atomic and the partial content only ever exists under
 * a temporary name. Throws on failure; callers decide whether that matters
 * (in the hook, it does not).
 */
export function writeStateAtomic(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (e) {
    // A tmp file left behind would accumulate silently on every failed write.
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* Nothing further to try. */
    }
    throw e;
  }
}

/**
 * Record this session's fingerprint, keeping other sessions' entries.
 *
 * Re-reads immediately before writing so that a concurrent prompt in another
 * session of the same project is merged rather than clobbered. The window is
 * not zero — two prompts landing within the same handful of microseconds can
 * still drop one entry — but the cost of losing one is a single missed note in
 * one session, which is not worth putting a lock on the interactive path for.
 */
export function recordFingerprint(path, cwd, sessionId, fingerprint, nowMs) {
  const state = readState(path, cwd);
  state.sessions[sessionId] = {
    fingerprint,
    last_seen: new Date(nowMs).toISOString(),
  };
  state.sessions = pruneSessions(state.sessions, nowMs);
  writeStateAtomic(path, state);
  return state;
}
