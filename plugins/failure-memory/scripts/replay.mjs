#!/usr/bin/env node
// SessionStart hook: surface repeated failures from this project's ledger.
//
// Emits nothing at all when there is nothing worth saying -- an empty
// additionalContext is worse than no key, because it still costs the model
// attention. Exits 0 unconditionally.

import {
  ledgerPathFor,
  readLedger,
  renderContext,
  resolveDataDir,
  selectForReplay,
} from "./lib.mjs";

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

async function main() {
  const raw = await readStdin();

  let payload = {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") payload = parsed;
  } catch {
    // Fall through with an empty payload; cwd below still resolves.
  }

  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  const dataDir = resolveDataDir(process.argv[2]);
  const ledger = readLedger(ledgerPathFor(dataDir, cwd), cwd);

  const context = renderContext(selectForReplay(ledger.entries, Date.now()));
  if (!context) return;

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
    })}\n`,
  );
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
