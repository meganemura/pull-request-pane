# 0003. Checks collapse to one coloured word; description is never cut

- Status: accepted
- Date: 2026-09-16

## Context

An entry's status line (`✓3 ✗1 …2 · APPROVED · MERGEABLE`) and its description were both
useful, but for different reads: the status line answers "is this one okay right now", the
description answers "what is this pull request or issue about". Showing the full status line
and only the first three lines of the description, as the original design did, put the wrong
one of the two behind a cut: the person could not read past the third line without pressing
the entry (which also fills the prompt box, a side effect they might not want yet), while the
status line's detail (exact counts, review decision, mergeable state) is rarely needed at a
glance — a color and a word answer "is it okay" on their own.

## Decision

- The checks row collapses to a `▶ checks` toggle Button plus one coloured word — `failing`
  (red), `running` (yellow), `passing` (green), or `no checks` (no colour) — matching the same
  red-beats-yellow-beats-green priority the full status line already used. A press expands it
  to `▼ checks` and the full line (`✓<pass> ✗<fail> …<pending> · <review decision> ·
  <mergeable>`) underneath; a second press collapses it again. Collapsed is the default: the
  question "should I look here" is answered before the question "what exactly is wrong".
- The description is drawn in full, with no line cap. It sits below the checks row (or
  directly below the title when there is no status yet), so the order is always title, checks,
  description — the shape the person asked for.

## Consequences

- A pull request with a very long description makes its entry, and the pane, taller; there is
  no per-entry scrolling — the whole pane scrolls, as the surface already does for oversized
  content. A truly long list of entries each with a long description could make scrolling to
  the last entry slower than a details-first collapsed shape would. Acceptable for now: this is
  the "cost is near zero" alternative to owning the pane's scroll (see the discussion this
  decision replaced, in `.claude-team/` and the `bd` ticket that tracked it), and the person can
  always press an entry's own toggle for the entries they care about.
- A true "pinned header and footer, independently scrolling description" layout — the first
  idea raised for this — would need the mod to own scrolling itself, the way `mods/diff` does
  for its docked pane (a `place`/window state model, a `ui.scroll` hook, clamping, and tests for
  all of it). That cost was judged not worth it against this near-zero-cost alternative, for
  now; revisit if a pane with many long descriptions turns out to be hard to navigate in
  practice.
