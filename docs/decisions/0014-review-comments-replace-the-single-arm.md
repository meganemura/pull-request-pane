# 0014. Multiple review comments per entry, sent as one prompt — superseding 0004

- Status: accepted
- Date: 2026-09-18

## Context

0004 armed one selection at a time to ride the person's next prompt as context: drag, then type
one instruction, then Enter. A sibling plugin, draft-pane, built a different shape on the same
`Client` drag primitive: drag over a span, type a comment on it directly in the pane, add any
number of them, plus one comment on the whole thing, then press Submit to send every comment as
one prompt that quotes each span. The person tried it and asked for the same shape here.

The two designs answer different questions. 0004's arm-and-type is for asking Claude something
about a selection ("why does this fail", "shorten this") where the instruction is not known in
advance and the quoted text is evidence for it. draft-pane's shape is for leaving several review
comments before acting on any of them — closer to GitHub's own "start a review, add comments,
submit" than to attach-and-ask.

## Decision

A drag over a title or a description opens a comment box for that span (an `Input`, labelled
`comment`, autofocused): Enter adds `{ field, start, end, comment }` to the entry's own list, any
number of times, across either field; an empty Enter drops the span instead. A second, always
present `Input` (labelled `overall`) takes one comment on the entry as a whole; a second Enter
into it replaces what was there, an empty Enter clears it. Each committed span is listed under
the fields with its quote and an `x` button to remove it.

Pressing Submit calls `$.prompt.submit({ text })` directly — not the `context`-riding path 0004
used — with `text` built by `feedbackTextOf` (`review.ts`, ported from draft-pane's own function
of the same name): a header naming the entry (`Feedback (pull-request-pane) on PR #42:`), then
each span (title spans before description spans, each group by ascending `start`) as a quoted
slice of the field it came from and its comment, then the overall comment last, labelled
`(overall)`. Submit refuses while an `Input` still holds text Enter has not added, and refuses
with zero comments; both refusals show as a status line rather than sending anything.

This is a real behavioral fork from 0004, not an addition beside it: once every span carries its
own typed comment, the comments are the instruction. A separate "now type your prompt" step
would ask the person to say the same thing twice. `state.armed` (one slot, entry-wide) is
replaced by `state.review: Map<entryKey, Review>` (`review.ts`'s `Review`, one per entry, holding
a pending selection, its unsent comment text, every committed span and the one overall comment
and its unsent text). `contextTextOf`, `fittedContextTextOf` and the `on('prompt.submit', ...)`
hook are gone with 0004's design; `nextArmedOf`/`statusForArmedOf`/`withArmedPreserved` are
replaced by `withSelection` (review.ts) and `withReviewPreserved` (mod.ts), which protects an
entry's frozen text whenever its review holds a pending selection, a committed span, an overall
comment, or unsent text in either `Input` — a broader condition than 0004's single armed slot,
since a half-written review is now worth more to protect than a single quote arm was.

There is no Approve action, unlike draft-pane's. draft-pane's drafts are the model's own text
awaiting a nod; this plugin's entries are pre-existing GitHub objects being discussed, not
proposals awaiting approval — "approve" has no meaning here that Submit with an empty comment
list would not already say better (and Submit already refuses that case, on purpose, so pressing
it with nothing to say does not send an empty prompt).

Pressing the refresh button no longer clears anything explicitly (0004's "explicit refresh drops
the arm" is gone with the arm itself): `refresh` already calls `withReviewPreserved`, so a
manual refresh protects in-progress review activity exactly as the automatic ones do. Losing a
single quote-arm to a refresh was an accepted trade (0004); losing a half-written multi-comment
review to one would not be.

`withReviewPreserved` can only freeze text it can still find in `state.entries`; a `collectEntries`
error blanks `state.entries` entirely (unrelated to review, and true since before this change),
so a review whose entry drops out and later reappears under the same key would otherwise survive
with offsets into text nobody can vouch for any more. `refresh` prunes exactly that case: after
each successful refresh, a `state.review` key with activity whose entry was missing from
`state.entries` as it stood before this refresh is deleted, not carried forward mismatched.

## Consequences

- `docs/decisions/0004-attach-description-as-context.md` is superseded by this note; 0005-0007
  (drag-select mechanics, real-terminal fixes, the removed whole-entry Button) still describe
  facts that hold today — the drag itself, and the display-width handling — only the "arms a
  quote to ride the next prompt" purpose they were written for has changed.
- `claude plugin test`'s kit still has no call for `ui.message` or a way to type into an `Input`
  (unchanged from 0004-0007's own note on this). Every `Review` transition
  (`withSelection`/`withSpanCommitted`/`withSpanRemoved`/`withWholeCommitted`/`withWholeRemoved`/
  `commentCountOf`/`hasUnsentTextOf`/`feedbackTextOf`/`orderedSpansOf`/`shortQuoteOf`) is unit
  tested directly in `review.test.ts`; `withReviewPreserved` and `reviewHeaderOf` are unit tested
  in `mod.test.ts`. Submit's zero-comment refusal is reachable through a real `$.ui.press`
  (covered); its success path, which needs spans no test can seed, is not — the same gap 0007
  already accepted for arming.
- `draft-selection.ts` (draft-pane) and `description-selection.ts` (this plugin) remain two
  separate copies of the same drag module (0003, draft-pane's own ADR); this change did not
  touch either one.
- `state.review` is a plain `Map`, not persisted to the store: a hot reload during development
  drops it exactly as 0006 documented for `state.armed`, only now the loss is a half-written
  review instead of a single quote-arm.
- Not tried in a real terminal as of this note: the comment boxes, the multi-span accumulation
  across both fields, and Submit's actual send. 0006, 0008 and 0013 were all shaped by
  real-terminal feedback the automated gates alone did not catch; this round shipped without
  that pass and should get one before being treated as settled.
