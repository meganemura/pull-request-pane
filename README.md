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
<title>` for an issue. Press it (click it, or move to it with the arrow keys and press Enter)
to write that pull request's or issue's description into the prompt box as a quote, with an
identifier line naming the repository, number, title and URL above it. Type one instruction
below the quote and press Enter; Claude edits the description on GitHub with `gh pr edit
--body` or `gh issue edit --body`. A pressed entry shows `(quoted)` afterward.

Pressing an entry replaces the whole prompt box; there is no way to append to what is already
typed there.

## Checks, review and mergeability

Each pull request's status is fetched once as soon as the pane opens, and every 60 seconds
after that while it stays open. A pull request with no status yet shows `fetching checks…`;
the footer reads `status updating…` while a fetch is in flight, `status <time>` once it lands.
Once fetched, it draws as a `▶ checks` toggle and one coloured word — `failing` (red),
`running` (yellow), `passing` (green), or `no checks` — so you can tell at a glance whether to
look further. Press the
toggle for the detail: a summary line (`✓<pass> ✗<fail> …<pending> · <review decision> ·
<mergeable>`), then each check by name, coloured by its own outcome and linked to its run
(GitHub Actions, CircleCI, whatever produced it) where one exists — hover a linked check and it
highlights, so it reads as clickable. Issues have no status.

Each entry's description is drawn in full below its title and status, not cut to a few lines.

## Status

Early access. The function-hooks API can change between Claude Code
releases without notice.
