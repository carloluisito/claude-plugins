#!/usr/bin/env node
// PostToolUseFailure hook: fold one failed tool call into the project ledger.
//
// This process exits 0 no matter what happens. PostToolUseFailure is not one
// of the events where exit code 2 is meaningful, but an unhandled throw would
// still put noise in the user's session for no benefit. A dropped observation
// is always the right trade against a disrupted session.

import {
  excerptFor,
  ledgerPathFor,
  pruneEntries,
  readLedger,
  recordEntry,
  resolveDataDir,
  signatureFor,
  writeLedgerAtomic,
  withLock,
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

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // malformed stdin: write nothing, say nothing
  }
  if (!payload || typeof payload !== "object") return;

  // A user pressing escape is not a failure worth remembering.
  if (payload.is_interrupt === true) return;

  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  if (!toolName) return;

  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  const dataDir = resolveDataDir(process.argv[2]);
  const path = ledgerPathFor(dataDir, cwd);

  const signature = signatureFor(toolName, payload.tool_input, payload.error);
  const error_excerpt = excerptFor(payload.error);
  const now = new Date().toISOString();

  withLock(path, () => {
    const ledger = readLedger(path, cwd);
    ledger.entries = pruneEntries(
      recordEntry(ledger.entries, { tool: toolName, signature, error_excerpt }, now),
      Date.now(),
    );
    writeLedgerAtomic(path, ledger);
  });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
