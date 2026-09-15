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

## Quote a description

Each entry shows a button: `#<n> PR <state> <title>` for a pull request, `#<n> Issue <state>
<title>` for an issue. Press it, or its hotkey (`1` to `9`, the first nine entries), to write
that pull request's or issue's description into the prompt box as a quote, with an identifier
line naming the repository, number, title and URL above it. Type one instruction below the
quote and press Enter; Claude edits the description on GitHub with `gh pr edit --body` or `gh
issue edit --body`. A pressed entry shows `(quoted)` afterward.

## Checks, review and mergeability

While the pane is open, each pull request's status refreshes every 60 seconds and is drawn
beside its entry: `✓<pass> ✗<fail> …<pending> · <review decision> · <mergeable>`. The line
turns red when a check has failed, yellow when one is still running, green once every check
has passed. Issues have no status line.

## Status

Early access. The function-hooks API can change between Claude Code
releases without notice.
