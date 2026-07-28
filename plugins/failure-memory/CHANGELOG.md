# Changelog

All notable changes to this plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-07-29

### Added

- **`/failure-memory:ledger` — see what is recorded, and forget an entry.** Until
  now the ledger was write-only from the user's side: the only way to find out
  why a note kept appearing at session start was to derive a SHA-256 of your own
  project path and open the JSON by hand. The skill prints every entry for the
  current project with an id, a count, the dates it was first and last seen, the
  tool, and the signature; a `*` marks the entries actually replayed, so a note
  you are seeing can be traced to a row, and a row that is recorded but silent
  can be ruled out.
- **`scripts/ledger.mjs list` and `forget <id>`.** The skill is a thin wrapper
  over a plain CLI, so the same inspection works without it. Ids are derived
  from entry content, so they survive other entries being removed, and several
  can be forgotten in one call.

### Notes

- **Forgetting clears the record; it does not add an exception.** Fail the same
  call twice again and the entry returns with a fresh count. There is no ignore
  list, and adding one is a separate decision.
- The entries worth forgetting by hand are the non-`Bash` ones — those are the
  only ones that never self-clear, because the `PostToolUse` hook that
  decrements on success matches `Bash` only. A stale `Edit` or MCP entry
  otherwise keeps asserting something false for up to 30 days.
- **`list` never writes and never locks.** Reading through the hooks' own
  `readLedger()` would have quarantined an unparsable file as a side effect of
  being looked at — correct for a hook that must keep capturing, wrong for an
  inspector — and taking the lock would have turned "show me the ledger" into a
  hang behind a stale lockfile. `forget` checks the file exists before locking,
  because acquiring the lock creates the ledger directory.
- The skill carries `disable-model-invocation: true`: Claude will not read your
  ledger unprompted.
- The empty listing states that the **first** failure creates the ledger, and
  that two failures are what make an entry *replay*. An earlier draft said the
  file arrived once a call "fails twice here", conflating the two thresholds;
  caught by running the skill in a project with no ledger, where the wrong
  sentence was read back to the user as fact. The wording is now pinned by a test.
- Its `allowed-tools` rule uses `${CLAUDE_SKILL_DIR}`, which Claude Code only
  expands there from **v2.1.129**. On older versions the rule does not match and
  the first run asks permission to execute the script; approving it is the whole
  fix. No new dependencies.

## [0.3.1] - 2026-07-29

### Fixed

- **An entry with no error text no longer renders a dangling `--`.** The replayed
  line always ended with ` -- ` followed by the excerpt, but `excerptFor()`
  returns `""` whenever the captured failure carried no usable error string, so
  those entries rendered as `... (failed 2x, last 2026-07-27) -- ` with nothing
  after the separator. That reads as truncated error text, which is the opposite
  of what an empty excerpt means. The separator is now conditional, exactly as
  the date clause already was.
