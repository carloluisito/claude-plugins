#!/usr/bin/env node
// Measures what the hook costs the interactive path.
//
// Not run by CI: it builds a repository with tens of thousands of tracked files,
// which is fine on a workstation and rude on a shared runner. Run it by hand
// when the fingerprinting changes:
//
//   node plugins/repo-drift/tests/bench.mjs
//
// The number that matters is the median of the whole hook process — spawn,
// stdin, git, state write, exit — because that is the delay a user feels before
// their prompt is answered. The claim being checked is that it does not grow
// with the size of the worktree, which is why `git status` is not used.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(resolve(HERE, ".."), "scripts", "drift.mjs");

const RUNS = 20;
const BIG_FILES = 30000;
const FILES_PER_DIR = 200;

function git(dir, ...args) {
  const r = spawnSync(
    "git",
    [
      "-c",
      "user.email=bench@example.com",
      "-c",
      "user.name=repo-drift bench",
      // Staging 30k LF files on Windows otherwise emits 30k line-ending warnings,
      // which overruns spawnSync's default 1 MB stderr buffer and kills the child.
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    { cwd: dir, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return (r.stdout ?? "").trim();
}

function newRepo() {
  const dir = mkdtempSync(join(tmpdir(), "repo-drift-bench-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n", "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "one");
  return dir;
}

function fatten(dir, count) {
  for (let i = 0; i < count; i += 1) {
    const sub = join(dir, "src", String(Math.floor(i / FILES_PER_DIR)));
    if (i % FILES_PER_DIR === 0) mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, `f${i}.txt`), `line ${i}\n`, "utf8");
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `${count} files`);
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function timeHook(dir, dataDir) {
  const samples = [];
  for (let i = 0; i < RUNS; i += 1) {
    const t0 = process.hrtime.bigint();
    spawnSync(process.execPath, [SCRIPT, dataDir], {
      input: JSON.stringify({ cwd: dir, session_id: "bench" }),
      cwd: dir,
      encoding: "utf8",
      windowsHide: true,
    });
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return samples;
}

function report(label, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  console.log(
    `${label.padEnd(28)} median ${median(samples).toFixed(1)} ms   ` +
      `min ${sorted[0].toFixed(1)}   max ${sorted[sorted.length - 1].toFixed(1)}`,
  );
}

const dirs = [];
try {
  const small = newRepo();
  dirs.push(small);
  const smallData = mkdtempSync(join(tmpdir(), "repo-drift-bench-data-"));
  dirs.push(smallData);
  // Warm the caches so the first sample is not measuring page faults.
  timeHook(small, smallData);
  report("small repo (1 file)", timeHook(small, smallData));

  const big = newRepo();
  dirs.push(big);
  process.stdout.write(`building a ${BIG_FILES}-file repository...\n`);
  fatten(big, BIG_FILES);
  const bigData = mkdtempSync(join(tmpdir(), "repo-drift-bench-data-"));
  dirs.push(bigData);
  timeHook(big, bigData);
  report(`big repo (${BIG_FILES} files)`, timeHook(big, bigData));

  // For contrast, what the rejected implementation would have cost.
  const t0 = process.hrtime.bigint();
  git(big, "status", "--porcelain");
  console.log(
    `\nfor comparison, one \`git status --porcelain\` in the big repo: ` +
      `${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1)} ms`,
  );
} finally {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* A leftover temp directory is not worth failing the benchmark over. */
    }
  }
}
