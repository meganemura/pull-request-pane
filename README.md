# pull-request-pane

A Claude Code plugin (a Claude Mod) that shows the GitHub pull requests
related to the current session in a pane beside the transcript.

- Press an entry to quote its description into the prompt box, type what to
  change, and Claude edits the description on GitHub.
- While the pane is open, each pull request's checks, review decision and
  mergeability refresh on a timer.

Issues that a pull request closes, and issues the transcript mentions, appear
as entries too.

## Requirements

- Claude Code 2.1.272 or later with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`
- `gh` logged in to GitHub

## Use

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir /path/to/pull-request-pane/plugin
```

Type `/pull-request-pane` to show or hide the pane.

## Status

Early access. The function-hooks API can change between Claude Code
releases without notice.
