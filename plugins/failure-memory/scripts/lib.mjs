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

// Bumped to 2 when signatures gained pipeline-stage cutting and flag-order
// collapsing. Those change what key a command produces, so a schema-1 ledger is
// read as empty rather than merged -- see readLedger.
export const SCHEMA = 2;

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

/**
 * Walk a command left to right, tracking quote state.
 *
 * Returns `{ cut, open }` where `cut` is the index of the first unquoted
 * pipeline/list separator (or -1) and `open` is true if a quote was still open
 * at the end of the string. A backslash outside single quotes escapes the next
 * character; that only ever *prevents* a cut, which is the safe direction.
 *
 * Every branch is a plain character comparison, so this cannot throw on any
 * input.
 */
function scanCommand(command) {
  const s = String(command ?? "");
  let quote = ""; // "" | "'" | '"'
  let cut = -1;

  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];

    if (quote === "'") {
      if (c === "'") quote = "";
      continue;
    }

    if (c === "\\") {
      i += 1; // skip the escaped character
      continue;
    }

    if (quote === '"') {
      if (c === '"') quote = "";
      continue;
    }

    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }

    if (cut === -1 && (c === "|" || c === ";" || (c === "&" && s[i + 1] === "&"))) {
      cut = i;
    }
  }

  return { cut, open: quote !== "" };
}

/**
 * Keep only the first stage of a pipeline or command list.
 *
 * `npm test | tee out.log`, `npm test && npm run lint` and `make build; make
 * test` all record against the command that actually failed first, so they
 * collapse onto the same entry as the bare command. Separators inside quotes are
 * left alone, so `echo "a && b"` stays distinct from `echo "a"`.
 *
 * If a quote is still open at the end of the string the command is malformed and
 * no cut is made at all: guessing where the quote was meant to close is how you
 * merge two unrelated failures.
 */
export function firstStage(command) {
  const s = String(command ?? "");
  const { cut, open } = scanCommand(s);
  if (open || cut === -1) return s;
  return s.slice(0, cut);
}

/**
 * Split a command on whitespace that is not inside quotes. Quoted runs stay in
 * the token that contains them, quotes included, so `echo "a b"` is two tokens
 * and not three.
 */
export function tokenize(command) {
  const s = String(command ?? "");
  const tokens = [];
  let current = "";
  let quote = "";

  const flush = () => {
    if (current) tokens.push(current);
    current = "";
  };

  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];

    if (quote === "'") {
      current += c;
      if (c === "'") quote = "";
      continue;
    }

    if (c === "\\") {
      current += c;
      if (i + 1 < s.length) {
        current += s[i + 1];
        i += 1;
      }
      continue;
    }

    if (quote === '"') {
      current += c;
      if (c === '"') quote = "";
      continue;
    }

    if (c === "'" || c === '"') {
      quote = c;
      current += c;
      continue;
    }

    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      flush();
      continue;
    }

    current += c;
  }

  flush();
  return tokens;
}

/**
 * Collapse flag order so `cargo build --release --locked` and
 * `cargo build --locked --release` land on one entry.
 *
 * The leading run of tokens that do not start with `-` is the command itself and
 * keeps its order. The tail is sorted **only if every token in it is a flag**.
 * That guard is the whole point: in `git commit -m one` the `one` is a flag's
 * value, and sorting it would merge two different commits into one entry. When
 * in doubt this leaves the tail exactly as written -- an untidy duplicate row is
 * recoverable, a wrongly merged row produces advice about a command the user
 * never ran.
 */
export function sortFlags(command) {
  const tokens = tokenize(command);
  let i = 0;
  while (i < tokens.length && !tokens[i].startsWith("-")) i += 1;

  const head = tokens.slice(0, i);
  const tail = tokens.slice(i);
  if (tail.length < 2 || !tail.every((t) => t.startsWith("-"))) {
    return tokens.join(" ");
  }

  return [...head, ...tail.slice().sort()].join(" ");
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
    sig = normalizeText(sortFlags(dropOperands(firstStage(String(input.command ?? "")))));
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

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
    quarantine(path);
    return emptyLedger(cwd);
  }

  // A ledger from another schema is not corrupt -- its entries are keyed by
  // rules this version no longer uses, so counts from it cannot be added to
  // counts from this version. Read it as empty and let the next write replace
  // it. Deliberately *not* quarantined: nothing here is broken, and a schema
  // higher than ours means a newer version of this plugin owns the file and
  // will want it intact.
  if (parsed.schema !== SCHEMA) return emptyLedger(cwd);

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
/**
 * Format a stored timestamp as YYYY-MM-DD, or "" if it is absent or
 * unparseable. Never yields "Invalid Date", "NaN" or "undefined": a date this
 * plugin cannot vouch for is a date it does not print.
 */
export function shortDate(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const ms = new Date(value ?? "").getTime();
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

export function renderContext(selected) {
  if (selected.length === 0) return "";

  // Deliberately a statement of fact, not an instruction. This text is injected
  // from a ledger that can be weeks stale, and the user never sees it. Stale
  // observations get weighed and discarded; a stale instruction steers the model
  // wrong with nothing on screen to explain why.
  const header =
    "Recorded by failure-memory (local only): tool calls that have failed more " +
    "than once in this project.";
  const lines = [];
  let used = header.length;

  for (const e of selected) {
    const first = shortDate(e.first_seen);
    const last = shortDate(e.last_seen);
    const dates = [first && `first ${first}`, last && `last ${last}`].filter(Boolean);
    const when = dates.length > 0 ? `, ${dates.join(", ")}` : "";
    const line = `- ${e.tool}: ${e.signature} (failed ${e.count}x${when}) -- ${e.error_excerpt}`;
    const clipped = line.length > 240 ? `${line.slice(0, 237)}...` : line;
    if (used + clipped.length + 1 > RENDER_BUDGET) break;
    lines.push(clipped);
    used += clipped.length + 1;
  }

  if (lines.length === 0) return "";
  return `${header}\n${lines.join("\n")}`;
}
