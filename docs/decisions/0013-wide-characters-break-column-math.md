# 0013. Selection and wrapping measure display width, not character count

- Status: accepted
- Date: 2026-09-16

## Context

Dragging over Japanese text in a title or a description selected the wrong characters. Every
column-counting function in `description-selection.ts` (`wrapLineOf`'s word-wrap budget,
`screenPosOf`'s pointer-to-character mapping) treated one character as one terminal cell. That
holds for the ASCII text every earlier fixture used, but a hiragana, katakana, kanji or Hangul
character (and fullwidth Latin and punctuation) draws as two cells, not one — so a pointer's `x`
(a cell count, per `ClientPointerEvent`'s own contract) stopped lining up with a character index
as soon as any wide character appeared before it on the row, and `wrapLineOf` let roughly twice
as many wide characters onto a row as actually fit its `columns` budget.

## Decision

Three new functions carry the fix: `cellWidthOf(code)` returns 2 for the common CJK/fullwidth
Unicode ranges (hiragana, katakana, CJK ideographs, Hangul, fullwidth forms) and 1 otherwise, not
a complete East Asian Width table (an astral-plane character, a surrogate pair, still counts as
two column-1 units, matching how every index in this file already treats one — out of scope
here); `indexAtWidth(text, start, maxWidth)` is `wrapLineOf`'s new row-ending search, walking by
cell width instead of `Math.min(rowStart + columns, text.length)`, and always advancing past at
least one character so a single wide character heavier than the whole budget still makes
progress; `charIndexAtColumn(text, x)` is `screenPosOf`'s new pointer-to-character lookup,
walking by cell width instead of clamping `x` directly as if it were already a character index.

Both `wrapLineOf`'s `text.length <= columns` early return and its hard-break math now go through
`displayWidthOf`/`indexAtWidth`. Every other function in the file (`selectedColumnsOf`,
`rowSelectionOf`, `absoluteOffsetOf`, `posOf`) stays character-index space, unchanged — they
never measured cells, only character positions, so they were never wrong for wide characters in
the first place. The title and the description share one `description-selection.ts`, so this
fixes both at once, as one file.

Caught by first reverting the fix and re-running the new tests against the old code (three of
four failed, matching the bug's shape exactly): a 5-character, all-wide-character line wrapped
as if 6 of it fit in 6 columns instead of 3, and a drag from cell 2 to cell 6 posted `start: 2,
end: 5` (one character mid-string, clamped past the end) instead of `start: 1, end: 3`.

## Consequences

- ASCII text is unaffected: `cellWidthOf` returns 1 for every character an existing test uses,
  so `displayWidthOf(text) === text.length` and `indexAtWidth`/`charIndexAtColumn` behave
  identically to the character-counting code they replaced.
- Mixed wide/narrow text (a line with both Japanese and ASCII) wraps and selects correctly by
  the same math — nothing here assumes a line is uniformly one width or the other.
- An emoji or other astral-plane character (a UTF-16 surrogate pair) is still measured as two
  1-cell units, not one 2-cell unit — the same character-index space every `Pos.col` in this
  file already uses, so this is not a new gap, just one this fix does not close. Worth a
  follow-up only if it shows up as a real complaint.
