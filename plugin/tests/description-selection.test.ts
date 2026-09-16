// Tests for description-selection.ts's own logic: the pure geometry functions directly, and
// the module's pointer handling through a hand-rolled `ClientSurface` double — no engine
// involved, since nothing here reaches `$`. `claude plugin test plugin`'s kit has no built-in
// way to drive a real `Client` instance's pointer events (checked: no such call on its `Engine`
// or `Mock` types), so this double is this plugin's own, not a kit feature.

import { describe, expect, test } from 'claude-code/testing'

import {
  absoluteOffsetOf,
  clampPos,
  drawDescriptionSelection,
  isEmptyRange,
  orderedRangeOf,
  posOf,
  selectedColumnsOf,
  visualRowsOf,
} from '../hooks/description-selection'

describe('description-selection geometry', () => {
  test('clampPos keeps a position on real text, even past its edges', () => {
    const lines = ['abc', 'de']
    expect(clampPos(lines, { line: 0, col: 0 })).toEqual({ line: 0, col: 0 })
    expect(clampPos(lines, { line: 0, col: 99 })).toEqual({ line: 0, col: 3 })
    expect(clampPos(lines, { line: -1, col: -1 })).toEqual({ line: 0, col: 0 })
    expect(clampPos(lines, { line: 99, col: 1 })).toEqual({ line: 1, col: 1 })
  })

  test('orderedRangeOf puts a backwards drag back in reading order', () => {
    const lines = ['abc', 'de']
    const range = orderedRangeOf(lines, { line: 1, col: 1 }, { line: 0, col: 1 })
    expect(range).toEqual({ start: { line: 0, col: 1 }, end: { line: 1, col: 1 } })
  })

  test('isEmptyRange is true only for a click with no movement', () => {
    expect(isEmptyRange({ start: { line: 0, col: 1 }, end: { line: 0, col: 1 } })).toBe(true)
    expect(isEmptyRange({ start: { line: 0, col: 1 }, end: { line: 0, col: 2 } })).toBe(false)
  })

  test('absoluteOffsetOf matches a plain split(\'\\n\').join(\'\\n\') offset', () => {
    const lines = ['line one', 'line two', 'line three']
    expect(absoluteOffsetOf(lines, { line: 0, col: 0 })).toBe(0)
    expect(absoluteOffsetOf(lines, { line: 1, col: 0 })).toBe('line one'.length + 1)
    expect(absoluteOffsetOf(lines, { line: 2, col: 3 })).toBe('line one\nline two\n'.length + 3)
  })

  test('selectedColumnsOf covers the whole of a line strictly between the range\'s ends', () => {
    const range = { start: { line: 0, col: 2 }, end: { line: 2, col: 1 } }
    expect(selectedColumnsOf(range, 5, 0)).toEqual({ start: 2, end: 5 })
    expect(selectedColumnsOf(range, 5, 1)).toEqual({ start: 0, end: 5 })
    expect(selectedColumnsOf(range, 5, 2)).toEqual({ start: 0, end: 1 })
    expect(selectedColumnsOf(range, 5, 3)).toBeNull()
  })

  test('posOf round-trips absoluteOffsetOf for every position in a 3-line fixture', () => {
    const lines = ['line one', 'line two', 'x']
    for (let line = 0; line < lines.length; line += 1) {
      for (let col = 0; col <= (lines[line]?.length ?? 0); col += 1) {
        const pos = { line, col }
        expect(posOf(lines, absoluteOffsetOf(lines, pos))).toEqual(pos)
      }
    }
  })

  test('visualRowsOf leaves a line alone when it fits, one row with startCol 0', () => {
    expect(visualRowsOf(['abcdef'], 10)).toEqual([{ line: 0, startCol: 0, text: 'abcdef' }])
  })

  test('visualRowsOf wraps on the last space at or before the limit, consuming it', () => {
    expect(visualRowsOf(['abc def ghi'], 7)).toEqual([
      { line: 0, startCol: 0, text: 'abc def' },
      { line: 0, startCol: 8, text: 'ghi' },
    ])
  })

  test('visualRowsOf hard-breaks a word wider than the width with no space to land on', () => {
    expect(visualRowsOf(['abcdefghijkl'], 5)).toEqual([
      { line: 0, startCol: 0, text: 'abcde' },
      { line: 0, startCol: 5, text: 'fghij' },
      { line: 0, startCol: 10, text: 'kl' },
    ])
  })

  test('visualRowsOf keeps an empty logical line as one empty row', () => {
    expect(visualRowsOf([''], 10)).toEqual([{ line: 0, startCol: 0, text: '' }])
  })

  test('visualRowsOf treats non-finite or non-positive columns as no wrapping at all', () => {
    expect(visualRowsOf(['a long line here'], Number.POSITIVE_INFINITY)).toEqual([{ line: 0, startCol: 0, text: 'a long line here' }])
    expect(visualRowsOf(['a long line here'], 0)).toEqual([{ line: 0, startCol: 0, text: 'a long line here' }])
  })

  // Each of these five characters is 2 terminal cells wide, not 1 — a column budget of 6 fits
  // 3 of them (6 cells), not 6 of them, and a pointer's x is a cell count, not a character
  // count. Getting either wrong is exactly what read as "selection doesn't work" for Japanese
  // text (real-terminal feedback).
  test('visualRowsOf wraps by display width, not character count, for wide characters', () => {
    expect(visualRowsOf(['こんにちは'], 6)).toEqual([
      { line: 0, startCol: 0, text: 'こんに' },
      { line: 0, startCol: 3, text: 'ちは' },
    ])
  })

  test('visualRowsOf still makes progress when a single wide character is over budget alone', () => {
    expect(visualRowsOf(['あい'], 1)).toEqual([
      { line: 0, startCol: 0, text: 'あ' },
      { line: 0, startCol: 1, text: 'い' },
    ])
  })
})

