// Pure state for one entry's pending review comments: the span just dragged and not yet
// commented on, the committed span comments (each into either the title or the description),
// and the one committed comment on the entry as a whole. No `$`, no hooks — mod.ts is the only
// caller, and builds the feedback prompt's header itself (GitHub's PR/Issue wording is its job,
// not this file's). Must not know about `gh`, GitHub, or how a drag is drawn
// (description-selection.ts).

import type { SelectionMessage } from './description-selection'

export type Field = 'title' | 'description'
export type Selection = { field: Field; start: number; end: number }
export type SpanComment = { field: Field; start: number; end: number; comment: string }
export type ReviewSource = { title: string; body: string }

// `spanText` and `wholeText` mirror what their `Input` holds. Every redraw hands the `Input` its
// `value` again (the engine has no state of its own for it), so without a mirror here a redraw
// triggered by a finished turn or a fresh drag on another entry would hand the `Input` back an
// empty string and silently erase what the person had already typed.
export type Review = {
  selection: Selection | null
  spanText: string
  spans: SpanComment[]
  whole: string | null
  wholeText: string
}

export const EMPTY_REVIEW: Review = { selection: null, spanText: '', spans: [], whole: null, wholeText: '' }

export function withSelection(review: Review, selection: Selection | null): Review {
  return { ...review, selection, spanText: '' }
}

export function withSpanText(review: Review, text: string): Review {
  return { ...review, spanText: text }
}

// No selection: nothing to attach the comment to, so the commit is a no-op. An empty Enter (only
// whitespace) is how the person cancels a drag — it drops the selection and adds nothing, rather
// than committing a blank comment.
export function withSpanCommitted(review: Review, text: string): Review {
  const selection = review.selection
  if (selection === null) return review
  const trimmed = text.trim()
  if (trimmed === '') return { ...review, selection: null, spanText: '' }
  return { ...review, selection: null, spanText: '', spans: [...review.spans, { ...selection, comment: trimmed }] }
}

export function withSpanRemoved(review: Review, index: number): Review {
  if (index < 0 || index >= review.spans.length) return review
  return { ...review, spans: [...review.spans.slice(0, index), ...review.spans.slice(index + 1)] }
}

export function withWholeText(review: Review, text: string): Review {
  return { ...review, wholeText: text }
}

// `whole` holds at most one comment: a second Enter replaces the first rather than adding a
// second. An empty Enter removes it.
export function withWholeCommitted(review: Review, text: string): Review {
  const trimmed = text.trim()
  return { ...review, whole: trimmed === '' ? null : trimmed, wholeText: '' }
}

export function withWholeRemoved(review: Review): Review {
  return { ...review, whole: null }
}

export function commentCountOf(review: Review): number {
  return review.spans.length + (review.whole === null ? 0 : 1)
}

// True while an Input holds text Enter has not yet turned into a span or overall comment — the
// case a Submit press must refuse, or that text would be lost with no word said.
export function hasUnsentTextOf(review: Review): boolean {
  return review.spanText.trim() !== '' || review.wholeText.trim() !== ''
}

// The quote line drawn beside a committed span's comment: the slice collapsed to one line (a
// dragged span can cross a newline) and cut short so a long quote does not crowd out the comment
// beside it.
export function shortQuoteOf(text: string, maxLength = 40): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= maxLength) return collapsed
  return `${collapsed.slice(0, maxLength)}…`
}

function quoteOf(text: string): string {
  return text
    .split('\n')
    .map((line) => '> ' + line)
    .join('\n')
}

export const WHOLE_LABEL = '(overall)'

// The order a Submit press's prompt lists spans in: title spans before description spans, each
// group by ascending `start` — not the order the person committed them in, so a title comment
// added after a description one still reads title-first.
export function orderedSpansOf(spans: readonly SpanComment[]): SpanComment[] {
  return [...spans].sort((a, b) => (a.field === b.field ? a.start - b.start : a.field === 'title' ? -1 : 1))
}

// The prompt one Submit press sends: `header`, then for each span (ordered by `orderedSpansOf`)
// the quoted slice of `source`'s matching field and the comment on its own line, then, when
// `whole` is given, one `(overall) <comment>` line. `header` is the caller's job (mod.ts, which
// alone knows GitHub's PR/Issue wording) — this only slices, quotes, orders and joins.
export function feedbackTextOf(header: string, source: ReviewSource, spans: readonly SpanComment[], whole: string | null): string {
  const lines: string[] = [header]
  for (const span of orderedSpansOf(spans)) {
    const text = (span.field === 'title' ? source.title : source.body).slice(span.start, span.end)
    lines.push(quoteOf(text))
    lines.push(span.comment)
  }
  if (whole !== null) lines.push(`${WHOLE_LABEL} ${whole}`)
  return lines.join('\n')
}

// `data` came from a description-selection.ts Client's post — code sent it, not the engine — so
// this is the one place that message is checked before mod.ts trusts its shape.
export function selectionMessageOf(data: unknown): SelectionMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const type = Reflect.get(data, 'type')
  if (type === 'cleared') return { type: 'cleared' }
  if (type !== 'selected') return null
  const start = Reflect.get(data, 'start')
  const end = Reflect.get(data, 'end')
  if (typeof start !== 'number' || typeof end !== 'number' || start < 0 || end < start) return null
  return { type: 'selected', start, end }
}
