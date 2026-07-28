// Shared helpers for failure-memory.
//
// Everything here is pure Node with zero dependencies. Nothing in this file
// performs network I/O.

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
import { dirname, join } from "node:path";

export const SCHEMA = 1;

// Hard caps. See README "Limits".
export const MAX_ENTRIES = 200; // per project ledger
export const MAX_EXCERPT = 300; // chars of error text retained
export const MAX_SIGNATURE = 200; // chars of normalized signature retained
export const RENDER_BUDGET = 2000; // chars of injected context (hook cap is 10000)
export const MIN_COUNT = 2; // a failure must repeat before it is worth replaying
export const RECENT_DAYS = 30; // replay window
export const EXPIRE_DAYS = 90; // entries older than this are dropped on write

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

// Order is load-bearing. Rules that match a recognizable *prefix plus its
// value* must run before the generic hex/base64 rules, otherwise a generic
// rule eats the value and leaves the prefix behind -- e.g. "ghp_aaaa..." would
// become "ghp_<hex>", which still leaks the fact and shape of the credential.
const REDACTIONS = [
  // KEY=..., TOKEN=..., SECRET=..., PASSWORD=..., AUTH=... (env-var style)
  [
    /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|AUTH))\s*=\s*\S+/gi,
    "$1=<redacted>",
  ],
  // Authorization headers, in either -H "..." or raw form. The optional
  // `\S+[ \t]+` swallows a scheme token ("Bearer", "Basic") *together with* the
  // credential after it. Matching only the next \S+ would consume the scheme
  // and leave the credential sitting there with nothing left to match it.
  [/\b(authorization)\s*:\s*(?:\S+[ \t]+)?\S+/gi, "$1: <redacted>"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, "$1 <redacted>"],
  // Known credential prefixes, prefix included in the match so nothing leaks.
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "<redacted-key>"],
  [/\bgh[pousr]_[A-Za-z0-9_]{8,}/g, "<redacted-key>"],
  [/\bgithub_pat_[A-Za-z0-9_]{8,}/g, "<redacted-key>"],
  [/\bAKIA[0-9A-Z]{8,}/g, "<redacted-key>"],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, "<redacted-key>"],
  [/\bAIza[A-Za-z0-9_-]{8,}/g, "<redacted-key>"],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, "<redacted-jwt>"],
  // Long opaque blobs last: anything still this long and this dense is not
  // something we want on disk.
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "<redacted-blob>"],
];

