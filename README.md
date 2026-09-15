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

## Attach a description or a title

Each entry shows a button (`#<n> PR <state>` for a pull request, `#<n> Issue <state>` for an
issue), then its title, then — for a pull request — its checks, then its full description.
Press the button (click it, or move to it with the arrow keys and press Enter) to arm that
entry's whole description to ride your next prompt; the status line says so, and the entry
gains `(armed)`. Nothing is written into the prompt box — type your instruction as you normally
would, whatever is already there included, and press Enter. Claude reads the description beside
your prompt and edits it on GitHub with `gh pr edit --body` or `gh issue edit --body`. Press the
same button again to drop it before it rides anywhere.

To attach only part of the title or the description, drag over it instead of pressing the
button: the covered text highlights as you drag, and releasing arms just that selection — the
status line says so, and the highlight stays, colored, as the only sign it is armed. Click the
highlighted text again (with no drag) to drop it. Editing a title this way rides `gh pr edit
--title` instead of `--body`. Only one thing is armed at a time across the whole entry — the
button's whole description, a description selection, or a title selection — arming another
replaces it, and its own automatic refresh pauses while it stays armed, so what is about to
ride your prompt does not change out from under you.

While a pull request is armed (by button or by a drag on either field), it stops updating on
the 60-second poll and on any other automatic refresh until it is disarmed.

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
single line longer than the pane is wide does not wrap for the drag.

## Persistence

Opening the pane, or the pane's own data changing, is saved to this plugin's own store, so a
reload of this file (developing against it under `--plugin-dir`, or any other reload the engine
does on its own) shows the last known entries right away instead of `reading…` — a background
refresh catches up from there once you next interact with the session.

## Status

Early access. The function-hooks API can change between Claude Code
releases without notice.
