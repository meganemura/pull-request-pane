# 0003. Checks collapse to one coloured word; description is never cut

- Status: accepted
- Date: 2026-09-16
- Revised: 2026-09-16 (the same day, after a real-terminal look at the shipped version) — the
  expanded view no longer shows one status line coloured by the worst outcome across every
  check. The lead's own read: "✓1 ✗1 …1 · MERGEABLE" drawn entirely in red misrepresented the
  one check that had actually passed, and having pressed the toggle at all, each check's own
  name was worth showing, not just the aggregate spelled out. Expanded now draws the summary
  line uncoloured (dim, like the description) and one row per check — its own symbol, colour,
  and name — each wrapped in a `Link` to its run (`gh`'s `detailsUrl`/`targetUrl`) where one
  exists, so a click reaches GitHub Actions, CircleCI, or whatever produced it. The Decision and
  Consequences sections below are updated in place; the collapsed word and its colour priority
  are unchanged by this revision.

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
  red-beats-yellow-beats-green priority the full status line already used. Collapsed is the
  default: the question "should I look here" is answered before the question "what exactly is
  wrong".
- A press expands it to `▼ checks`, an uncoloured summary line (`✓<pass> ✗<fail> …<pending> ·
  <review decision> · <mergeable>`), then one row per check: its own symbol and colour (`✓`
  green, `✗` red, `…` yellow, `⏭` uncoloured), its name (gh's `name` for a CheckRun, `context`
  for the older StatusContext shape, a position when neither is given), and a `Link` to its run
  when gh gave a URL. A second press collapses it again. A linked check's `Text` also carries a
  `hover` colour (cyan, a colour no outcome uses) so hovering it reads as "clickable" rather than
  as the check's own status changing under the pointer.
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
