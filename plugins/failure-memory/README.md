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

Failures are keyed by a normalized signature, not by the literal command, so
`npm test -- auth.spec` and `npm test -- billing.spec` count as the same
recurring failure. Absolute paths, numbers, and hashes are collapsed for the
same reason.

## What is stored, and where

One JSON file per project directory, under the plugin's data directory:

```
<plugin data dir>/ledger/<16 hex chars>.json
```

The filename is a truncated SHA-256 of the project path. Each file looks like:

```json
{
  "cwd": "/home/you/projects/thing",
  "schema": 1,
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
