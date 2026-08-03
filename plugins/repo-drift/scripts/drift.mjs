#!/usr/bin/env node
// UserPromptSubmit hook: tell the model when the repository moved under it.
//
// Runs before every prompt the user submits, so it is deliberately cheap and
// deliberately silent. Any failure — no git, no repo, unwritable state, garbage
// on stdin — exits 0 with empty stdout. A hook that breaks a session is worse
// than a hook that says nothing.

import {
  describeDrift,
  fingerprintOf,
  readState,
  recordFingerprint,
  resolveDataDir,
  statePathFor,
} from "./lib.mjs";

// Claude Code writes the hook payload to stdin and closes it. If that close
// never arrives, proceed with what we have rather than hanging the prompt.
const STDIN_TIMEOUT_MS = 2000;

function readStdin() {
  return new Promise((resolve) => {
    let done = false;
    let data = "";
    const finish = () => {
      if (!done) {
        done = true;
        resolve(data);
      }
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    timer.unref?.();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      finish();
    });
  });
}

// Resolve when the bytes have actually left this process. The ordering below
// depends on it: `write` returning true only means the string was accepted, not
// that it was flushed.
function writeOut(text) {
  return new Promise((resolve) => {
    try {
      process.stdout.write(text, () => resolve());
    } catch {
      resolve();
    }
  });
}

async function main() {
  const raw = await readStdin();

  let payload = {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed;
  } catch {
    /* Fall through with an empty payload; cwd below still resolves. */
  }

  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();

  // Without a session id there is no way to tell this session's previous turn
  // from another session's, and a shared key would make two sessions cancel
  // each other's notes. One fixed bucket is the honest answer: a single
  // session still works, concurrent ones just degrade to no notes.
  const sessionId =
    typeof payload.session_id === "string" && payload.session_id ? payload.session_id : "unknown";

  const next = fingerprintOf(cwd);
  // Not a repository, git missing, or a repo with no commits yet. Nothing to
  // compare and nothing to store.
  if (!next) return;

  const path = statePathFor(resolveDataDir(process.argv[2]), cwd);
  const prev = readState(path, cwd).sessions[sessionId]?.fingerprint ?? null;

  const context = describeDrift(prev, next);

  // Emit before persisting, and only consider the turn recorded once the bytes
  // are out. If this process is killed for exceeding its timeout, Claude Code
  // discards the output — leaving the stored fingerprint unadvanced means the
  // next prompt sees the same drift and says it again. Advancing first would
  // swallow it permanently and the model would keep reasoning from a stale tree.
  if (context) {
    await writeOut(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: context,
        },
      })}\n`,
    );
  }

  try {
    recordFingerprint(path, cwd, sessionId, next, Date.now());
  } catch {
    // An unwritable data directory costs future notes, not this one. Staying
    // quiet here is what keeps a read-only home directory from turning into a
    // visible error on every prompt.
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
