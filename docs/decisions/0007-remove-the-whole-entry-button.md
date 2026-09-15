# 0007. Remove the whole-entry Button; a drag over all of a field arms all of it

- Status: accepted
- Date: 2026-09-16

## Context

0001 decided to quote the whole body from one Button press, before paragraph- or line-level
selection existed at all. 0004 moved that arm from filling the prompt box to riding it as
context. 0005 added drag-select for a substring of the description; 0006 added it for the title
too, and made a range arm's own highlight (not a text label) the feedback that something is
armed. Once a drag could already cover all of a field's text — a small drag from its first
character to its last is no different in effect from "arm the whole thing" — the Button that
did only that became a second way to reach the same place, with its own separate feedback
("(armed)", a text label) and its own separate drop path (pressing it again) alongside the
drag's own highlight and click-to-drop. The person's own read: it did not need to be a button
any more.

## Decision

Removed the Button and its `onPress` entirely. `entryBoxOf`'s identifier row (`#<n> PR|Issue
<state>`) is now plain text, not a control. `Armed.range` is no longer optional — every arm is a
drag's range, into the title or the description; there is no "whole entry, no range" case to
carry a separate wording or a separate drop path for. `statusForArmedOf` and `contextTextOf`
lost their `range === undefined` branches; `nextArmedOf` is unchanged (it already always set a
range for a `'selected'` message). Arming the whole of a field is still one motion — drag from
its start to its end — just no longer a distinct code path from arming part of it.

## Consequences

- **Every arm now goes through `ui.message`, which has no engine-level test path.** Before this
  change, the Button was the one arm a test could reach through `$.ui.press` (a real, engine-
  routed call); `nextArmedOf`, `contextTextOf`, `statusForArmedOf` and `withArmedPreserved` were
  unit-tested directly for the range case, but the whole flow — arm, then submit a prompt, then
  check what rode it — had one true integration test, through the Button. That integration test
  (and its sibling, "pressing again drops it before any prompt carries it", and the no-room-in-
  context drop) had no equivalent to move to and are removed rather than faked. What remains is
  what 0005 and 0006 already accepted for the Client-driven arms: `selectionMessageOf`,
  `nextArmedOf`, `statusForArmedOf`, `contextTextOf`, `fittedContextTextOf` and
  `withArmedPreserved` are each tested directly as plain functions, and the `on('ui.message',
  ...)` / `on('prompt.submit', ...)` hooks that wire them to `state` and `host` are the thin,
  unavoidably untested glue — now covering 100% of arming instead of the part the Button used
  to leave to it.
- A description or a title with nothing in it (an empty string) can still be "armed" by a
  zero-length drag over empty space, though `isEmptyRange` in `description-selection.ts` treats
  a same-cell drag as a click, so this needs an actual empty selection over real characters, not
  a click on nothing — not observed as a real complaint, noted for completeness.
- `titleFitOf` and the `titleMaxChars` prop it needed are still gone (0006); nothing in this
  round restores a length-limited identifier line.
