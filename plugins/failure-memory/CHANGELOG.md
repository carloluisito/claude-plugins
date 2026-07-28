# Changelog

All notable changes to this plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
