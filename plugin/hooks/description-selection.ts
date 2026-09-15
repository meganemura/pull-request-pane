// A `Client` surface module (loaded by the engine from `mod.ts`'s `Client({ module:
// './description-selection.ts' })`, never handed `$`): draws one entry's description and turns
// a mouse drag over it into a character range, posted to the hooks module on release.
//
// No absolute positioning exists on this surface's `Box` (checked: no `position`, `top`,
// `left` or `zIndex` in BoxProps), so this replaces the plain description `Text` lines rather
// than overlaying them — it draws the text itself, highlighted where the drag covers it.
//
// Must NOT know about: GitHub, `gh`, or what the posted range is used for (arming a quote is
// the hooks module's job, driven by what this file posts through `surface.post`).

import type { ClientElements, ClientModule, ClientSurface, RenderElement } from 'claude-code'

export type DescriptionSelectionProps = {
  lines: readonly string[]
}

export type Pos = { line: number; col: number }
export type OrderedRange = { start: Pos; end: Pos }
export type SelectionMessage = { type: 'selected'; start: number; end: number } | { type: 'cleared' }

type State = { anchor: Pos; current: Pos } | null

// A position from a pointer event, or from the drag's own memory, clamped onto real text: a
// line within `lines` (0 when there are none) and a column within that line (its length at
// most, so a click past the end of a short line still lands somewhere real).
export function clampPos(lines: readonly string[], pos: Pos): Pos {
  const line = Math.min(Math.max(pos.line, 0), Math.max(lines.length - 1, 0))
  const col = Math.min(Math.max(pos.col, 0), lines[line]?.length ?? 0)
  return { line, col }
}

function isBefore(a: Pos, b: Pos): boolean {
  return a.line < b.line || (a.line === b.line && a.col < b.col)
}

// The drag's two ends, clamped and put in reading order — a drag that moved up or left of
// where it started is still `start <= end`, so every other function here never sees a
// backwards range.
export function orderedRangeOf(lines: readonly string[], a: Pos, b: Pos): OrderedRange {
  const clampedA = clampPos(lines, a)
  const clampedB = clampPos(lines, b)
  return isBefore(clampedB, clampedA) ? { start: clampedB, end: clampedA } : { start: clampedA, end: clampedB }
}

// A range whose two ends landed on the same cell: a click, not a drag. Posted as `cleared`
// rather than an empty `selected`, so the hooks module never arms a zero-length quote.
export function isEmptyRange(range: OrderedRange): boolean {
  return range.start.line === range.end.line && range.start.col === range.end.col
}

// `pos` as a character offset into the description's lines joined by `\n` — the same shape
// `entry.body` already has, so the hooks module can slice it directly with no line math of
// its own.
export function absoluteOffsetOf(lines: readonly string[], pos: Pos): number {
  let offset = 0
  for (let i = 0; i < pos.line; i += 1) offset += (lines[i]?.length ?? 0) + 1
  return offset + pos.col
}

// The columns of one line a range covers, or null where the range does not reach that line:
// the whole line for one strictly between the range's ends, `[0, range.end.col)` or
// `[range.start.col, length)` for the line the range starts or ends on, both bounds on a
// single-line range.
export function selectedColumnsOf(range: OrderedRange, lineLength: number, lineIndex: number): { start: number; end: number } | null {
  if (lineIndex < range.start.line || lineIndex > range.end.line) return null
  const start = lineIndex === range.start.line ? range.start.col : 0
  const end = lineIndex === range.end.line ? range.end.col : lineLength
  return { start, end }
}

// One row: plain text, or split into an unhighlighted prefix, an inverse-video run for the
// drag's coverage of this line, and an unhighlighted suffix. A run drawn from an empty string
// (a fully covered blank line, or a click at a line's very end) becomes one space, so the
// highlight is still visible instead of a zero-width gap.
function lineRowOf(elements: ClientElements, key: string, text: string, columns: { start: number; end: number } | null): RenderElement {
  const { Box, Text } = elements
  if (columns === null) {
    return Box({ key, children: [Text({ children: text === '' ? ' ' : text })] })
  }
  const before = text.slice(0, columns.start)
  const selected = text.slice(columns.start, columns.end)
  const after = text.slice(columns.end)
  const children: RenderElement[] = []
  if (before !== '') children.push(Text({ children: before }))
  children.push(Text({ inverse: true, children: selected === '' ? ' ' : selected }))
  if (after !== '') children.push(Text({ children: after }))
  return Box({ key, flexDirection: 'row', children })
}

// The pointer handler: 'down' starts a drag at the cell under the pointer, 'move' extends it
// (ignored before a 'down' started one — a hover with no button held), 'up' posts what the
// drag covered and ends it. Registered fresh on every call, which is how each render's
// `state` reaches the closure without a stale one from an earlier call.
function onPointerOf(lines: readonly string[], state: State, setState: (next: State) => void, post: (data: SelectionMessage) => void) {
  return (event: { type: string; x: number; y: number }) => {
    if (event.type === 'down') {
      const pos = clampPos(lines, { line: event.y, col: event.x })
      setState({ anchor: pos, current: pos })
      return
    }
    if (event.type === 'move') {
      if (state === null) return
      const pos = clampPos(lines, { line: event.y, col: event.x })
      setState({ anchor: state.anchor, current: pos })
      return
    }
    if (event.type === 'up') {
      if (state === null) return
      // The 'up' event carries its own cell, same as 'down' and 'move' do — read it directly
      // rather than trusting a 'move' to have landed there first. A drag with no 'move' in
      // between (a fast release, or a terminal that only sends 'move' on real movement) would
      // otherwise end up comparing the anchor to itself and reporting an empty range.
      const pos = clampPos(lines, { line: event.y, col: event.x })
      const range = orderedRangeOf(lines, state.anchor, pos)
      if (isEmptyRange(range)) {
        post({ type: 'cleared' })
      } else {
        post({ type: 'selected', start: absoluteOffsetOf(lines, range.start), end: absoluteOffsetOf(lines, range.end) })
      }
      setState(null)
    }
  }
}

// `surface` is the real `ClientSurface` from the engine, or (in a test) any object shaped
// like one — the module never reaches for anything else on it.
export function drawDescriptionSelection(props: DescriptionSelectionProps, surface: Pick<ClientSurface<State>, 'elements' | 'state' | 'setState' | 'onPointer' | 'post'>): RenderElement {
  const { elements, state, setState, onPointer, post } = surface
  const lines = props.lines

  onPointer(onPointerOf(lines, state ?? null, setState, (data) => post(data)))

  const range = state == null ? null : orderedRangeOf(lines, state.anchor, state.current)
  const { Box } = elements
  return Box({
    key: 'root',
    flexDirection: 'column',
    children: lines.map((line, index) => lineRowOf(elements, `line:${index}`, line, range === null ? null : selectedColumnsOf(range, line.length, index))),
  })
}

const DescriptionSelection: ClientModule<DescriptionSelectionProps, State> = (props, surface) => drawDescriptionSelection(props, surface)

export default DescriptionSelection
