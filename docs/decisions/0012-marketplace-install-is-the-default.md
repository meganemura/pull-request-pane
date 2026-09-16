# 0012. Marketplace install is the default; `--plugin-dir` is for development

- Status: accepted
- Date: 2026-09-16

## Context

`README.md`'s only install instruction was `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude
--plugin-dir /path/to/pull-request-pane/plugin` — a development-loop command (`AGENTS.md` names
it as exactly that), not something a person installing the plugin to use it should reach for
first: it requires a local checkout and re-typing the flag on every invocation. Now that the
repository is public, `claude plugin marketplace add`/`claude plugin install` (the same path
this author's own `headsign` plugin already uses) is the ordinary way for someone else to add
it.

`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` also had only one documented way to set it: prefixing
every `claude` invocation. `settings.json`'s `env` object sets a variable for every session
without repeating it.

## Decision

`.claude-plugin/marketplace.json` (repo root, alongside `plugin/.claude-plugin/plugin.json`)
declares this repository as a one-plugin marketplace, named `pull-request-pane` like the plugin
and the repository itself — `claude plugin marketplace add meganemura/pull-request-pane` then
`claude plugin install pull-request-pane@pull-request-pane` installs it. Both commands run and
confirmed against a local marketplace source before being written into the README (`claude
plugin marketplace add`, `claude plugin install ... -y`, then `uninstall`/`marketplace remove` to
leave no trace).

README's Install section leads with this, then names `settings.json`'s `env` object as the
per-session alternative to prefixing `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` on every invocation.
`--plugin-dir` moves to a "develop against a checkout" line below both, kept because
`AGENTS.md`'s own development loop still uses it.

`plugin/.claude-plugin/plugin.json`'s description was stale (it still described the pre-0004
"press quotes a description into the prompt box" behavior); updated to match what the plugin
does now, and `marketplace.json`'s own plugin entry uses the same wording, so a person reads the
same description whether they find it through the marketplace listing or the plugin's own
manifest.

## Consequences

- Two manifests now name the plugin's version-independent facts (its `name`, its description):
  `plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`'s `plugins[0]`
  entry. Keeping their descriptions worded identically is a discipline, not something the
  validator enforces — `claude plugin validate .` and `claude plugin validate plugin` each check
  their own manifest, neither checks the other against it.
- This repository's own release tag (`claude plugin tag`) already names itself
  `pull-request-pane--v<version>` from `plugin.json`'s own `version`; the marketplace entry
  carries no version of its own to keep in sync with a release.
