// Tests for the plugin's function-hooks module, run by `claude plugin test plugin` with
// `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. The kit loads the module as the engine does and hands
// each test the engine's own `$`; the hooks a test registers with `on` sit beneath the module,
// where `git`, `gh` and the terminal would be. Nothing here spawns a real process: `process.run`
// answers from a script keyed on the argument vector, so what is tested is what the module asks
// `gh` for and what it draws and fills, never what a real `gh` prints.

import type { CommandRunInput, On, RenderInput, SessionMessage } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

import { contextTextOf, fittedContextTextOf, nextArmedOf, selectionMessageOf, statusForArmedOf, withArmedPreserved } from '../hooks/mod'

tier('user')

const PLUGIN = 'pull-request-pane'
const COMMAND = 'pull-request-pane'

const SESSION = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const

const PANE: RenderInput<'Pane'> = {
  component: 'Pane',
  surface: 'terminal',
  requestId: PLUGIN,
  viewport: { columns: 120, rows: 40 },
  props: { title: PLUGIN, isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
}

const RUN: CommandRunInput = { command: COMMAND, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }

const POLL_MS = 60_000
const STATUS_JSON_FIELDS = 'isDraft,mergeable,reviewDecision,statusCheckRollup'

type GhRecord = { number: number; title: string; body: string; url: string; state: string }
type GhStatusRecord = { isDraft: boolean; mergeable: string; reviewDecision: string; statusCheckRollup: unknown[] }

type WorldOptions = {
  branch?: string | null
  repo?: string
  branchPrs?: GhRecord[]
  issues?: Record<number, GhRecord>
  prs?: Record<number, GhRecord>
  statuses?: Record<number, GhStatusRecord>
  messages?: SessionMessage[]
  // Seeds `$.store` before `session.start` runs, so a test can simulate a hot reload: the
  // module's own in-memory `state` is gone, but this (a real store's persistence) is not.
  store?: Record<string, unknown>
}

// The world beneath the module: a checkout on `branch` (or none, when `branch` is null), a
// `gh` that answers from the fixtures given, and a terminal that keeps what was opened, closed,
// logged and told as a status line.
function world(on: On, options: WorldOptions = {}) {
  const runs: (readonly string[])[] = []
  const opened: string[] = []
  const closed: string[] = []
  const logged: string[] = []
  const statuses: (string | undefined)[] = []
  const clock = mock.clock(on)

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.messages', () => ({ value: options.messages ?? [] }))

  on('process.run', ($, e) => {
    runs.push(e.argv)
    const [cmd, ...rest] = e.argv

    if (cmd === 'git' && rest[0] === 'rev-parse') {
      if (options.branch === null) return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' } }
      return { value: { exitCode: 0, stdout: `${options.branch ?? 'main'}\n`, stderr: '' } }
    }

    if (cmd === 'gh' && rest[0] === 'repo' && rest[1] === 'view') {
      return { value: { exitCode: 0, stdout: `${options.repo ?? 'acme/app'}\n`, stderr: '' } }
    }

    if (cmd === 'gh' && rest[0] === 'pr' && rest[1] === 'list') {
      return { value: { exitCode: 0, stdout: JSON.stringify(options.branchPrs ?? []), stderr: '' } }
    }

    if (cmd === 'gh' && rest[0] === 'issue' && rest[1] === 'view') {
      const record = options.issues?.[Number(rest[2])]
      return record
        ? { value: { exitCode: 0, stdout: JSON.stringify(record), stderr: '' } }
        : { value: { exitCode: 1, stdout: '', stderr: 'no such issue' } }
    }

    if (cmd === 'gh' && rest[0] === 'pr' && rest[1] === 'view' && rest.includes(STATUS_JSON_FIELDS)) {
      const record = options.statuses?.[Number(rest[2])]
      return record
        ? { value: { exitCode: 0, stdout: JSON.stringify(record), stderr: '' } }
        : { value: { exitCode: 1, stdout: '', stderr: 'no such pull request' } }
    }

    if (cmd === 'gh' && rest[0] === 'pr' && rest[1] === 'view') {
      const record = options.prs?.[Number(rest[2])]
      return record
        ? { value: { exitCode: 0, stdout: JSON.stringify(record), stderr: '' } }
        : { value: { exitCode: 1, stdout: '', stderr: 'no such pull request' } }
    }

    return { value: { exitCode: 1, stdout: '', stderr: 'unexpected command' } }
  })

  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: undefined }
  })
  on('ui.close', ($, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.log', ($, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })

  const store = new Map<string, unknown>(Object.entries(options.store ?? {}))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })

  return { runs, opened, closed, logged, statuses, clock, store }
}

