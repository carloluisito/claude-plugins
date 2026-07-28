---
name: ledger
description: Show the failure-memory ledger for this project and forget entries from it. Use when asked what failure-memory has recorded, why the same note keeps appearing at session start, or to clear an entry that is no longer true.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/../../scripts/ledger.mjs" *)
---

# The failure-memory ledger

The ledger is this plugin's entire memory: one JSON file per project directory,
holding the tool calls that have failed here more than once. `SessionStart`
replays a shortlist from it into every new session. Everything below reads or
edits that one file, and nothing else.

## What is recorded here right now

```!
node "${CLAUDE_SKILL_DIR}/../../scripts/ledger.mjs" list --data "${CLAUDE_PLUGIN_DATA}"
```

Read that listing to the user. It is the answer to "what does failure-memory
have on this project" and to "why do I keep seeing that note at session start".

Two things to point out if they are true:

- A `*` marks the entries that are actually replayed into new sessions. An
  unmarked entry is recorded but silent — it is not the cause of a note the user
  is seeing.
- If the listing reports a problem instead of entries, relay the reason it gave
  rather than diagnosing one. In particular a ledger from another schema is
  well-formed — it is not corrupt and it cannot be parsed wrongly; it is simply
  keyed by rules this build no longer uses.
- A `data dir:` note about the fallback path means the listing is probably not
  reading the file the hooks are writing. Say so rather than reporting an empty
  ledger as fact. The plugin README section "The data directory did not expand"
  covers the fix.

If the block above shows `[shell command execution disabled by policy]`, an
unexpanded `${...}`, or nothing at all, then it did not run. Run the same
command as a Bash call instead:

```
node "${CLAUDE_SKILL_DIR}/../../scripts/ledger.mjs" list --data "${CLAUDE_PLUGIN_DATA}"
```

Should that also fail, the ledger is still readable by hand. It lives at
`<data dir>/ledger/<hash>.json`, where the data dir defaults to
`~/.claude/plugins/data/failure-memory/` and the hash is derived from the
project's absolute path. List the `ledger/` directory and open the file.

## Forgetting an entry

An entry is worth forgetting when it is no longer true — the missing binary is
installed now, the argument shape changed, the flag was fixed. Leaving it in
place means the session-start note keeps asserting something false, for up to
30 days after the last failure.

Take the eight-character id from the listing and run:

```
node "${CLAUDE_SKILL_DIR}/../../scripts/ledger.mjs" forget <id> --data "${CLAUDE_PLUGIN_DATA}"
```

Several ids can be passed at once. Ids are derived from the entry's content, so
they are stable across removals but differ per project — always read them from
a listing taken in the same directory, never from an older transcript.

Do not guess an id. If the user names an entry in prose ("drop the npm one"),
list first, find the matching row, and confirm the id and its signature back to
them before removing it. `forget` on an id that is not present changes nothing
and says so.

Two limits to be honest about:

- Forgetting clears the record; it does not add an exception. The **next** time
  that call fails the entry is back with a count of one, and two observations
  put it back in session context. There is no ignore list. Keep those two
  numbers apart when you relay this: "if it fails twice again it comes back" is
  wrong, and it is the natural thing to say, because one failure is enough to
  re-create the entry and two are what make it *replay*.
- Only `Bash` entries clear themselves. When a recorded Bash command later
  succeeds, the plugin decrements it automatically. Entries for `Edit`,
  `Write`, `Task` or MCP tools never self-clear, because the hook that watches
  for success only matches `Bash`. Those are the ones that go stale, and the
  ones worth forgetting by hand.

## What this never does

Neither command writes unless the user asked to forget something. Inspecting a
broken or foreign-schema ledger reports the problem and leaves the file exactly
where it is — it will never move, rename, or truncate a file as a side effect of
being looked at. A `forget` against a project with no ledger yet does not create
one.
