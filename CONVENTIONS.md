# Repository conventions

Rules for how plugins are laid out, packaged, and published here.

**Scope note:** this document says nothing about *which* plugins belong in this
marketplace or what makes one worth building. That is a product decision and it
lives in the roadmap, not here. What follows is only the shape every plugin must
take once someone decides to build it.

`node scripts/validate-repo.mjs` enforces most of this mechanically. If a rule
here is not enforced by that script and could be, teaching the script the rule is
a welcome change.

## The marketplace name is frozen

The marketplace is `carloluisito-plugins`. **Never rename it.** Each user
registers only one marketplace per name, so a rename orphans every existing
install — people keep a dead marketplace and silently stop getting updates.
The validator hard-fails on any other value.

Note the repository is `claude-plugins` but the marketplace is
`carloluisito-plugins`: names beginning with `claude` or `anthropic` are rejected
at install time as impersonating an official marketplace.

## Layout

```
.claude-plugin/marketplace.json      the catalog — source of truth for what ships
plugins/<plugin-name>/               one self-contained directory per plugin
  .claude-plugin/plugin.json         the plugin's own manifest (required)
  README.md                          what it does, how to use it (required)
  CHANGELOG.md                       Keep a Changelog format (required)
  tests/run.mjs                      or a package.json "test" script (required)
  skills/ commands/ agents/ hooks/   whatever the plugin actually contributes
scripts/                             repo tooling — CI gates
```

Three names must agree for every plugin: the directory name, the `name` in its
`plugin.json`, and the `name` in its `marketplace.json` entry. The validator
rejects any mismatch.

## Manifest rules

Every entry in `marketplace.json.plugins` needs:

| Field | Rule |
|---|---|
| `name` | kebab-case, unique, matches the directory |
| `source` | exactly `./plugins/<name>` — external sources are not allowed here |
| `description` | a real sentence, ≥10 characters |
| `version` | semver, no leading `v`, and identical to `plugin.json`'s version |

Bump the version in **both** manifests in the same commit; the validator fails on
a mismatch. A plugin directory that exists but is not listed in
`marketplace.json` is an error — unlisted plugins are invisible to users.

## Quality bar

- **A plugin must contribute something.** At least one of `skills/`,
  `commands/`, `agents/`, `hooks/`, `lsp/`, `.mcp.json`, or the equivalent
  `plugin.json` field.
- **Tests are required, not optional.** Either `tests/run.mjs` (plain Node, no
  dependencies) or a `package.json` with a `test` script. CI runs them via
  `scripts/run-plugin-tests.mjs`.
- **Prefer zero dependencies.** This is software strangers install into their
  editor. Every dependency is a supply-chain surface and an install-time failure
  mode. Justify each one in the pull request that adds it.
- **Never read or transmit user secrets.** No telemetry, no network calls the
  README does not disclose.
- **Hooks and MCP servers must degrade safely.** A hook that throws, or a server
  that is missing its runtime, must not break the user's session. Use
  `${CLAUDE_PLUGIN_ROOT}` for paths inside a plugin — never a hardcoded absolute
  path.
- **Document the failure modes**, not just the happy path.

## Published software rules

`main` is published. A bad change does not break a personal tool; it breaks
strangers' installs.

- Prefer backward-compatible changes. State any breaking change explicitly in the
  pull request body and in the plugin's `CHANGELOG.md`, with the migration.
- Removing or renaming a plugin requires a `renames` entry in `marketplace.json`
  (map the old name to the new name, or to `null` if removed) so existing users
  migrate automatically. Treat `renames` as append-only history.
- Every change goes through a branch and a pull request. Never push to `main`.

## CI

Two required checks, both triggered by `pull_request`:

| Check | What it is |
|---|---|
| `manifests` | `node scripts/validate-repo.mjs` — the authoritative structural gate. |
| `test` | `node scripts/run-plugin-tests.mjs` — every plugin's own suite. |

The `manifests` job also runs the official `claude plugin validate` as an
**advisory** step (`continue-on-error`): it is the real install-time authority,
but it depends on an external npm package, so it must never be what blocks a
merge. Once it has proven reliable in Actions it can be promoted to blocking.

Run both locally before opening a pull request:

```bash
node scripts/validate-repo.mjs
node scripts/run-plugin-tests.mjs
```

## Local testing of a plugin

Test a plugin as a user would, not just via its unit tests:

```bash
# From a scratch project, add this checkout as a local marketplace
/plugin marketplace add /absolute/path/to/claude-plugins
/plugin install <plugin-name>@carloluisito-plugins
```

Then actually use it. A plugin whose tests pass but which is confusing or broken
in real use is not done.
