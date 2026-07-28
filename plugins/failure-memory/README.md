# failure-memory

Keeps a per-project tally of tool calls that keep failing, and reminds you about
the repeat offenders when a session starts.

The problem it solves is narrow: within one session Claude remembers that
`npm test` blew up, but after a `/clear`, a compaction, or tomorrow morning that
knowledge is gone, and the same dead end gets walked again. This plugin writes
those failures to a small local file and reads it back at session start.

## Install

```
/plugin marketplace add https://github.com/carloluisito/claude-plugins
/plugin install failure-memory@carloluisito-plugins
```

Requires `node` on your `PATH`. Nothing else — no dependencies, no config.

**Restart Claude Code after installing.** Hooks are registered when a session
starts, so in the session where you install the plugin it captures nothing.

## How it works

Three hooks, and nothing else:

- **`PostToolUseFailure`** — when a `Bash`, `Edit`, `Write`, `NotebookEdit`,
  `Task`, or MCP tool call fails, the failure is folded into the ledger for the
  current working directory. `Read`, `Glob`, and `Grep` failures are ignored on
  purpose; they fail constantly and mean nothing.
- **`PostToolUse`** — when a `Bash` command **succeeds**, one observation of that
  signature is undone, and the entry is dropped once its count reaches zero. See
  [What self-clears and what does not](#what-self-clears-and-what-does-not) — the
  asymmetry with the hook above is deliberate.
- **`SessionStart`** — failures that have happened **at least twice** and were
  last seen **within 30 days** are injected as context. Anything that failed once
  is noise and is not reported.

## How failures are matched up

Failures are keyed by a normalized **signature**, not by the literal command.
Without this, `npm test | tee out.log` on Monday and `npm test` on Tuesday are
two entries with a count of 1 each — neither reaches the threshold of two, and
nothing is ever reported. For a `Bash` command the signature is built in this
order:

1. **Only the first pipeline stage is kept.** Everything from the first unquoted
   `|`, `;`, or `&&` onward is dropped, so `npm test && npm run lint` and
   `npm test` are the same failure. Separators inside quotes don't count:
   `echo "a && b"` is left whole.
2. **Operands after `--` are dropped**, so `npm test -- auth.spec` and
   `npm test -- billing.spec` are the same failure.
3. **A trailing run of flags is sorted**, so `cargo build --release --locked` and
   `cargo build --locked --release` are the same failure. This only applies when
   *every* token after the first flag is itself a flag — `git commit -m one` is
   left alone, because `one` is a value and reordering it would merge two
   unrelated commits.
4. **Absolute paths, hashes, and numbers are collapsed** to `<path>`, `<hex>`,
   and `<n>`, so a command carrying a temp directory or a PID still matches
   itself.

The bias throughout is toward keeping things apart. A duplicated ledger row is
untidy; a wrongly merged one produces a reminder about a command you never ran.
So anything ambiguous — an unterminated quote, a flag that might take a value —
is left uncollapsed.

Other tools are keyed more coarsely, by tool name plus a rough class of error:
`Edit`, `Write`, and `NotebookEdit` by file extension, `Task` by subagent type,
MCP tools by the shape of their input.

## What self-clears and what does not

**Only `Bash` entries self-clear.** A `Bash` failure and a later `Bash` success
can be recognised as the same thing, because the signature for a `Bash` command
is built from the command text alone. Every other tool's signature folds the
*class of the error* into the key — an `Edit` that failed because the file was
missing is a different entry from one that failed on a string mismatch — and a
success carries no error to classify. There is no key to look up, so nothing is
decremented. A failed `Edit`, `Write`, `Task`, or MCP call ages out after 30 days
instead; it is never cleared by a subsequent success.

Within `Bash`, clearing is one-for-one and blunt:

| You did | Ledger |
| --- | --- |
| Failed twice, then it works | Entry gone |
| Failed three times, then it works | `count` drops to 2 — still replayed |
| Failed three times, works twice | `count` drops to 1 — below the threshold, not replayed |
| Succeeded on something never recorded | Nothing happens; the file is not touched, and no file is created |

The consequence worth knowing: **a flaky command decays.** Something that fails
half the time will hover near the threshold and may stop being reported even
though it is still broken. The alternative — requiring several clean runs before
clearing — keeps stale reminders alive for days after a real fix, and a reminder
about a problem you already solved is worse than a missing reminder about one you
already know is flaky.

A success never refreshes `last_seen`. That field records when the failure last
happened, and a success is not a failure; touching it would pin a half-cleared
entry inside the 30-day window indefinitely.

## Seeing and pruning the ledger

```
/failure-memory:ledger
```

Prints every entry recorded for the current project: an id, the count, the dates
it was first and last seen, the tool, and the signature. A `*` marks the entries
that are actually replayed at session start — an unmarked entry is recorded but
silent, so it is not the cause of a note you are seeing. `/ledger` on its own
also works unless something else already claims that name.

The skill carries `disable-model-invocation: true`. Claude will not go looking
through your ledger on its own; you have to ask.

To drop an entry, name it and the skill runs:

```
node <plugin>/scripts/ledger.mjs forget <id>
```

Ids are the eight characters at the start of each row. Several can be passed at
once. They are derived from the entry's content, so they survive other entries
being removed but differ from project to project — read them from a listing taken
in the same directory, never from an older transcript.

Two limits worth knowing before you use it:

- **Forgetting clears the record; it does not add an exception.** Fail the same
  call twice again and the entry comes back with a fresh count. There is no
  ignore list, and there is no way to tell this plugin to stop watching
  something.
- The entries actually worth forgetting by hand are the non-`Bash` ones, because
  those are the only ones that never clear themselves — see [What self-clears and
  what does not](#what-self-clears-and-what-does-not). A `Bash` entry usually
  goes away on its own the next time the command works.

Neither command writes unless you asked to forget something. Listing a corrupt or
foreign-schema ledger reports the problem and leaves the file byte-for-byte where
it is; `forget` in a project that has no ledger does not create one.

Two ways it can come out wrong, both recoverable:

- On Claude Code before **v2.1.129** the skill's pre-approval rule is not
  expanded, so the first run asks permission to execute the script. Approving it
  is the whole fix.
- With `disableSkillShellExecution` set, the listing arrives as
  `[shell command execution disabled by policy]`. The skill then runs the same
  command as an ordinary Bash call, and if that is also blocked, falls back to
  reading the JSON directly — which you can always do yourself.

## What is stored, and where

One JSON file per project directory, under the plugin's data directory. For a
normal install from this marketplace:

```
~/.claude/plugins/data/failure-memory-carloluisito-plugins/ledger/<16 hex chars>.json
```

On Windows `~/.claude` is `%USERPROFILE%\.claude`. That directory name is the
plugin identifier `failure-memory@carloluisito-plugins` with every character
outside `a-zA-Z0-9_-` replaced by `-`; the derivation is Claude Code's, not this
plugin's.

Two things move that path, and both are worth knowing before you go hunting.

**A non-default config directory.** `~/.claude` is the default root, not a fixed
one. Setting [`CLAUDE_CONFIG_DIR`](https://code.claude.com/docs/en/env-vars)
relocates the whole tree — settings, history, `plugins/data/` and your ledger
with it. If you run Claude Code under that variable, look there instead.

**The placeholder not expanding.** Each hook is handed `${CLAUDE_PLUGIN_DATA}`
by Claude Code. If that ever arrives empty or literally unexpanded, the plugin
falls back to:

```
~/.claude/plugins/data/failure-memory/ledger/
```

Note the missing `-carloluisito-plugins`. The two are siblings with nearly the
same name, so check both before concluding nothing was captured. Capture works
either way — but the fallback is not the intended path, and a ledger showing up
there means the placeholder did not expand in your environment, which is worth
[reporting](https://github.com/carloluisito/claude-plugins/issues).

Don't try to compute the filename. It is a truncated SHA-256 of the project
path, so list `ledger/` and open one — every file records the directory it
belongs to as its first field.

Each file looks like:

```json
{
  "cwd": "/home/you/projects/thing",
  "schema": 2,
  "entries": [
    {
      "tool": "Bash",
      "signature": "npm test",
      "error_excerpt": "Command exited with non-zero status code <n>",
      "count": 6,
      "first_seen": "2026-07-01T10:00:00.000Z",
      "last_seen": "2026-07-27T18:22:00.000Z"
    }
  ]
}
```

That is the whole data model. Stored per failure: the tool name, the normalized
signature, a clipped error excerpt, a count, and two timestamps.

**Nothing leaves your machine.** There is no network call anywhere in this
plugin, and no telemetry. You can verify that in `scripts/` — it is about 1,300
lines of plain Node with zero dependencies.

Text is run through a redaction pass before it is written, covering
`TOKEN=`/`KEY=`/`PASSWORD=`-style assignments, `Authorization` headers, `Bearer`
values, known credential prefixes (`sk-`, `ghp_`, `AKIA`, `xox*-`, `AIza`,
`github_pat_`), JWTs, and long opaque blobs. Treat that as best effort, not as a
guarantee: it is a filter over error text, not a vault. **This is not a
credential store, and it should never be treated as one.**

## Limits

| Thing | Limit |
| --- | --- |
| Entries per project | 200 (lowest `count` evicted first, then oldest) |
| Entry lifetime | 90 days since `last_seen` |
| Error excerpt | 300 characters |
| Injected context | 2,000 characters (hook output cap is 10,000) |
| Replay threshold | `count >= 2` and seen within 30 days |

Writes go through a temp file plus a rename, so a reader never sees a half
written ledger. A corrupt ledger is moved aside to `<name>.json.corrupt` and a
fresh one is started rather than wedging capture forever.

If two tool calls fail at the same instant and contend on the lock, the losing
observation is **dropped**. Losing one duplicate failure record is a better
trade than making a tool call feel slow.

The `schema` number in the ledger is the version of the signature rules. When it
changes, existing entries are keyed by rules this build no longer uses, so they
are **read as empty and replaced** rather than merged — counts from two different
rule sets cannot be added together. In practice: **upgrading to 0.2.0 discards
whatever history you had, once.** The file is not quarantined or deleted behind
your back; it is simply overwritten on the next failure, and counting restarts
from one.

## Failure behaviour

All three hooks exit `0` unconditionally. Malformed input, an unreadable data
directory, a corrupt ledger, a missing `node` — all of it degrades to doing
nothing. No hook can block a tool call or a session.

Interrupted tool calls (`is_interrupt: true`) are not recorded. Pressing escape
is not a failure.

## Uninstalling

```
/plugin uninstall failure-memory
```

**This deletes the ledger.** To keep it, pass `--keep-data`:

```
/plugin uninstall failure-memory --keep-data
```

## Not in scope

Successes are **not** recorded — a `Bash` success only ever subtracts from an
entry that already exists, and one that matches nothing is a no-op. Nothing
counts how often a command works.

Editing the ledger is limited to removing whole entries — see [Seeing and pruning
the ledger](#seeing-and-pruning-the-ledger). A count cannot be adjusted, a
signature cannot be rewritten, and nothing can be added by hand. The JSON file is
always readable directly if you want the raw view; [What is stored, and
where](#what-is-stored-and-where) gives the path, and deleting the file starts
over.

Non-`Bash` failures cannot be cleared by fixing them, only by waiting them out.
That is a limit of the signature, not an oversight — see [What self-clears and
what does not](#what-self-clears-and-what-does-not).

## License

MIT
