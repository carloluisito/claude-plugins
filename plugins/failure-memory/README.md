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

Two hooks, and nothing else:

- **`PostToolUseFailure`** — when a `Bash`, `Edit`, `Write`, `NotebookEdit`,
  `Task`, or MCP tool call fails, the failure is folded into the ledger for the
  current working directory. `Read`, `Glob`, and `Grep` failures are ignored on
  purpose; they fail constantly and mean nothing.
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

## What is stored, and where

One JSON file per project directory, under the plugin's data directory:

```
<plugin data dir>/ledger/<16 hex chars>.json
```

The filename is a truncated SHA-256 of the project path. Each file looks like:

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
plugin, and no telemetry. You can verify that in `scripts/` — it is about 400
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

Both hooks exit `0` unconditionally. Malformed input, an unreadable data
directory, a corrupt ledger, a missing `node` — all of it degrades to doing
nothing. Neither hook can block a tool call or a session.

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

It does not record successes, does not notice when you fix something, and has no
slash command for inspecting the ledger — read the JSON file if you want to see
it. Recording a failure as "resolved" requires knowing that a later success was
the same thing as the earlier failure, which the signature alone cannot tell
you.

## License

MIT