/** Strip anything that looks like a credential. Always returns a string. */
export function redact(input) {
  let out = typeof input === "string" ? input : String(input ?? "");
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Collapse the parts of a string that vary run to run so that the same failure
 * lands on the same ledger entry. Redaction runs first.
 */
export function normalizeText(input) {
  let s = redact(input);
  // Absolute paths, Windows and POSIX.
  s = s.replace(/\b[A-Za-z]:[\\/][^\s"']*/g, "<path>");
  s = s.replace(/(^|[\s"'=(])\/[^\s"')]{2,}/g, "$1<path>");
  // Hex runs before bare integers, so a sha does not become <n><n><n>.
  s = s.replace(/\b[0-9a-f]{7,}\b/gi, "<hex>");
  s = s.replace(/\b\d+\b/g, "<n>");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Cut a shell command at the first bare `--`. Everything after it is operands
 * handed to a subprocess, i.e. the part that varies between otherwise
 * identical invocations. This is what makes `npm test -- foo` and
 * `npm test -- bar` collapse onto one entry while keeping `npm run build`
 * distinct from `npm run test`.
 */
export function dropOperands(command) {
  const m = /\s--(\s|$)/.exec(command);
  return m ? command.slice(0, m.index) : command;
}

/** A coarse class for an error string, used to key non-Bash tools. */
export function errorClass(error) {
  const e = String(error ?? "").toLowerCase();
  if (!e) return "unknown";
  if (e.includes("string to replace not found") || e.includes("no match")) return "no-match";
  if (e.includes("not unique") || e.includes("multiple matches")) return "ambiguous-match";
  if (e.includes("has not been read") || e.includes("read the file")) return "unread-file";
  if (e.includes("permission")) return "permission";
  if (e.includes("enoent") || e.includes("no such file")) return "missing-file";
  if (e.includes("timed out") || e.includes("timeout")) return "timeout";
  if (e.includes("non-zero status") || e.includes("exit code")) return "nonzero-exit";
  return "error";
}

function extensionOf(path) {
  const base = String(path ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
}

/**
 * Build the ledger key for a failure. Returns a trimmed, redacted string.
 */
export function signatureFor(toolName, toolInput, error) {
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  let sig;

  if (toolName === "Bash") {
    sig = normalizeText(dropOperands(String(input.command ?? "")));
    if (!sig) sig = "(empty command)";
  } else if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
    const ext = extensionOf(input.file_path ?? input.notebook_path ?? "");
    sig = `*${ext || "(no ext)"} ${errorClass(error)}`;
  } else if (toolName === "Task") {
    sig = `${String(input.subagent_type ?? "unknown")} ${errorClass(error)}`;
  } else {
    const keys = Object.keys(input).sort().join(",");
    sig = `${keys || "(no input)"} ${errorClass(error)}`;
  }

  return sig.slice(0, MAX_SIGNATURE);
}

/** Redact and clamp an error string for storage. */
export function excerptFor(error) {
  return redact(String(error ?? "")).replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT);
}

// ---------------------------------------------------------------------------
// Storage locations
// ---------------------------------------------------------------------------

/**
 * Resolve the directory the ledger lives in.
 *
 * Preference order: explicit argv, then CLAUDE_PLUGIN_DATA, then a computed
 * default under the home directory. A value containing "${" is an unexpanded
 * placeholder and is rejected -- otherwise a literal directory named
 * "${CLAUDE_PLUGIN_DATA}" gets created and capture silently goes nowhere.
 */
export function resolveDataDir(argvValue) {
  const candidates = [argvValue, process.env.CLAUDE_PLUGIN_DATA];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() && !c.includes("${")) return c.trim();
  }
  return join(homedir(), ".claude", "plugins", "data", "failure-memory");
}

/**
 * Ledger path for a project. The filename is a hash of cwd so the path itself
 * leaks nothing; the plain cwd is stored inside the file for debuggability.
 */
export function ledgerPathFor(dataDir, cwd) {
  const id = createHash("sha256").update(String(cwd ?? "")).digest("hex").slice(0, 16);
  return join(dataDir, "ledger", `${id}.json`);
}

function emptyLedger(cwd) {
  return { cwd: String(cwd ?? ""), schema: SCHEMA, entries: [] };
}

/**
 * Read a ledger. A missing file yields an empty ledger. A corrupt or foreign
 * one is moved aside (best effort) and also yields an empty ledger, so a bad
 * file cannot wedge capture forever.
 */
export function readLedger(path, cwd) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return emptyLedger(cwd);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    quarantine(path);
    return emptyLedger(cwd);
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries) || parsed.schema !== SCHEMA) {
    quarantine(path);
    return emptyLedger(cwd);
  }

  return {
    cwd: typeof parsed.cwd === "string" && parsed.cwd ? parsed.cwd : String(cwd ?? ""),
    schema: SCHEMA,
    entries: parsed.entries.filter(
      (e) => e && typeof e === "object" && typeof e.signature === "string",
    ),
  };
}

function quarantine(path) {
  try {
    renameSync(path, `${path}.corrupt`);
  } catch {
    try {
      rmSync(path, { force: true });
    } catch {
      /* nothing else to try */
    }
  }
}

/** Write via a temp file and rename, so a concurrent reader never sees a partial file. */
export function writeLedgerAtomic(path, ledger) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

/** Block the current thread without spinning the CPU and without dependencies. */
export function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* busy wait fallback */
    }
  }
}