// The strings a drawn tree carries: a Text's joined children, a Button's label.
function textOf(tree: unknown): string {
  if (Array.isArray(tree)) return tree.map(textOf).join('\n')
  if (typeof tree !== 'object' || tree === null) return ''
  const type: unknown = Reflect.get(tree, 'type')
  const props: unknown = Reflect.get(tree, 'props')
  const children: unknown = Reflect.get(tree, 'children')
  if (type === 'Text') {
    return (Array.isArray(children) ? children : []).filter((child): child is string => typeof child === 'string').join('')
  }
  if (type === 'Button') {
    const label = typeof props === 'object' && props ? Reflect.get(props, 'label') : undefined
    return typeof label === 'string' ? label : ''
  }
  return textOf(children)
}

// Every Text node in a drawn tree, each with the colour it set (absent when it set none) and
// its hover colour (absent the same way).
function coloredLinesOf(tree: unknown): { text: string; color?: string; hoverColor?: string }[] {
  if (Array.isArray(tree)) return tree.flatMap(coloredLinesOf)
  if (typeof tree !== 'object' || tree === null) return []
  const type: unknown = Reflect.get(tree, 'type')
  const props: unknown = Reflect.get(tree, 'props')
  const children: unknown = Reflect.get(tree, 'children')
  if (type === 'Text') {
    const text = (Array.isArray(children) ? children : []).filter((child): child is string => typeof child === 'string').join('')
    const color = typeof props === 'object' && props ? Reflect.get(props, 'color') : undefined
    // `hover` sits beside `props`, not inside it (measured: dumped a tree and read the shape).
    const hover = Reflect.get(tree, 'hover')
    const hoverColor = typeof hover === 'object' && hover ? Reflect.get(hover, 'color') : undefined
    return [{ text, ...(typeof color === 'string' ? { color } : {}), ...(typeof hoverColor === 'string' ? { hoverColor } : {}) }]
  }
  return coloredLinesOf(children)
}

// Every Link in a drawn tree: where it goes, and the text inside it.
function linksOf(tree: unknown): { href: string; text: string }[] {
  if (Array.isArray(tree)) return tree.flatMap(linksOf)
  if (typeof tree !== 'object' || tree === null) return []
  const type: unknown = Reflect.get(tree, 'type')
  const props: unknown = Reflect.get(tree, 'props')
  const children: unknown = Reflect.get(tree, 'children')
  if (type === 'Link') {
    const href = typeof props === 'object' && props ? Reflect.get(props, 'href') : undefined
    return [{ href: typeof href === 'string' ? href : '', text: textOf(children) }]
  }
  return linksOf(children)
}

// The `props` of a `Client` leaf keyed `key`, or undefined when there is none: a `Client`'s own
// drawing is opaque to `textOf` (the engine loads and runs its surface module separately, never
// through this render), so a test that cares what the Client would draw reads its props here
// instead of walking rendered text.
function clientPropsOf(tree: unknown, key: string): unknown {
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const found = clientPropsOf(child, key)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof tree !== 'object' || tree === null) return undefined
  const type: unknown = Reflect.get(tree, 'type')
  const props: unknown = Reflect.get(tree, 'props')
  if (type === 'Client' && typeof props === 'object' && props !== null && Reflect.get(props, 'key') === key) {
    return Reflect.get(props, 'props')
  }
  const children: unknown = Reflect.get(tree, 'children')
  return clientPropsOf(children, key)
}

