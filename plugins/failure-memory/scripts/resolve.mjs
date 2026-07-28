#!/usr/bin/env node
// PostToolUse hook: a tool call succeeded, so walk back the ledger count for it.
//
// PostToolUse fires ONLY after a successful tool call -- it carries no exit
// code, the event identity is the success signal. Failures arrive on the
// separate PostToolUseFailure event, which capture.mjs owns.
//
// Registered for Bash and nothing else, and that is forced rather than chosen.
// Bash is the only tool whose ledger key is derived from tool_input alone;
// every other branch of signatureFor() folds errorClass(error) into the key,
// and a success carries no error, so a success could never reconstruct a
// stored non-Bash key. See README, "What self-clears and what does not".
//
// This process exits 0 no matter what happens, never creates a ledger file,
// and never refreshes last_seen.

import { existsSync, readFileSync } from "node:fs";

import {
  SCHEMA,
  decrementEntry,
  ledgerPathFor,
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
  if (!raw) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object") return;
  if (payload.is_interrupt === true) return;

  // Defensive, not redundant: the matcher in hooks.json says Bash, but a user
  // may have copied the hook into their own settings with a wider matcher. A
  // non-Bash key cannot be reconstructed from a success, so attempting it could
  // only ever clear the wrong row.
  if (payload.tool_name !== "Bash") return;

  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  const path = ledgerPathFor(resolveDataDir(process.argv[2]), cwd);

  // A success must never bring a ledger into existence. No failures recorded
  // for this project means there is nothing here to walk back.
  if (!existsSync(path)) return;

  // The SAME exported signatureFor the capture path calls, with no error. Drift
  // between the two keying paths is the one silent failure mode of this hook:
  // counts would simply never go down, with nothing to see.
  const signature = signatureFor("Bash", payload.tool_input, undefined);

  withLock(path, () => {
    // Read inline rather than through readLedger(): readLedger quarantines a
    // corrupt ledger as a recovery step, and recovery belongs to the failure
    // path. A success is inert -- it either decrements or does nothing at all.
    let ledger;
    try {
      ledger = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return;
    }
    if (!ledger || typeof ledger !== "object") return;
    if (ledger.schema !== SCHEMA) return;

    const entries = decrementEntry(ledger.entries, { tool: "Bash", signature });
    if (entries === null) return; // nothing matched; leave the file untouched

    ledger.entries = entries;
    writeLedgerAtomic(path, ledger);
  });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
