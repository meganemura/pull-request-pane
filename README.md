# pull-request-pane

A Claude Code plugin (a Claude Mod) that shows the GitHub pull requests
related to the current session in a pane beside the transcript.

- Drag over an entry's title or description to arm that text to ride your
  next prompt, type what to change, and Claude edits it on GitHub.
- While the pane is open, each pull request's checks, review decision and
  mergeability refresh on a timer.

Issues that a pull request closes, and issues the transcript mentions, appear
as entries too, with a line between a run of pull requests and a run of
issues so the two do not read as one list of the same kind of thing.

## Requirements

- Claude Code 2.1.272 or later with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`
- `gh` logged in to GitHub

## Use

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir /path/to/pull-request-pane/plugin
```

Type `/pull-request-pane` to show or hide the pane.

## Refresh

A `↻ refreshed <time>` button sits above the entries (`↻ reading…` before the first one lands).
Press it to refetch every entry's title, description and checks right now, instead of waiting
for the next automatic refresh or the 60-second poll — the poll's own schedule restarts from the
press. Pressing it drops whatever is armed: unlike the refresh a turn or a `gh ` command
triggers on their own, this one is an explicit ask for the latest state, so keeping a stale
selection around would be the wrong trade.

## Attach a description or a title

Each entry shows its identifier (`#<n> PR <state>` for a pull request, `#<n> Issue <state>` for
an issue) as a link to it on GitHub — hover it and it highlights — then a blank line, its
bold title, another blank line, its checks (a pull request only, its status word bold too),
another blank line, then its full description. Drag over the title or the description to attach
it: the covered text highlights as you drag, and releasing arms that selection to ride your next
prompt — the status line says
so, and the highlight stays, colored, as the only sign it is armed (dragging over all of a field
arms the whole thing the same way). Nothing is written into the prompt box — type your
instruction as you normally would, whatever is already there included, and press Enter. Claude
reads the attached text beside your prompt: ask it to change the text and it edits it on GitHub
with `gh pr edit --body` (the description) or `gh pr edit --title` (the title); ask it something
else about the text instead, and it answers that. Click anywhere in that same field again, with
no drag, to drop it before it rides anywhere — on the highlight or away from it, either drops
it. Only one selection is armed at a time — arming another replaces it.

Its title and description stop refreshing while armed, so what is about to ride your prompt
does not change out from under you before you press Enter. Checks, review decision and
mergeability keep updating live on their own 60-second poll regardless — they have nothing to
do with what is armed.

## Checks, review and mergeability

Each pull request's status is fetched once as soon as the pane opens, and every 60 seconds
after that while it stays open. A pull request with no status yet shows `fetching checks…`;
the footer below the entries reads `status updating…` while a fetch is in flight, `status
<time>` once it lands.
Once fetched, it draws as a `▶ checks` toggle and one coloured word — `failing` (red),
`running` (yellow), `passing` (green), or `no checks` — so you can tell at a glance whether to
look further. Press the
toggle for the detail: a summary line (`✓<pass> ✗<fail> …<pending> · <review decision> ·
<mergeable>`), then each check by name, coloured by its own outcome and linked to its run
(GitHub Actions, CircleCI, whatever produced it) where one exists — hover a linked check and it
highlights, so it reads as clickable. Issues have no status.

Each entry's description is drawn in full below its title and status, not cut to a few lines,
and not to a few characters either: a logical line wider than the pane wraps onto as many screen
rows as it needs, with no `…` cutting any part of it, and a drag's position still matches a real
character across the wrap.

## Persistence

Opening the pane, or the pane's own data changing, is saved to this plugin's own store, so a
reload of this file (developing against it under `--plugin-dir`, or any other reload the engine
does on its own) shows the last known entries right away instead of `reading…` — a background
refresh catches up from there once you next interact with the session.

## Status

Early access. The function-hooks API can change between Claude Code
releases without notice.
