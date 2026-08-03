# repo-drift

Tells Claude when the git repository moved under it — a different branch, a
different commit, or a merge or rebase now in progress — since your previous turn
in the same session.

The problem it solves is narrow. You switch branches in another terminal, or
finish a rebase, and then keep talking to a session that still believes it is on
the branch it saw twenty minutes ago. Nothing on screen says otherwise, so the
next answer is reasoned from a tree that no longer exists: files it read are
stale, a patch it offers does not apply, a "you already have that function" is
about code that is now on a different branch. This plugin notices the move and
states it, once, before your next prompt is answered.

## Install

```
/plugin marketplace add https://github.com/carloluisito/claude-plugins
/plugin install repo-drift@carloluisito-plugins
```

Requires `node` and `git` on your `PATH`. Nothing else — no dependencies, no
config.

**Restart Claude Code after installing.** Hooks are registered when a session
starts, so in the session where you install the plugin nothing is tracked.

## How it works

One [`UserPromptSubmit`](https://code.claude.com/docs/en/hooks) hook, and nothing
else. Every time you submit a prompt it takes a fingerprint of the repository —

- the commit `HEAD` points at,
- the branch name, or `detached HEAD`,
- whether a merge, cherry-pick, or rebase is mid-flight

— compares it against the fingerprint from your previous turn in this session,
and if anything differs, prepends a short note to the model's context:

```
Repository state changed since your previous turn in this session:
  branch: main -> feat/auth
  HEAD: a1b2c3d -> 9f8e7d6
Files read earlier in this session may no longer match what is on disk.
```

You do not see this. It goes to the model, not to your terminal.

Then it stores the new fingerprint, so the same move is reported once and not on
every subsequent prompt.

The note is phrased as an observation, never as an instruction. Injected context
is invisible, and an instruction that steers a turn with nothing on screen to
explain why is worse than no note at all. The model is free to decide the change
is irrelevant — which it often is.

## What counts as drift, and what does not

Reported:

| Change | Example |
|---|---|
| Branch | `git checkout -b feat/auth`, `git switch main` |
| `HEAD` commit | a new commit, `git pull`, `reset --hard`, `rebase` finishing |
| Detached `HEAD` | `git checkout <sha>` or a tag |
| Operation started | a merge that stopped on conflicts, a paused rebase |
| Operation ended | that rebase being finished or aborted |

**Not** reported:

- **Uncommitted edits.** Editing, staging, or stashing a file changes nothing in
  the fingerprint. This is a deliberate cost decision, not an oversight — see
  [Cost](#cost).
- **Remote state.** A branch falling behind its upstream is invisible; nothing
  here fetches.
- **Which files Claude actually read.** The note says the tree moved, not that
  any specific file it looked at changed. It cannot tell you that, and it does
  not claim to.
- **A repeat of a move already reported.** The fingerprint advances after each
  note.

### Claude's own git commands are reported too

If Claude runs `git checkout` on your behalf, the next prompt reports that as
drift. There is no attempt to distinguish changes Claude caused from changes you
caused, and the hook has no way to: it sees the repository, not the reason.

This is mildly redundant rather than wrong — the model reading that `HEAD` moved
to the commit it just created costs a line of context. Suppressing it would mean
inferring intent from tool history, which risks the failure that matters more:
silently swallowing a real change because something adjacent looked deliberate.

## Cost

The hook is on the interactive path — every prompt you submit waits for it — so
what it costs is part of its contract.

It makes **one** `git rev-parse` call, which reads refs, and four `stat` calls.
Both are O(1) in the size of your worktree. `git status` would answer more
questions and is deliberately not used: it walks the whole tree, so the cost
would scale with the repository and the plugin would get slower exactly where
people need their editor to stay fast. That is the trade for not reporting
uncommitted edits.

Measured on Windows with `tests/bench.mjs` (20 invocations, median of the whole
hook process — spawn, stdin, git, state write, exit):

| Repository | Median |
|---|---|
| 1 tracked file | 173 ms |
| 30,000 tracked files | 137 ms |

The two are the same number within noise — the larger repository measured
*faster* — which is the claim being checked. Nearly all of it is Node process
startup, not git. For contrast, a single `git status --porcelain` in that 30,000
file repository takes 82 ms on top of the same startup, and unlike the above it
grows with the tree.

The hook's timeout is 5 seconds; the `git` call's own timeout is 2. Both are
ceilings for a broken environment, not a budget it uses.

## What is stored, and where

One small JSON file per project directory, under the plugin's data directory. For
a normal install from this marketplace:

```
~/.claude/plugins/data/repo-drift-carloluisito-plugins/<16 hex chars>.json
```

On Windows `~/.claude` is `%USERPROFILE%\.claude`. Setting
[`CLAUDE_CONFIG_DIR`](https://code.claude.com/docs/en/env-vars) relocates the
whole tree, this included. If `${CLAUDE_PLUGIN_DATA}` ever arrives empty or
literally unexpanded, the plugin falls back to:

```
~/.claude/plugins/data/repo-drift/<16 hex chars>.json
```

Note the missing `-carloluisito-plugins`. The two are siblings with nearly the
same name, so check both.

The filename is a truncated SHA-256 of the project path, so the path itself
leaks nothing about your directory layout. Don't try to compute it — list the
directory and open one, since every file records the project it belongs to as
its first field:

```json
{
  "cwd": "/home/you/projects/thing",
  "schema": 1,
  "sessions": {
    "b3f1…": {
      "fingerprint": { "head": "9f8e…", "branch": "feat/auth", "ops": [] },
      "updated": 1770000000000
    }
  }
}
```

Nothing else is recorded: no prompts, no file contents, no commit messages, no
history of past moves. One fingerprint per session, overwritten each turn.

Entries are pruned after 7 days, and capped at 100 sessions per project with the
oldest dropped first. Writes are atomic (temp file plus rename) and the file is
re-read immediately before each write, so two sessions in the same project do
not clobber each other.

**Nothing leaves your machine.** No network calls at all.

## Limits

- **A session id is required to keep sessions apart.** If the hook payload
  arrives without one, every session in that project shares a single bucket. A
  lone session still works; concurrent ones degrade to reporting nothing useful,
  because each turn overwrites the other's baseline.
- **The first prompt of a session never reports anything.** There is no previous
  turn to compare against; it establishes the baseline. A branch switch that
  happened before you started talking is not drift, it is just where you are.
- **Branch names are truncated to 40 characters** and the whole note is capped at
  380 characters, dropping detail lines from the bottom rather than emitting a
  half-sentence. A note this long is competing with your actual prompt.
- **Submodules are not followed.** The fingerprint is of the repository whose
  worktree you are in.

## Failure behaviour

The hook exits `0` with empty stdout for anything that goes wrong: `git` not
installed, not a repository, a repository with no commits yet, malformed or
absent hook input, an unreadable or corrupt state file, an unwritable data
directory. A corrupt state file is treated as empty and replaced. A hook that
breaks a session is worse than a hook that says nothing.

It cannot block a prompt, a tool call, or a session. It never returns a `block`
decision.

**Nothing depends on the note arriving.** A hook killed for exceeding its
timeout has its output discarded by Claude Code, so the fingerprint is advanced
only *after* the note has been written out. The consequence is deliberate: if
delivery fails you may see the same change reported on your next prompt instead,
which is a harmless duplicate. The alternative — advancing first — would swallow
a real change permanently and leave the model reasoning from a stale tree with
no way to find out.

## Uninstalling

```
/plugin uninstall repo-drift
```

**This deletes the stored fingerprints.** They are worthless without the
sessions they belong to, but `--keep-data` preserves them if you want it.

## Not in scope

No commands, no skills, no agents — a single hook is the whole plugin. It does
not fetch, does not run `git status`, does not read your diff, and does not
record anything about the repository beyond one commit sha, one branch name, and
a list of in-flight operations.

## License

MIT
