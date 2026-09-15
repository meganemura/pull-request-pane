# 0006. Real-terminal feedback on drag-select: persist the highlight, drop it by clicking it, select the title too, survive a hot reload, pause auto-refresh while armed

- Status: accepted
- Date: 2026-09-16

## Context

0005 shipped a drag-select feature and named its real-terminal behavior unverified by any gate.
The person tried it and reported seven things:

1. Clicking to start a selection turned the clicked character into a blank space.
2. Coloring the selected text is enough to know it is selected — no extra label is needed.
3. Clicking the already-selected (highlighted) text again to drop it reads better than having
   to press the entry's Button.
4. The title should be selectable and editable too, not just the description.
5. The `$.ui.status` line ("#3's selection rides your next prompt…") was confusing — its
   purpose was not obvious.
6. Leaving the pane alone for a while, it drops back to `reading…`.
7. The automatic refresh of an entry should pause while its text is being selected.

## Decision

**The blank-character bug (1).** Right after a `down`, before any `move`, the drag's start and
current cell are the same point — a zero-width range. `lineRowOf` drew that as an inserted,
highlighted space at the click position, since the same "empty selection becomes one space"
rule that makes a genuinely blank line's coverage visible also fired here, on a line that was
not blank. Fixed by drawing plain, unmodified text for a zero-width range on a non-empty line;
a zero-width range on an actually empty line still draws as one highlighted space, so a blank
line inside a real multi-line selection still shows as covered.

**Persistent highlight, no text label (2, 3).** `description-selection.ts`'s
`DescriptionSelectionProps` gained `armedRange`: what the hooks module already armed for this
field, as absolute offsets. Drawn as the highlight whenever no live drag is in progress, so the
color survives the mouse button coming up — that is now the only feedback a range arm gives on
the entry; the `(selection armed)` label from 0005 is removed (`entryBoxOf`'s suffix now fires
only for the Button's whole-body arm, which has no highlight of its own to fall back on).
Clicking inside that highlighted range with no drag (a plain click) posts `cleared`; a plain
click outside it posts nothing, so an unrelated click neither drops the selection nor starts an
empty one. A real drag (any movement) always posts a new `selected`, even one that starts inside
the old highlight — replacing it is still one motion, not click-to-clear-then-drag-again.

**Title selection (4).** `description-selection.ts` was already generic (an array of lines in,
a range out); reused unchanged for the title. `entryBoxOf` no longer draws the title inside the
Button's label — it gets its own `textSelectionOf` row, the same shape as the description's,
under a distinct `element` key suffix (`:title-select` vs `:body-select` — checked that neither
is a suffix of the other, so the `ui.message` hook's `endsWith` check needs no ordering). The
Button's label shrinks to `#<n> PR|Issue <state>`, identifying the entry without duplicating
text now selectable elsewhere. `Armed` gained a `field: 'title' | 'description'`; `contextTextOf`
reads the right source text and writes `--title` or `--body` into the `gh edit` hint
accordingly. `titleFitOf` and the `titleMaxChars` threading through `paneOf`/`entryBoxOf` are
gone with it — the title is never truncated, matching the description's own "always full"
precedent (0003).

**The status line, explained (5).** `$.ui.status`'s ⚠ icon is the engine's own for any status
line — not something this plugin sets or can change. The message itself stays (color says
*what* is selected; the status line is the only place that says it is about to ride the next
prompt at all — colour alone cannot say that), reworded from "press the entry to drop it" to
"click it again to drop it" for a range arm, since dropping one no longer goes through the
Button.

**Surviving a hot reload (6).** `$.store` is documented to persist "between sessions and hot
reloads" — unlike this module's own in-memory `state`, which a hot reload (the engine reloading
this file, which happens while iterating on it under `--plugin-dir`, and possibly at other
times this plugin has no visibility into) replaces with a fresh one from `register`'s own
initializer. `refresh` now writes `{ repo, entries, refreshedAt }` to the store on every
successful run; `session.start` reads it back and seeds `state` with it before anything else,
so a redraw that lands before this session's own first `refresh` completes shows the last known
entries instead of `reading…`. Not persisted: `isOpen`, the poll timer, or anything about what
is armed — restoring those from a value that might belong to an earlier, already-ended session
would risk auto-opening a pane, or resuming a poll, nobody asked this session to. The trade:
after a hot reload, the pane's data can go stale until the person's next interaction
re-triggers a `refresh` (`command.run`, `turn.complete`, a `gh` shell command) — a smaller
problem than `reading…` reappearing over data that already loaded once.

**Pausing auto-refresh while armed (7).** Both of this plugin's automatic triggers — the
60-second status poll and the `gh`/`turn.complete`-driven `refresh` — now leave the armed
entry's own text and status alone: `withArmedPreserved` swaps a freshly collected entry back
for the one already in `state` when its key matches what is armed, and `pollStatuses` skips
fetching that entry's checks entirely. A drag's offsets, and a Button's whole-body quote, are
both computed against one specific version of the title or body; refreshing it out from under
an armed selection — a real edit landing on GitHub, or even just a new fetch of identical
content under a new object — risked an offset pointing at the wrong text once the person typed
their instruction. Disarming (a click, a second Button press, or the prompt actually being
submitted) lifts the pause on the next automatic trigger.

## Consequences

- One entry can have at most one thing armed: the whole body (Button), a description range, or
  a title range — never two at once, matching 0004/0005's single slot.
- A description or title longer than the Client's drawn width still has no wrapping of its own
  (0005's known limitation); this round did not address it.
- `nextArmedOf` now also carries `field`, so a stray message from a Client that is no longer the
  armed one (mismatched entry or field) is a no-op rather than disarming something else — in
  practice `description-selection.ts` only ever posts `cleared` for a click inside its own
  `armedRange`, so a field mismatch should not reach here at all; checked anyway, since `data`
  is validated input, not a fact.
- The store holds one plugin-wide snapshot (`entries`/`repo`/`refreshedAt` for whichever
  repository was last open), not one per repository — opening the pane in a second repository
  before the first's snapshot is superseded by a real refresh would briefly show the first
  repository's stale entries. Acceptable for now: a `refresh` is what a person actually looks at
  the pane for, and one runs on every `command.run` open regardless.