/**
 * Run `fn` while holding a directory lock next to `path`.
 *
 * On sustained contention the observation is DROPPED rather than blocking the
 * session. Losing one duplicate failure record is strictly better than making
 * a tool call feel slow.
 */
export function withLock(path, fn, options = {}) {
  const { attempts = 20, waitMs = 25, staleMs = 5000 } = options;
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });

  for (let i = 0; i < attempts; i += 1) {
    try {
      mkdirSync(lock);
      try {
        return fn();
      } finally {
        try {
          rmSync(lock, { recursive: true, force: true });
        } catch {
          /* leave it; the stale check below will reclaim it */
        }
      }
    } catch (err) {
      if (err && err.code !== "EEXIST") return undefined;
      // Break a lock left behind by a killed process.
      try {
        const age = Date.now() - statSync(lock).mtimeMs;
        if (age > staleMs) rmSync(lock, { recursive: true, force: true });
      } catch {
        /* the lock vanished; loop and retry */
      }
      sleepSync(waitMs);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Entry maintenance
// ---------------------------------------------------------------------------

/**
 * Fold one observation into the entry list, in place semantics aside.
 * Returns a new array. `now` is an ISO string.
 */
export function recordEntry(entries, { tool, signature, error_excerpt }, now) {
  const list = entries.slice();
  const found = list.find((e) => e.signature === signature && e.tool === tool);
  if (found) {
    found.count = Number.isFinite(found.count) ? found.count + 1 : 2;
    found.last_seen = now;
    found.error_excerpt = error_excerpt;
    return list;
  }
  list.push({
    tool,
    signature,
    error_excerpt,
    count: 1,
    first_seen: now,
    last_seen: now,
  });
  return list;
}

function ageDays(iso, now) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Infinity;
  return (now - t) / 86_400_000;
}

/**
 * Drop expired entries and cap the list. Eviction removes the least useful
 * first: lowest count, then oldest last_seen.
 */
export function pruneEntries(entries, nowMs = Date.now()) {
  let list = entries.filter((e) => ageDays(e.last_seen, nowMs) <= EXPIRE_DAYS);
  if (list.length <= MAX_ENTRIES) return list;
  list = list.slice().sort((a, b) => {
    const ca = Number(a.count) || 0;
    const cb = Number(b.count) || 0;
    if (ca !== cb) return cb - ca; // keep higher counts
    return Date.parse(b.last_seen || 0) - Date.parse(a.last_seen || 0);
  });
  return list.slice(0, MAX_ENTRIES);
}

/** Entries worth replaying: repeated, and seen recently. */
export function selectForReplay(entries, nowMs = Date.now()) {
  return entries
    .filter((e) => (Number(e.count) || 0) >= MIN_COUNT)
    .filter((e) => ageDays(e.last_seen, nowMs) <= RECENT_DAYS)
    .sort((a, b) => {
      const ca = Number(a.count) || 0;
      const cb = Number(b.count) || 0;
      if (ca !== cb) return cb - ca;
      return Date.parse(b.last_seen || 0) - Date.parse(a.last_seen || 0);
    });
}

/**
 * Render selected entries as plain text, worst first, truncating
 * deterministically so the result never exceeds RENDER_BUDGET characters.
 * Returns "" when there is nothing to say.
 */
export function renderContext(selected) {
  if (selected.length === 0) return "";

  const header =
    "Recurring tool failures in this project (from failure-memory, local only). " +
    "Consider these before repeating the same approach:";
  const lines = [];
  let used = header.length;

  for (const e of selected) {
    const line = `- ${e.tool}: ${e.signature} (failed ${e.count}x, last ${String(e.last_seen).slice(0, 10)}) -- ${e.error_excerpt}`;
    const clipped = line.length > 240 ? `${line.slice(0, 237)}...` : line;
    if (used + clipped.length + 1 > RENDER_BUDGET) break;
    lines.push(clipped);
    used += clipped.length + 1;
  }

  if (lines.length === 0) return "";
  return `${header}\n${lines.join("\n")}`;
}
