# 0008. Identifier as a link, blank-line spacing, click-away disarms, and wrapping the text itself

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
5. A second bug, with more screenshots, from the first fix for (4): the full unselected text
   now showed an `…` cut partway through, even where the paragraph plainly continued on the next
   line; a selected row could show two or three separate `…` marks, one at each internal segment
   boundary, cutting a word (`ell…sis`) that was never near the pane's edge.

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

**The wrapped-line bug, and its first fix (4).** The root cause: `description-selection.ts`
assumes one screen row per logical (`\n`-delimited) line — `y` from a pointer event is used
directly as an index into `lines`. A line the surface soft-wrapped onto two or three screen rows
broke that assumption outright: `y` still named the logical line, not the screen row the pointer
was actually over, so a drag's `x`/`y` no longer corresponded to real character positions at all
past the first wrapped row. First fix: draw every run with `wrap: 'truncate-end'` instead of the
surface's default, so a logical line always renders as exactly one screen row, cut rather than
wrapped when it is wider than the pane.

**The truncation bug this first fix caused, and its own fix (5).** `truncate-end` cuts *and*
appends `…`, on every `Text` node carrying it — not just the ones actually too wide. A row split
into up to three `Text` nodes (unselected prefix, inverse-video selection, unselected suffix) for
a drag in progress hands each node less than the pane's full width once flex has to share the
row, so each one independently decided it was too wide and cut itself, each with its own `…` —
the two or three scattered ellipses in the screenshots. The real fix does not truncate at all:
`visualRowsOf` word-wraps each logical line itself, to the `Client`'s own `columns`, into however
many screen rows it takes — greedily, breaking on the last space at or before the limit, hard-
breaking only a single word wider than the whole pane. Each screen row is then a plain, complete
piece of text needing no `wrap` prop of its own, and `y` from a pointer event indexes this
row list directly instead of `lines`, which is what the first fix was standing in for. `columns`
reads `0` for exactly one frame, before the `Client`'s first layout; treated as `Infinity` there
(no wrapping, the surface's own default takes over for that one frame only), same as before this
line of fixes started.

## Consequences

- Text no longer needs cutting to fit: `visualRowsOf` wraps to the real width instead, so the
  full, unabbreviated text always shows, with no `…` anywhere (0001's own note about a long
  title being cut with no ellipsis is now literally true, not just intended, for both fields).
- The `Client` no longer names a fixed `height`: with one row per wrapped line instead of one
  per logical line, the row count depends on the pane's width, so the region sizes itself to
  what the module actually draws (`ClientProps.height`'s own documented default).
- Clicking away from a selection no longer requires the exact highlighted cell — anywhere in
  that field's own Client, or in the other field's, drops it (since a click event only reaches
  the Client the pointer is actually over, a click in the *other* field's Client never reaches
  this one's `onPointer` at all, so only clicks within the same field's own rendered lines can
  disarm a selection there — a click on the title cannot drop a description selection or the
  reverse; each field's own Client owns only its own arm).
- The identifier `Link` covers the whole `#<n> PR <state>` line; nothing else on it is
  drag-selectable (it draws through `Text`/`Link`, not `description-selection.ts`), matching
  0007's decision that it identifies the entry rather than being text worth quoting.