type PointerEvent = { type: string; x: number; y: number }

function elementsOf() {
  const Box = (props: { key: string; children?: unknown; flexDirection?: string }) => ({ type: 'Box', props, children: props.children })
  const Text = (props: { children: string; inverse?: boolean }) => ({ type: 'Text', props, children: [props.children] })
  return { Box, Text }
}

// Drives description-selection.ts's own module function the way the engine drives a real
// `Client`: `setState` re-runs it at once with the new state, which re-registers `onPointer`
// with a handler that closes over that fresh state — so a `fire` after a `setState` reaches the
// current drag, not the one the module started with. `claude plugin test plugin`'s kit has
// nothing built in for this (no such call on its Engine or Mock types), so this is this
// plugin's own harness, not a kit feature. `columns` defaults to `Infinity` (no wrapping), same
// as a fixture text short enough to fit ever needs.
function driveDescriptionSelection(lines: readonly string[], armedRange?: { start: number; end: number }, columns = Number.POSITIVE_INFINITY) {
  const elements = elementsOf()
  const posted: unknown[] = []
  let state: unknown
  let handler: ((event: PointerEvent) => void) | null = null
  let tree: unknown

  function draw() {
    tree = drawDescriptionSelection(
      armedRange === undefined ? { lines } : { lines, armedRange },
      {
        elements: elements as never,
        state,
        columns,
        setState: (next: unknown) => {
          state = next
          draw()
        },
        onPointer: (fn: (event: PointerEvent) => void) => {
          handler = fn
          return () => {
            handler = null
          }
        },
        post: (data: unknown) => posted.push(data),
      } as never,
    )
  }

  draw()

  return {
    fire: (event: PointerEvent) => handler?.(event),
    posted,
    tree: () => tree,
  }
}

