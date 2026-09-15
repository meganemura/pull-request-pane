# 0005. Drag-select a substring of a description, arm it the same way as the whole body

- Status: accepted
- Date: 2026-09-16

## Context

0004 armed a whole entry's description to ride the next prompt. The person asked for less: a
drag-selected string, so an edit instruction can target one paragraph or sentence without
quoting (and paying the model's attention on) the rest. The engine's declarative Pane tree
(`Box`/`Button`/`Text`/`Link`) has no selection-range event — a `Button` presses, it does not
report a drag. The `Client` surface (`ClientProps`/`ClientSurface` in the d.ts) does: it hands
its module raw pointer events (`down`/`move`/`up`, region-relative cell coordinates) and holds
the pointer for the whole drag, past the Client's own edges too.

No shipped mod uses `Client` (checked across every `mods/*` directory), so there was no example
to build from. Two things had to be checked empirically rather than assumed: whether the
engine's own surface separation lets a mod split a Client's pure rendering logic from its
`$`-holding hooks module cleanly (it does — a `ClientModule` takes `(props, surface)`, never
`$`, so the pure geometry and the pointer handler are ordinary, directly testable functions),
and whether this surface supports drawing one element over another (`BoxProps` has no
`position`, `top`, `left` or `zIndex` — it does not). The second answer decided the design: a
`Client` cannot sit over the existing plain-`Text` description and highlight through it: it has
to draw the text itself.

## Decision

`description-selection.ts` is a new `Client` surface module (`plugin/hooks/description-selection.ts`,
referenced from `mod.ts` as `Client({ module: './description-selection.ts', props: { lines } })`)
that replaces the description's plain `Text` lines. It draws each line, tracks a drag's anchor
and current cell in its own local state, and highlights (`inverse: true`) the run the drag
covers, live, while the button is held. On release, it posts a `SelectionMessage` — the
character range as absolute offsets into the joined body (`{ type: 'selected', start, end }`),
or `{ type: 'cleared' }` for a plain click with no movement — through `surface.post`, once per
drag.

`mod.ts` reads that post through a `ui.message` hook matched on the pane's `requestId`, validates
the untrusted `data` (`selectionMessageOf`), and folds it into what is armed (`nextArmedOf`):
`state.armed` becomes `{ entry, range }` for a selection, exactly as `{ entry }` (no `range`)
already meant "the whole body" for a Button's own arm — the two share one slot, one at a time,
the same as before. `contextTextOf` slices `entry.body` to the range when one is given, and
says so in the sentence the model reads (`"a selection from ... description"` instead of
`"... description"`), so the model does not mistake a partial quote for the whole thing.

## Consequences

- The description no longer draws through the Pane's own render tree; it is opaque to
  `$.ui.render`'s returned tree (the engine loads and runs the Client module separately). Tests
  that once read the rendered text now read the Client leaf's `props.lines` instead
  (`clientPropsOf` in `plugin/tests/mod.test.ts`) — the guarantee (the whole body reaches the
  render, uncut) is unchanged, only how a test checks it.
- `claude plugin test plugin`'s kit has no call for `ui.message` (it is not in
  `EventCalls['ui']` — only `render`, `resolve`, `scroll` and `focus` are) and no way to drive a
  `Client` instance's pointer events at all. `description-selection.ts`'s own geometry and
  pointer handling are tested directly (a hand-rolled `ClientSurface` double,
  `plugin/tests/description-selection.test.ts`), and `mod.ts`'s side of the wiring is tested as
  the plain functions it is built from (`selectionMessageOf`, `nextArmedOf`, `statusForArmedOf`,
  `contextTextOf`). What stays untested by any gate: whether `'./description-selection.ts'`
  resolves at runtime, and whether the drawn highlight and the drag it tracks actually line up
  in a real terminal. `claude plugin validate plugin` does list the file under "surface
  modules", which confirms the reference resolves statically — not that it loads. Real-terminal
  verification is the follow-up this ticket's acceptance criteria already named as a non-blocker.
- A line longer than the Client's drawn width has no wrapping of its own (the module assumes
  one screen row per `\n`-delimited line, for an exact, simple pointer-to-offset mapping); a
  pointer coordinate past the visible width may not hit-test correctly until this is addressed.
- The whole-entry Button arm (0004) is unchanged in shape and kept working alongside this: press
  the Button for the whole body, drag over the description for a substring, either one armed at
  a time.
