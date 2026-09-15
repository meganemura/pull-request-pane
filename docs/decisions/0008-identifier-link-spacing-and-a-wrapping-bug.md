# 0008. Identifier as a link, blank-line spacing, click-away disarms, and a wrapped-line bug

- Status: accepted
- Date: 2026-09-16

## Context

Four more rounds of real-terminal feedback on the entry layout and the drag-select feature:

1. The identifier line (`#<n> PR <state>`) should be a link to the pull request or issue on
   GitHub, hoverable like a linked check already is.
2. The entry's parts (identifier, title, checks, description) run together with nothing
   between them; blank lines would make the pane easier to read at a glance.
3. Clicking outside an armed selection did nothing (0006 chose this on purpose, so an unrelated
   click could not disarm something else by accident); real use said the opposite feels more
   natural — clicking away from a selection is how clearing one usually works elsewhere.
4. A bug, with screenshots: dragging over a logical line the terminal had soft-wrapped onto
   several screen rows produced a garbled highlight — the wrong characters covered, a word cut
   mid-way with a gap in the middle of the highlighted run.

## Decision

**Identifier as a link (1).** `identifierRowOf` wraps the identifier text in a `Link` to
`entry.url`, with the same `hover` cyan a linked check already uses (0003), inside its own keyed
`Box` (the hover colour is refused outside one).

**Spacing (2).** `entryBoxOf`'s outer `Box` takes `rowGap: 1` across its four parts —
identifier, title, checks, description — so a blank line separates each from the next. The
checks rows (which can be several: a toggle, a summary, one line per check) are grouped into one
child `Box` first, so the gap lands around the whole block, not between each check line inside
it. `paneOf`'s own list of entries gets `rowGap: 1` too, one blank line between entries and none
before the first or after the last.

**Click away also disarms (3).** `description-selection.ts`'s 'up' handler now posts `cleared`
for any click with no movement while something is armed here, not only one landing inside the
highlight. Reverses 0006's own choice on this point, on the strength of how it read in real use;
0006's `armedRange` is still what decides whether there is anything to clear, and a click while
nothing is armed still posts nothing.

**The wrapped-line bug (4).** The root cause: `description-selection.ts` assumes one screen row
per logical (`\n`-delimited) line — `y` from a pointer event is used directly as an index into
`lines`. A line the surface soft-wrapped onto two or three screen rows broke that assumption
outright: `y` still named the logical line, not the screen row the pointer was actually over, so
a drag's `x`/`y` no longer corresponded to real character positions at all past the first
wrapped row. Fixed by drawing every run with `wrap: 'truncate-end'` instead of the surface's
default: a logical line now always renders as exactly one screen row, cut rather than wrapped
when it is wider than the pane. This was already the plan named as a known limitation in 0005
and 0006 ("a description or title longer than the Client's drawn width... has no wrapping of
its own"); this is that plan enforced explicitly, rather than left to whatever the surface's
default happened to do, which is what produced the bug.

## Consequences

- A logical line wider than the pane is now visibly cut, with no ellipsis or other affordance
  that more text follows off-screen (0001's own note about a long title being cut with no
  ellipsis applies here too, for both fields, at the character level rather than the whole
  string). Worth a follow-up if this proves confusing in practice; not addressed here.
- Clicking away from a selection no longer requires the exact highlighted cell — anywhere in
  that field's own Client, or in the other field's, drops it (since a click event only reaches
  the Client the pointer is actually over, a click in the *other* field's Client never reaches
  this one's `onPointer` at all, so only clicks within the same field's own rendered lines can
  disarm a selection there — a click on the title cannot drop a description selection or the
  reverse; each field's own Client owns only its own arm).
- The identifier `Link` covers the whole `#<n> PR <state>` line; nothing else on it is
  drag-selectable (it draws through `Text`/`Link`, not `description-selection.ts`), matching
  0007's decision that it identifies the entry rather than being text worth quoting.
