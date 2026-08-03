# Changelog

All notable changes to this plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-04

### Added

- `UserPromptSubmit` hook that fingerprints the repository on every prompt — the
  `HEAD` commit, the branch name (or `detached HEAD`), and any merge,
  cherry-pick, or rebase in flight — and prepends a short note to the model's
  context when it differs from the previous turn in the same session.
- Per-session state, keyed on a truncated SHA-256 of the project path, with
  atomic writes, a re-read immediately before each write so concurrent sessions
  in one project do not clobber each other, corrupt-state recovery, a 7-day
  expiry, and a 100-session cap.
- `tests/bench.mjs`, a benchmark that is deliberately not run by CI because it
  builds a 30,000-file repository.

### Notes

- **Uncommitted edits are not reported, and that is the trade.** Answering "did
  a file change" needs `git status`, which walks the whole worktree, and this
  hook runs before every prompt you submit. The fingerprint is one
  `git rev-parse` and four `stat` calls, all O(1) in worktree size. Measured:
  173 ms median in a 1-file repository, 137 ms in a 30,000-file one — the same
  number within noise, and nearly all of it Node process startup. A single
  `git status --porcelain` in that larger repository costs 82 ms on top of the
  same startup and grows with the tree.
- **The note is emitted before the fingerprint is advanced.** A hook killed for
  exceeding its timeout has its output discarded by Claude Code, so advancing
  first would swallow a real change permanently and leave the model reasoning
  from a tree that moved. Emitting first means a failed delivery costs at worst
  a duplicate note on the next prompt.
- **`git rev-parse --abbrev-ref HEAD HEAD` does not print a sha and a branch.**
  `--abbrev-ref` is sticky, so it applies to every later revision too and the
  branch is printed twice. The working single-call form is
  `git rev-parse --git-dir HEAD --abbrev-ref HEAD`, which returns git-dir, sha,
  and branch in argument order; the order is load-bearing and is commented as
  such in `scripts/lib.mjs`.
- **In-progress operations are located via `--git-dir`, not `.git/`.** In a
  linked worktree `.git` is a file and that worktree's `MERGE_HEAD` and
  `rebase-merge` live under `<main>/.git/worktrees/<name>`, so hardcoding the
  path would have reported no operation in exactly the situation where one is
  most likely.
- **The note is phrased as an observation, never an instruction.** Injected
  context is invisible to you, and an instruction that steers a turn with
  nothing on screen to explain why is worse than no note at all.
- Changes Claude itself makes are reported as drift too. The hook sees the
  repository, not the reason, and inferring intent from tool history risks
  silently swallowing a real change.
- **Forcing the state write to fail, for the test that covers it, is
  platform-specific.** `rename(2)` never consults the target file's mode, only
  write+execute on the containing directory, so `chmod 0o444` on the state file
  blocks the write on Windows and does nothing on Linux. The test applies a
  read-only file *and* a read-only directory — Windows ignores directory modes,
  POSIX honours them, and each platform uses the one that bites. Both were
  verified load-bearing by removing each in turn and reproducing the failure.
- Anything that goes wrong exits `0` with empty stdout: no `git`, not a
  repository, no commits yet, malformed input, unwritable state. No network
  calls and no new dependencies.