describe('description-selection pointer handling', () => {
  test('a click with no movement and nothing armed posts nothing', () => {
    const drive = driveDescriptionSelection(['line one', 'line two'])

    drive.fire({ type: 'down', x: 2, y: 0 })
    drive.fire({ type: 'up', x: 2, y: 0 })

    expect(drive.posted).toEqual([])
  })

  test('a click landing inside the armed range posts cleared: this is how a selection is dropped', () => {
    // "line one" is offsets 0-8; armedRange 0..8 covers all of it.
    const drive = driveDescriptionSelection(['line one', 'line two'], { start: 0, end: 8 })

    drive.fire({ type: 'down', x: 2, y: 0 })
    drive.fire({ type: 'up', x: 2, y: 0 })

    expect(drive.posted).toEqual([{ type: 'cleared' }])
  })

  test('a click landing outside the armed range also posts cleared: clicking away drops it too', () => {
    const drive = driveDescriptionSelection(['line one', 'line two'], { start: 0, end: 8 })

    drive.fire({ type: 'down', x: 2, y: 1 })
    drive.fire({ type: 'up', x: 2, y: 1 })

    expect(drive.posted).toEqual([{ type: 'cleared' }])
  })

  test('a real drag posts a new selection even when it starts inside the armed range', () => {
    const drive = driveDescriptionSelection(['line one', 'line two'], { start: 0, end: 8 })

    drive.fire({ type: 'down', x: 0, y: 0 })
    drive.fire({ type: 'move', x: 2, y: 1 })
    drive.fire({ type: 'up', x: 2, y: 1 })

    expect(drive.posted).toEqual([{ type: 'selected', start: 0, end: 11 }])
  })

  test('down, move, up posts the absolute character range the drag covered', () => {
    const drive = driveDescriptionSelection(['line one', 'line two'])

    drive.fire({ type: 'down', x: 5, y: 0 })
    drive.fire({ type: 'move', x: 3, y: 1 })
    drive.fire({ type: 'up', x: 3, y: 1 })

    expect(drive.posted).toEqual([{ type: 'selected', start: 5, end: 12 }])
  })

  // "こんにちは" is 5 characters, each 2 cells wide. A pointer's x is a cell count: x=2 is the
  // start of the 2nd character ('ん'), x=6 the start of the 4th ('ち'). Treating x as a
  // character index instead (the bug) would have posted start:2 (landing mid-string, one
  // character late) and end:5 (clamped past the end), covering "にちは" instead of "んに".
  test('a drag over Japanese text lands on the character under each cell, not one screen row per character', () => {
    const drive = driveDescriptionSelection(['こんにちは'])

    drive.fire({ type: 'down', x: 2, y: 0 })
    drive.fire({ type: 'up', x: 6, y: 0 })

    expect(drive.posted).toEqual([{ type: 'selected', start: 1, end: 3 }])
  })

  test('a drag over Japanese text still maps correctly across a wrap point', () => {
    // At columns:6, "こんにちは" wraps to row 0 "こんに" (startCol 0) and row 1 "ちは" (startCol 3).
    const drive = driveDescriptionSelection(['こんにちは'], undefined, 6)

    drive.fire({ type: 'down', x: 0, y: 1 })
    drive.fire({ type: 'up', x: 2, y: 1 })

    expect(drive.posted).toEqual([{ type: 'selected', start: 3, end: 4 }])
  })

  test('move before any down is a hover, not a drag: nothing posted, no crash', () => {
    const drive = driveDescriptionSelection(['line one'])

    drive.fire({ type: 'move', x: 1, y: 0 })
    drive.fire({ type: 'up', x: 1, y: 0 })

    expect(drive.posted).toEqual([])
  })

  test('a second drag after the first releases starts clean, not continuing the old one', () => {
    const drive = driveDescriptionSelection(['line one', 'line two'])

    drive.fire({ type: 'down', x: 0, y: 0 })
    drive.fire({ type: 'up', x: 4, y: 0 })
    drive.fire({ type: 'down', x: 0, y: 1 })
    drive.fire({ type: 'up', x: 4, y: 1 })

    expect(drive.posted).toEqual([
      { type: 'selected', start: 0, end: 4 },
      { type: 'selected', start: 9, end: 13 },
    ])
  })

  test('an active drag highlights only the covered run on each line', () => {
    const drive = driveDescriptionSelection(['abcdef'])

    drive.fire({ type: 'down', x: 1, y: 0 })
    drive.fire({ type: 'move', x: 3, y: 0 })

    const row = (drive.tree() as { children: { children: { props: { children: string } }[] }[] }).children[0]
    if (row === undefined) throw new Error('expected one row')
    const runs = row.children.map((child) => child.props.children)

    expect(runs).toEqual(['a', 'bc', 'def'])
  })

  test('down with no move yet draws the clicked line as plain text, not a false blank', () => {
    const drive = driveDescriptionSelection(['abcdef'])

    drive.fire({ type: 'down', x: 3, y: 0 })

    const row = drive.tree() as { children: { type: string; props: { children: unknown[] } }[] }
    const line = row.children[0]
    if (line === undefined) throw new Error('expected one row')

    expect(line.type).toBe('Box')
    expect(line.props.children).toEqual([{ type: 'Text', props: { children: 'abcdef' }, children: ['abcdef'] }])
  })

  test('a wrapped line still maps a drag to the right characters, across the wrap point', () => {
    // At columns:7, "abc def ghi" wraps to row 0 "abc def" (startCol 0) and row 1 "ghi" (startCol 8).
    const drive = driveDescriptionSelection(['abc def ghi'], undefined, 7)

    drive.fire({ type: 'down', x: 1, y: 1 })
    drive.fire({ type: 'up', x: 3, y: 1 })

    expect(drive.posted).toEqual([{ type: 'selected', start: 9, end: 11 }])
  })

  test('an already-armed range stays highlighted with no drag in progress', () => {
    const drive = driveDescriptionSelection(['abcdef'], { start: 1, end: 4 })

    const row = (drive.tree() as { children: { children: { props: { children: string } }[] }[] }).children[0]
    if (row === undefined) throw new Error('expected one row')
    const runs = row.children.map((child) => child.props.children)

    expect(runs).toEqual(['a', 'bcd', 'ef'])
  })
})
