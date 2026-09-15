# pull-request-pane

A Claude Code plugin (a Claude Mod) that shows the GitHub pull requests
related to the current session in a pane beside the transcript.

- Press an entry to arm its description to ride your next prompt, type what
  to change, and Claude edits the description on GitHub.
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

## Attach a description

Each entry shows a button: `#<n> PR <state> <title>` for a pull request, `#<n> Issue <state>
<title>` for an issue. Press it (click it, or move to it with the arrow keys and press Enter)
to arm that pull request's or issue's description to ride your next prompt; the status line
says so, and the entry gains `(armed)`. Nothing is written into the prompt box — type your
instruction as you normally would, whatever is already there included, and press Enter. Claude
reads the description beside your prompt and edits it on GitHub with `gh pr edit --body` or `gh
issue edit --body`.

Press the same entry again to drop it before it rides anywhere. Only one entry is armed at a
time; arming a second one replaces the first.

To attach only part of a description, drag over it instead of pressing the button: the covered
text highlights as you drag, and releasing arms just that selection (the status line and the
entry's `(selection armed)` say so). A click with no drag clears an armed selection. Dragging
and the button both write to the same one-armed-thing-at-a-time slot.

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

Each entry's description is drawn in full below its title and status, not cut to a few lines. A
single line longer than the pane is wide does not wrap for the drag; the drag-select feature is
new (2026-09-16) and has not yet been tried in a real terminal beyond the sandbox — a report of
anything odd there is welcome.

## Status

Early access. The function-hooks API can change between Claude Code
releases without notice.
