# carloluisito-plugins

Open-source plugins for [Claude Code](https://code.claude.com/docs).

This repository is a **plugin marketplace**: a catalog you add once, from which
you install individual plugins.

## Install

```bash
# In Claude Code
/plugin marketplace add carloluisito/claude-plugins
/plugin install <plugin-name>@carloluisito-plugins
```

Refresh your local copy after new plugins land:

```bash
/plugin marketplace update carloluisito-plugins
```

## Available plugins

| Plugin | What it does |
|---|---|
| [failure-memory](./plugins/failure-memory/README.md) | Remembers tool calls that keep failing in a project and reminds you at the start of the next session. Local only, no network. |

`scripts/validate-repo.mjs` fails if a plugin in the catalog is missing from this
table, so it cannot silently fall behind what actually ships.

## Repository layout

```
.claude-plugin/marketplace.json   the catalog (source of truth for what ships)
plugins/<plugin-name>/            one directory per plugin, self-contained
scripts/validate-repo.mjs         structural validator (CI gate)
scripts/run-plugin-tests.mjs      per-plugin test runner (CI gate)
CONVENTIONS.md                    layout + quality rules for contributors
```

## Contributing

Read [CONVENTIONS.md](./CONVENTIONS.md) first — it defines the required layout,
the manifest rules, and the quality bar every plugin has to clear. Run the
local checks before opening a pull request:

```bash
node scripts/validate-repo.mjs
node scripts/run-plugin-tests.mjs
```

## License

[MIT](./LICENSE)
