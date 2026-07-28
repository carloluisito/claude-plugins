# Changelog

All notable changes to this plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
