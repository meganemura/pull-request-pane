# 0009. A refresh button, a divider between kinds, and simple decoration

- Status: accepted
- Date: 2026-09-16

## Context

Four more asks:

1. The footer's plain `refreshed <time>` line should move to the top of the pane and become a
   button: pressing it should refetch both the description text and the checks right now, not
   wait for the next automatic refresh or 60-second poll, and the poll's own schedule should
   restart from the press rather than keep whatever was left of the old one.
2. Since a press is an explicit ask for the latest state, it is fine for it to drop whatever is
   armed — unlike the automatic refreshes (`turn.complete`, a `gh ` Bash command), which
   preserve an armed entry's text on purpose (`withArmedPreserved`) so a drag in progress keeps
   pointing at real offsets.
3. A pull request and an issue it closes, or one the transcript mentions, can sit next to each
   other in the list with nothing to mark that they are different kinds of thing; a line between
   them would make that visible at a glance.
4. The title and the checks section could use the same kind of simple decoration the identifier
   link and the description's highlight already have.

## Decision

**The refresh button (1, 2).** `refreshButtonOf` draws a `Button` at the top of the pane, above
the entries, labelled `↻ reading…` before the first refresh lands and `↻ refreshed <time>`
after. Its `onPress` calls `manualRefresh`, which: clears `state.armed` and its status line
outright (no `withArmedPreserved` call — this is the one refresh that does not protect an armed
entry, since the person asking for it is the same one who would lose the drag); calls `stopPoll`
then `startPoll`, so the 60-second timer restarts counting from the press; and awaits `refresh`,
then `pollStatuses` — in that order, not together. `refresh` replaces `state.entries` wholesale
from `gh pr list`, whose records carry no `status` field; running the two concurrently risked
`refresh` finishing after `pollStatuses` and overwriting the very status the press just fetched,
back to `fetching checks…` for up to another `POLL_MS` — checked by running the two concurrently
against this decision's own test before sequencing them: the test failed there, with `fetching
checks…` where it expects `no checks`. The test asserts the checks are still there right after
the press, not just that both `gh` calls happened.

**The kind divider (3).** `paneOf` walks `state.entries` itself now, instead of a plain `.map`:
before drawing an entry whose `kind` differs from the one before it, it draws `kindDividerOf`, a
dim `─` rule. No divider before the first entry or between two of the same kind. `paneOf` now
takes the render input's own `bodyColumns` (`e.props.bodyColumns` in the `ui.render` hook) and
sizes the rule to `bodyColumns` less `PANE_PADDING_RIGHT`, the same width everything else inside
the pane (the rows, each entry, the Clients at `width: '100%'`) already draws into — the d.ts
names this exact use for `bodyColumns`: "size a table or a rule to it rather than to
`viewport.columns`".

**Decoration (4).** `entryBoxOf` passes `bold: true` to the title's own `textSelectionOf` call
(`description-selection.ts`'s `DescriptionSelectionProps.bold`, threaded down to every `Text` it
draws); the description keeps `bold: false` (its default), so only the title stands out from the
paragraph below it. The collapsed checks row's status word (`failing` / `running` / `passing` /
`no checks`) is drawn `bold: true` alongside its existing colour, the same weight the title now
has.

## Consequences

- The footer keeps only the status line (`status updating…` / `status <time>`); it is dropped
  entirely (no empty marginTop `Box`) while there is nothing to say — before the first status
  poll lands, same as before this decision.
- Pressing the refresh button while something is armed drops it with no separate warning — the
  press itself is the person's own signal that the current state matters less than the fresh
  one; this is not independently testable at the engine level (arming has no engine-level test
  path at all, per 0007), so it rests on `manualRefresh`'s own straight-line reading: it sets
  `state.armed = null` unconditionally, the same as any other line in the function.
- The divider is sized to `bodyColumns` less the pane's own right padding, not `viewport.columns`
  (the whole terminal, wider once the pane is docked beside the transcript rather than filling
  it) and not measured character-by-character the way `description-selection.ts` now wraps text
  (0008); `bodyColumns` is already the figure the surface itself uses for exactly this, and
  subtracting the padding keeps the rule from ending one cell past everything drawn beside it.
