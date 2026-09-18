// Tests for the pure review state in ../hooks/review.ts, run by `claude plugin test plugin`.
// Nothing here reaches the engine: every function here is a plain transformation over a
// `Review` value or a string, the same seam mod.ts's own thin wiring is untestable through
// (see mod.test.ts's "review message handling" describe block for why).

import { describe, expect, test, tier } from 'claude-code/testing'

import {
  EMPTY_REVIEW,
  WHOLE_LABEL,
  commentCountOf,
  feedbackTextOf,
  hasUnsentTextOf,
  orderedSpansOf,
  shortQuoteOf,
  withSelection,
  withSpanCommitted,
  withSpanRemoved,
  withSpanText,
  withWholeCommitted,
  withWholeRemoved,
  withWholeText,
} from '../hooks/review'
import type { Review, SpanComment } from '../hooks/review'

tier('user')

describe('review', () => {
  test('withSelection replaces whatever selection was pending and clears its comment text', () => {
    const withText = withSpanText(EMPTY_REVIEW, 'half-typed')
    const next = withSelection(withText, { field: 'description', start: 0, end: 3 })

    expect(next.selection).toEqual({ field: 'description', start: 0, end: 3 })
    expect(next.spanText).toBe('')

    expect(withSelection(next, null).selection).toBeNull()
  })

  test('withSpanCommitted is a no-op with no pending selection', () => {
    expect(withSpanCommitted(EMPTY_REVIEW, 'a comment')).toBe(EMPTY_REVIEW)
  })

  test('withSpanCommitted adds a span and clears the selection; an empty comment drops the selection instead', () => {
    const withSelected = withSelection(EMPTY_REVIEW, { field: 'title', start: 0, end: 5 })

    const committed = withSpanCommitted(withSelected, '  shorten this  ')
    expect(committed.selection).toBeNull()
    expect(committed.spans).toEqual([{ field: 'title', start: 0, end: 5, comment: 'shorten this' }])

    const dropped = withSpanCommitted(withSelected, '   ')
    expect(dropped.selection).toBeNull()
    expect(dropped.spans).toEqual([])
  })

  test('withSpanRemoved removes by index, ignoring an out-of-range one', () => {
    const spans: SpanComment[] = [
      { field: 'title', start: 0, end: 1, comment: 'a' },
      { field: 'description', start: 2, end: 3, comment: 'b' },
    ]
    const review: Review = { ...EMPTY_REVIEW, spans }

    expect(withSpanRemoved(review, 0).spans).toEqual([spans[1]])
    expect(withSpanRemoved(review, -1)).toBe(review)
    expect(withSpanRemoved(review, 2)).toBe(review)
  })

  test('withWholeCommitted sets, replaces or (given empty text) clears the one overall comment', () => {
    const once = withWholeCommitted(EMPTY_REVIEW, 'looks good overall')
    expect(once.whole).toBe('looks good overall')
    expect(once.wholeText).toBe('')

    const replaced = withWholeCommitted(once, 'actually, one more thing')
    expect(replaced.whole).toBe('actually, one more thing')

    expect(withWholeCommitted(replaced, '  ').whole).toBeNull()
  })

  test('withWholeRemoved clears the overall comment', () => {
    const withWhole: Review = { ...EMPTY_REVIEW, whole: 'a comment' }
    expect(withWholeRemoved(withWhole).whole).toBeNull()
  })

  test('commentCountOf counts every span plus the overall comment, if any', () => {
    expect(commentCountOf(EMPTY_REVIEW)).toBe(0)
    const withSpans: Review = { ...EMPTY_REVIEW, spans: [{ field: 'title', start: 0, end: 1, comment: 'a' }] }
    expect(commentCountOf(withSpans)).toBe(1)
    expect(commentCountOf({ ...withSpans, whole: 'b' })).toBe(2)
  })

  test('hasUnsentTextOf is true while either Input holds unsent text', () => {
    expect(hasUnsentTextOf(EMPTY_REVIEW)).toBe(false)
    expect(hasUnsentTextOf(withSpanText(EMPTY_REVIEW, 'typing'))).toBe(true)
    expect(hasUnsentTextOf(withWholeText(EMPTY_REVIEW, 'typing'))).toBe(true)
    // Whitespace only does not count as unsent — the same trim withSpanCommitted itself applies.
    expect(hasUnsentTextOf(withSpanText(EMPTY_REVIEW, '   '))).toBe(false)
  })

  test('shortQuoteOf collapses whitespace (including a newline a dragged span can cross) and cuts long text', () => {
    expect(shortQuoteOf('one\n  two')).toBe('one two')
    expect(shortQuoteOf('a'.repeat(50))).toBe(`${'a'.repeat(40)}…`)
    expect(shortQuoteOf('short')).toBe('short')
  })

  test('orderedSpansOf sorts title spans before description spans, each by ascending start', () => {
    const spans: SpanComment[] = [
      { field: 'description', start: 5, end: 6, comment: 'd1' },
      { field: 'title', start: 3, end: 4, comment: 't2' },
      { field: 'description', start: 0, end: 1, comment: 'd0' },
      { field: 'title', start: 0, end: 1, comment: 't1' },
    ]

    expect(orderedSpansOf(spans).map((span) => span.comment)).toEqual(['t1', 't2', 'd0', 'd1'])
  })

  test('feedbackTextOf quotes each span from the right field, in order, then the overall comment last', () => {
    const source = { title: 'Add login', body: 'line one\nline two' }
    const spans: SpanComment[] = [
      { field: 'description', start: 0, end: 8, comment: 'why is this here' },
      { field: 'title', start: 0, end: 3, comment: 'spell it out' },
    ]

    const text = feedbackTextOf('Feedback (pull-request-pane) on PR #42:', source, spans, 'looks fine otherwise')

    expect(text).toBe(
      [
        'Feedback (pull-request-pane) on PR #42:',
        '> Add',
        'spell it out',
        '> line one',
        'why is this here',
        `${WHOLE_LABEL} looks fine otherwise`,
      ].join('\n'),
    )
  })

  test('feedbackTextOf quotes a multi-line span one `> ` per line, and omits the overall line when there is none', () => {
    const source = { title: '', body: 'line one\nline two\nline three' }
    const spans: SpanComment[] = [{ field: 'description', start: 0, end: 'line one\nline two'.length, comment: 'both of these' }]

    const text = feedbackTextOf('Feedback (pull-request-pane) on Issue #7:', source, spans, null)

    expect(text).toBe(['Feedback (pull-request-pane) on Issue #7:', '> line one', '> line two', 'both of these'].join('\n'))
  })
})
