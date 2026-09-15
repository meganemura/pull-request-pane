# 0002. Poll status on its own timer, separate from collecting entries

- Status: accepted
- Date: 2026-09-15
- Revised: 2026-09-16 — `$.clock.every` only calls its function after the first full period, so
  a pane opened cold showed no status for up to 60 seconds even though the entries were already
  on screen. The lead's read: no reason to wait that long for the first one. `command.run` now
  also fires `pollStatuses` once, unawaited, right after `refresh` finishes (so it has the PR
  numbers to ask about) and before it answers `{ text: 'pull-request-pane shown' }` — the
  periodic timer still runs on its own 60-second schedule from when it was registered, so this
  adds one poll, it does not replace the schedule. Because that first poll is no longer
  guaranteed to have landed before the first draw, two loading states were added: a PR entry
  with no status yet draws `fetching checks…` instead of nothing, and the footer's status line
  reads `status updating…` while any poll (the immediate one or a later scheduled one) is in
  flight, `status <time>` once it lands. The rest of this note is unchanged by the revision.

## Context

The pane shows two different things that change on two different schedules. Which pull
requests and issues are related to the session changes when the branch changes, when a commit
adds a closing keyword, or when the transcript names a new number — all things a `command.run`,
`turn.complete` or `gh` shell command already triggers a refresh for. A pull request's checks,
review decision and mergeability change on their own, driven by CI and reviewers, with nothing
in the session to trigger a refresh from.

## Decision

A separate `$.clock.every(60_000, …)` timer polls status, wired apart from the entry-collecting
`refresh`:

- The timer starts when the pane opens and is cancelled when it closes (`ui.close`'s own event,
  and the toggle in `command.run`), so nothing polls while there is no pane to draw into.
- One poll asks `gh pr view <n> --json isDraft,mergeable,reviewDecision,statusCheckRollup` for
  each pull request already on screen — it does not re-run the collection steps (`gh repo
  view`, `gh pr list`, the closing-keyword and transcript scans). Widening what is related is
  `refresh`'s job; the status poll only narrows onto pull requests it is already showing.
- 60 seconds matches how often CI results are worth re-reading in practice — often enough that
  a finished check appears within a minute of finishing, rare enough that an idle open pane
  costs at most one `gh` call a minute.
- Issues have no checks, review decision or mergeability, so they are left out of the poll
  entirely; only `kind === 'pr'` entries are asked.

## Consequences

- Opening the pane, an empty pull request list, or no `gh pr` entries at all costs nothing extra
  on the timer — it still registers, but polls zero PRs.
- A `gh pr view` failure for one pull request during a poll leaves that entry's last known
  status on screen rather than clearing it; only the next successful poll replaces it. A single
  bad call does not make a working row blank.
- The entry list and each pull request's status can be different ages at once — the footer
  shows `refreshed <time>` and `status <time>` separately, rather than one combined timestamp,
  so the person can tell which is stale.