// A Button's `onPress` is not awaited by `$.ui.press`; it finishes after a few turns of the
// task queue. `setTimeout` is reached through the global object, as the module names no host
// globals of its own.
async function settle(): Promise<void> {
  const later = (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown }).setTimeout
  for (let i = 0; i < 8; i += 1) await new Promise<void>((resolve) => later(resolve, 0))
}

describe('mod', () => {
  test('outside a git repository, /pull-request-pane says so and opens nothing', async ($, on) => {
    const kept = world(on, { branch: null })
    await $.session.start(SESSION)

    const { text } = await $.command.run(RUN)

    expect(text).toBe('not in a GitHub repository')
    expect(kept.opened).toEqual([])
  })

  test('a pull request on the branch appears in the rendered pane', async ($, on) => {
    world(on, {
      branch: 'feature',
      repo: 'acme/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'na', url: 'https://github.com/acme/app/pull/42', state: 'OPEN' }],
    })
    await $.session.start(SESSION)
    await $.command.run(RUN)

    const tree = await $.ui.render(PANE)

    expect(textOf(tree)).toContain('#42')
    // The identifier line is a Link to the pull request itself.
    expect(linksOf(tree)).toEqual([{ href: 'https://github.com/acme/app/pull/42', text: '#42 PR OPEN' }])
    // The title is drawn by its own textSelectionOf row (a Client, opaque to textOf), not the
    // Button's label — see docs/decisions/0006.
    expect(clientPropsOf(tree, 'pr:42:title-select')).toEqual({ lines: ['Add login'] })
  })

  test('the whole description is drawn, not cut to a few lines', async ($, on) => {
    const body = ['line one', 'line two', 'line three', 'line four', 'line five'].join('\n')
    world(on, {
      branch: 'feature',
      repo: 'acme/app',
      branchPrs: [{ number: 42, title: 'Add login', body, url: 'https://github.com/acme/app/pull/42', state: 'OPEN' }],
    })
    await $.session.start(SESSION)
    await $.command.run(RUN)

    const props = clientPropsOf(await $.ui.render(PANE), 'pr:42:body-select')

    expect(props).toEqual({ lines: ['line one', 'line two', 'line three', 'line four', 'line five'] })
  })

  test('a closing keyword in the PR body pulls in the issue it closes', async ($, on) => {
    world(on, {
      branch: 'feature',
      repo: 'acme/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'Closes #12', url: 'https://github.com/acme/app/pull/42', state: 'OPEN' }],
      issues: { 12: { number: 12, title: 'Login is broken', body: 'na', url: 'https://github.com/acme/app/issues/12', state: 'OPEN' } },
    })
    await $.session.start(SESSION)
    await $.command.run(RUN)

    const tree = await $.ui.render(PANE)

    expect(textOf(tree)).toContain('#12')
    expect(clientPropsOf(tree, 'issue:12:title-select')).toEqual({ lines: ['Login is broken'] })
  })

  // There is no button to press any more (docs/decisions/0007): every arm is a drag over a
  // title or description Client, and `claude plugin test`'s kit has no call for `ui.message`
  // (checked: not in EventCalls['ui'], only `render`, `resolve`, `scroll` and `focus` are — a
  // Client's post reaches the hooks module only through the real engine). So the whole arming
  // path — `selectionMessageOf` validating a post, `nextArmedOf` deciding what it does to what
  // is armed, `withArmedPreserved` and `pollStatuses` around a refresh, `contextTextOf` and
  // `fittedContextTextOf` building and fitting what rides the prompt — is covered here as the
  // plain functions it is built from, not end to end; `on('ui.message', ...)` and
  // `on('prompt.submit', ...)` in mod.ts are the thin, unavoidably untested wiring between them
  // and `state`/`host`.
  describe('description-selection message handling', () => {
    test('selectionMessageOf accepts a valid selected or cleared message, rejects the rest', () => {
      expect(selectionMessageOf({ type: 'selected', start: 0, end: 5 })).toEqual({ type: 'selected', start: 0, end: 5 })
      expect(selectionMessageOf({ type: 'cleared' })).toEqual({ type: 'cleared' })
      expect(selectionMessageOf({ type: 'selected', start: 5, end: 2 })).toBeNull()
      expect(selectionMessageOf({ type: 'selected', start: -1, end: 2 })).toBeNull()
      expect(selectionMessageOf({ type: 'selected', start: '0', end: 2 })).toBeNull()
      expect(selectionMessageOf({ type: 'unknown' })).toBeNull()
      expect(selectionMessageOf(null)).toBeNull()
      expect(selectionMessageOf('not an object')).toBeNull()
    })

    test('nextArmedOf: selected arms this entry and field, replacing whatever was armed', () => {
      const entryA = { kind: 'pr' as const, number: 1, title: '', body: '', url: '', state: 'OPEN' }
      const entryB = { kind: 'pr' as const, number: 2, title: '', body: '', url: '', state: 'OPEN' }
      const armedA = nextArmedOf(null, entryA, 'description', { type: 'selected', start: 0, end: 3 })

      expect(armedA).toEqual({ entry: entryA, field: 'description', range: { start: 0, end: 3 } })
      expect(nextArmedOf(armedA, entryB, 'title', { type: 'selected', start: 1, end: 2 })).toEqual({ entry: entryB, field: 'title', range: { start: 1, end: 2 } })
    })

    test('nextArmedOf: cleared drops only a selection armed on that same entry and field', () => {
      const entryA = { kind: 'pr' as const, number: 1, title: '', body: '', url: '', state: 'OPEN' }
      const entryB = { kind: 'pr' as const, number: 2, title: '', body: '', url: '', state: 'OPEN' }
      const armedA = { entry: entryA, field: 'description' as const, range: { start: 0, end: 3 } }

      expect(nextArmedOf(armedA, entryA, 'description', { type: 'cleared' })).toBeNull()
      expect(nextArmedOf(armedA, entryA, 'title', { type: 'cleared' })).toBe(armedA)
      expect(nextArmedOf(armedA, entryB, 'description', { type: 'cleared' })).toBe(armedA)
      expect(nextArmedOf(null, entryA, 'description', { type: 'cleared' })).toBeNull()
    })

    test('statusForArmedOf names the field being armed', () => {
      const entry = { kind: 'pr' as const, number: 42, title: '', body: '', url: '', state: 'OPEN' }

      expect(statusForArmedOf({ entry, field: 'description', range: { start: 0, end: 3 } })).toBe(
        "#42's description selection rides your next prompt (click it again to drop it)",
      )
      expect(statusForArmedOf({ entry, field: 'title', range: { start: 0, end: 3 } })).toBe("#42's title selection rides your next prompt (click it again to drop it)")
    })

    test('contextTextOf quotes only the range, from the title or the description as asked', () => {
      const entry = { kind: 'pr' as const, number: 42, title: 'Add login', body: 'line one\nline two', url: 'https://github.com/acme/app/pull/42', state: 'OPEN' }

      expect(contextTextOf(entry, 'acme/app', 'description', { start: 0, end: 8 })).toBe(
        "The user attached a selection from acme/app pull request #42's description from pull-request-pane to this prompt. " +
          'Edit it on GitHub with `gh pr edit 42 --body`:\n> line one',
      )
      expect(contextTextOf(entry, 'acme/app', 'title', { start: 0, end: entry.title.length })).toBe(
        "The user attached a selection from acme/app pull request #42's title from pull-request-pane to this prompt. " +
          'Edit it on GitHub with `gh pr edit 42 --title`:\n> Add login',
      )
    })

    test('fittedContextTextOf keeps whole lines up to room, cuts with a note, or drops entirely', () => {
      expect(fittedContextTextOf('short', 100)).toBe('short')
      // Not even the note fits alongside a first line: dropped entirely, not a note with no body.
      expect(fittedContextTextOf('a'.repeat(50), 10)).toBeUndefined()

      const cutNote = '(The rest of this description was cut: it did not fit in the prompt.)'
      // 10 ten-character lines: long enough that the note plus two of them is still less than
      // the whole text, so the room actually forces a cut instead of fitting everything.
      const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`.padEnd(10, ' '))
      const text = lines.join('\n')
      const room = cutNote.length + 11 + 11 // two 10-character lines, each plus its '\n'
      expect(fittedContextTextOf(text, room)).toBe(`${lines[0]}\n${lines[1]}\n${cutNote}`)
    })

    test('withArmedPreserved keeps the armed entry\'s own object, lets every other one refresh', () => {
      const armedEntry = { kind: 'pr' as const, number: 1, title: 'old title', body: 'old body', url: '', state: 'OPEN' }
      const otherEntry = { kind: 'pr' as const, number: 2, title: 'other', body: 'other body', url: '', state: 'OPEN' }
      const state = { armed: { entry: armedEntry, field: 'description' as const, range: { start: 0, end: 3 } }, entries: [armedEntry, otherEntry] }

      const fresh = [
        { kind: 'pr' as const, number: 1, title: 'NEW title', body: 'NEW body', url: '', state: 'OPEN' },
        { kind: 'pr' as const, number: 2, title: 'other', body: 'fresher other body', url: '', state: 'OPEN' },
      ]

      const result = withArmedPreserved(state, fresh)

      expect(result[0]).toBe(armedEntry)
      expect(result[1]).toBe(fresh[1])
    })

    test('withArmedPreserved is a no-op when nothing is armed', () => {
      const entries = [{ kind: 'pr' as const, number: 1, title: 't', body: 'b', url: '', state: 'OPEN' }]
      expect(withArmedPreserved({ armed: null, entries: [] }, entries)).toBe(entries)
    })
  })

  test('rendering the pane never spawns', async ($, on) => {
    const kept = world(on, {
      branch: 'feature',
      repo: 'acme/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'na', url: 'https://github.com/acme/app/pull/42', state: 'OPEN' }],
    })
    await $.session.start(SESSION)
    await $.command.run(RUN)
    await settle()
    const before = kept.runs.length

    await $.ui.render(PANE)

    expect(kept.runs.length).toBe(before)
  })

  test('opening the pane starts a 60s status poll that draws the checks', async ($, on) => {
    const kept = world(on, {
      branch: 'feature',
      repo: 'acme/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'na', url: 'https://github.com/acme/app/pull/42', state: 'OPEN' }],
      statuses: {
        42: {
          isDraft: false,
          mergeable: 'MERGEABLE',
          reviewDecision: 'APPROVED',
          statusCheckRollup: [
            { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'deploy-check', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/app/actions/runs/1/job/2' },
            { name: 'e2e', status: 'IN_PROGRESS', conclusion: null },
            { name: 'docs', status: 'IN_PROGRESS', conclusion: null },
          ],
        },
      },
    })
    await $.session.start(SESSION)
    await $.command.run(RUN)
    await settle()

    const statusCallsAfterOpen = kept.runs.filter((argv) => argv.includes(STATUS_JSON_FIELDS))
    expect(statusCallsAfterOpen).toHaveLength(1)

    await kept.clock.advance(POLL_MS)

    const statusCalls = kept.runs.filter((argv) => argv.includes(STATUS_JSON_FIELDS))
    expect(statusCalls).toHaveLength(2)

    const collapsed = textOf(await $.ui.render(PANE))
    expect(collapsed).toContain('▶ checks')
    expect(collapsed).toContain('failing')
    expect(collapsed).not.toContain('✓3 ✗1 …2 · APPROVED · MERGEABLE')

    await $.ui.press({ plugin: PLUGIN, key: 'pr:42:checks-toggle:button' })

    const expanded = textOf(await $.ui.render(PANE))
    expect(expanded).toContain('▼ checks')
    expect(expanded).toContain('✓3 ✗1 …2 · APPROVED · MERGEABLE')
    expect(expanded).toContain('deploy-check')
    expect(expanded).toContain('lint')
    expect(expanded).toContain('e2e')
  })

  test('each check keeps its own colour; the summary line and the failing check do not share one', async ($, on) => {
    const kept = world(on, {
      branch: 'feature',
      repo: 'acme/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'na', url: 'https://github.com/acme/app/pull/42', state: 'OPEN' }],
      statuses: {
        42: {
          isDraft: false,
          mergeable: 'MERGEABLE',
          reviewDecision: 'APPROVED',
          statusCheckRollup: [
            { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'deploy-check', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/app/actions/runs/1/job/2' },
          ],
        },
      },
    })
    await $.session.start(SESSION)
    await $.command.run(RUN)
    await settle()
    await $.ui.render(PANE)
    await $.ui.press({ plugin: PLUGIN, key: 'pr:42:checks-toggle:button' })

    const tree = await $.ui.render(PANE)
    const lines = coloredLinesOf(tree)

    // The symbol carries the outcome's colour; the name stays plain so a hover's colour is the
    // only colour change a linked check ever shows (see docs/decisions/0003's revision).
    expect(lines.find((line) => line.text.includes('MERGEABLE'))).toEqual({ text: expect.stringContaining('MERGEABLE') })
    expect(lines.find((line) => line.text === '✓')).toEqual({ text: '✓', color: 'green' })
    expect(lines.find((line) => line.text === ' lint')).toEqual({ text: ' lint' })
    expect(lines.find((line) => line.text === '✗')).toEqual({ text: '✗', color: 'red' })
    expect(lines.find((line) => line.text === ' deploy-check')).toEqual({ text: ' deploy-check', hoverColor: 'cyan' })

    const links = linksOf(tree)
    expect(links).toEqual([
      { href: 'https://github.com/acme/app/pull/42', text: '#42 PR OPEN' },
      { href: 'https://github.com/acme/app/actions/runs/1/job/2', text: '✗\n deploy-check' },
    ])
  })

  test('closing the pane stops the poll', async ($, on) => {
    const kept = world(on, {
      branch: 'feature',
      repo: 'acme/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'na', url: 'https://github.com/acme/app/pull/42', state: 'OPEN' }],
      statuses: { 42: { isDraft: false, mergeable: 'MERGEABLE', reviewDecision: '', statusCheckRollup: [] } },
    })
    await $.session.start(SESSION)
    await $.command.run(RUN)
    await kept.clock.advance(POLL_MS)
    const before = kept.runs.filter((argv) => argv.includes(STATUS_JSON_FIELDS)).length

    await $.command.run(RUN)
    await kept.clock.advance(POLL_MS)

    const after = kept.runs.filter((argv) => argv.includes(STATUS_JSON_FIELDS)).length
    expect(after).toBe(before)
  })

  test('a hot reload rehydrates from the store instead of showing reading…', async ($, on) => {
    world(on, {
      branch: 'feature',
      repo: 'acme/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'na', url: 'https://github.com/acme/app/pull/42', state: 'OPEN' }],
    })
    await $.session.start(SESSION)
    await $.command.run(RUN)
    await settle()

    // A hot reload drops this module's own in-memory `state` (a fresh `register` runs), but not
    // the store: a second `session.start`, with no `command.run` yet, simulates that.
    await $.session.start(SESSION)
    const text = textOf(await $.ui.render(PANE))

    expect(text).not.toContain('reading…')
    expect(text).toContain('refreshed')
    expect(text).toContain('#42')
  })

})
