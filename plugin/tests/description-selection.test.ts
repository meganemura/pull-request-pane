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
// plugin's own harness, not a kit feature.
function driveDescriptionSelection(lines: readonly string[], armedRange?: { start: number; end: number }) {
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

  test('a click landing outside the armed range posts nothing: it neither drops nor starts one', () => {
    const drive = driveDescriptionSelection(['line one', 'line two'], { start: 0, end: 8 })

    drive.fire({ type: 'down', x: 2, y: 1 })
    drive.fire({ type: 'up', x: 2, y: 1 })

    expect(drive.posted).toEqual([])
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

  test('an already-armed range stays highlighted with no drag in progress', () => {
    const drive = driveDescriptionSelection(['abcdef'], { start: 1, end: 4 })

    const row = (drive.tree() as { children: { children: { props: { children: string } }[] }[] }).children[0]
    if (row === undefined) throw new Error('expected one row')
    const runs = row.children.map((child) => child.props.children)

    expect(runs).toEqual(['a', 'bcd', 'ef'])
  })
})