- **The test suite no longer leaves temp directories behind.** A run created
  44 temp directories and removed only 31, so every invocation — including a
  fully passing one — leaked 13 into the OS temp dir, and nothing ever reclaimed
  them. Cleanup now happens once at end of run for every directory the suite
  creates, so it can no longer be skipped by a failing test (`check()` swallows
  the assertion, which skipped that test's trailing `rmSync`) or forgotten by a
  newly added one. A check asserts the suite leaves nothing behind.
- **The README now says where the ledger actually is.** *What is stored, and
  where* gave an unresolved `<plugin data dir>` placeholder, so the one
  verification step the README told you to take — open the JSON file — was the
  one step it did not let you take. It now gives the installed path, the
  fallback path used when `${CLAUDE_PLUGIN_DATA}` does not expand, and notes
  that `CLAUDE_CONFIG_DIR` relocates both.
- Stale wording in *Failure behaviour*: "Neither hook" dated from the two-hook
  build and was left behind by 0.3.0, which added a third.

### Notes

- The render fix changes the injected text for entries with no error excerpt;
  everything else in this release is documentation and tests. A test pins both
  documented paths, and asserts the fallback against what `resolveDataDir()`
  actually returns so the two cannot drift.

## [0.3.0] - 2026-07-29

### Added

- **A fixed problem stops being replayed.** A `PostToolUse` hook on `Bash` undoes
  one observation of a signature when that command succeeds, and drops the entry
  once its count reaches zero. Before this, counts only ever went up, so a
  problem you had already fixed kept being reported at session start for the full
  30-day window — the reminder outlived its usefulness and trained you to ignore
  the whole injection.
- README section *What self-clears and what does not*, documenting the
  `Bash`-only limit and the flaky-command tradeoff.

### Notes

- **Only `Bash` entries self-clear**, and this is a limit rather than a first cut.
  Every non-`Bash` signature folds the class of the error into its key, and a
  success carries no error to classify, so a stored `Edit`/`Write`/`Task`/MCP key
  cannot be reconstructed from the successful call. Those entries still age out
  after 30 days.
- **A flaky command decays.** One-for-one decrementing means something that fails
  half the time can drift below the replay threshold while still being broken.
  The alternative — demanding several clean runs before clearing — leaves stale
  reminders alive for days after a real fix, which is the worse failure.
- **No schema change, and no history is lost.** The signature rules are
  untouched, so `schema` stays at 2 and existing ledgers are read as-is.
- A success against a signature that is not in the ledger leaves the file
  byte-identical, and a success with no ledger at all creates neither the file
  nor its directory.
- `last_seen` is not refreshed by a decrement. It records when the failure last
  happened; a success is not a failure.

## [0.2.0] - 2026-07-28

### Changed

- **Breaking, one-time: your existing ledger history is discarded.** The ledger
  `schema` is bumped from 1 to 2 because the changes below alter which key a
  command produces. A schema-1 ledger is read as empty and replaced on the next
  failure rather than merged, since counts from two different rule sets cannot be
  added together. No migration is offered and none is possible: the old entries
  cannot be re-keyed without the original commands, which were never stored.
  Nothing is deleted behind your back — the file is overwritten in place and
  counting restarts from one. There is no action to take.
- Signatures now keep only the **first pipeline stage** of a `Bash` command.
  Everything from the first unquoted `|`, `;`, or `&&` onward is dropped, so
  `npm test && npm run lint` and `npm test` are one entry instead of two.
  Separators inside quotes are not treated as separators.
- A **trailing run of flags is sorted**, so `cargo build --release --locked` and
  `cargo build --locked --release` are one entry. This applies only when every
  token after the first flag is itself a flag, so `git commit -m one` and
  `git commit -m two` stay distinct.

### Fixed

- Injected session context now shows each failure's `count`, `first_seen`, and
  `last_seen`. Previously a reminder gave no way to tell a failure from last
  month apart from one from this morning.
- The injected text is now phrased as a dated observation rather than as advice.
  Injected context is invisible to you, so a stale instruction steered the model
  with nothing on screen to explain why.
- A missing or malformed timestamp on an entry no longer renders as
  `Invalid Date`, `NaN`, or `undefined`; the date is omitted instead.
- A ledger written by a different schema is no longer quarantined as corrupt. It
  is well-formed, so it is left on disk untouched — which also means a ledger
  from a *newer* version of this plugin is not destroyed by an older one.

## [0.1.1] - 2026-07-28

### Fixed

- The plugin could not be loaded at all. `plugin.json` declared
  `"hooks": "./hooks/hooks.json"`, but that file is already loaded by
  convention, so Claude Code rejected the plugin with "Duplicate hooks file
  detected" and neither hook ever registered. Removing the redundant manifest
  key fixes loading — `manifest.hooks` is only for *additional* hook files.
  Anyone who installed 0.1.0 should update to pick this up.

## [0.1.0] - 2026-07-28

### Added

- `PostToolUseFailure` hook that records failed `Bash`, `Edit`, `Write`,
  `NotebookEdit`, `Task`, and MCP tool calls into a per-project ledger.
- `SessionStart` hook that injects failures seen at least twice in the last 30
  days as session context, capped at 2,000 characters.
- Signature normalization so varying invocations of the same command collapse
  onto one ledger entry.
- Redaction pass over stored text covering common credential shapes.
- Atomic ledger writes, corrupt-ledger recovery, 200-entry cap, and 90-day
  expiry.
