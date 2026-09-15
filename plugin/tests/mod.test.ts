// Tests for the plugin's function-hooks module, run by `claude plugin test plugin` with
// `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. The kit loads the module as the engine does and hands
// each test the engine's own `$`; the hooks a test registers with `on` sit beneath the module,
// where `git`, `gh` and the terminal would be. Nothing here spawns a real process: `process.run`
// answers from a script keyed on the argument vector, so what is tested is what the module asks
// `gh` for and what it draws and fills, never what a real `gh` prints.

import type { CommandRunInput, On, PromptSubmitInput, RenderInput, SessionMessage } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

import { contextTextOf, nextArmedOf, selectionMessageOf, statusForArmedOf } from '../hooks/mod'

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

// A prompt as the person submits it from the composer with a plain Enter, carrying the context
// given, if any — the shape `$.prompt.submit` takes as a test drives it, matching `mods/diff`'s
// own fixture for the same call.
function typedPromptOf(text: string, context?: readonly string[]): PromptSubmitInput {
  return { text, ...(context ? { context } : {}), wait: false, origin: { kind: 'composer' } }
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

  test('pressing a Button arms the entry; the next prompt submitted carries its description as context, never the box', async ($, on) => {
    const kept = world(on, {
      branch: 'feature',
      repo: 'acme/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'line one\nline two', url: 'https://github.com/acme/app/pull/42', state: 'OPEN' }],
    })
    on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))

    await $.session.start(SESSION)
    await $.command.run(RUN)
    await $.ui.render(PANE)
    await $.ui.press({ plugin: PLUGIN, key: 'pr:42:button' })
    await settle()

    expect(kept.statuses.at(-1)).toBe('#42 rides your next prompt (press it again to drop it)')
    expect(textOf(await $.ui.render(PANE))).toContain('(armed)')

    const submitted = await $.prompt.submit(typedPromptOf('tighten the wording'))

    expect(submitted).toMatchObject({
      text: 'tighten the wording',
      context: [
        "The user attached acme/app pull request #42's description from pull-request-pane to " +
          'this prompt. Edit it on GitHub with `gh pr edit 42 --body`:\n> line one\n> line two',
      ],
    })
    expect(kept.statuses.at(-1)).toBeUndefined()
    expect(textOf(await $.ui.render(PANE))).not.toContain('(armed)')
  })

  test('pressing an armed entry again drops it before any prompt carries it', async ($, on) => {
    const kept = world(on, {
      branch: 'feature',
      repo: 'acme/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'na', url: 'https://github.com/acme/app/pull/42', state: 'OPEN' }],
    })
    const reached: (readonly string[] | undefined)[] = []
    on('prompt.submit', ($, e) => {
      reached.push(e.context)
      return { text: e.text }
    })

    await $.session.start(SESSION)
    await $.command.run(RUN)
    await $.ui.render(PANE)
    await $.ui.press({ plugin: PLUGIN, key: 'pr:42:button' })
    await settle()
    // A redraw between the two presses, exactly as `host.invalidate()` causes in a real
    // terminal: `$.ui.press` acts on the tree from the last `ui.render`, so its onPress
    // closures are stale until this call picks up the pane's new armed state.
    await $.ui.render(PANE)
    await $.ui.press({ plugin: PLUGIN, key: 'pr:42:button' })
    await settle()

    expect(kept.statuses.at(-1)).toBeUndefined()
    expect(textOf(await $.ui.render(PANE))).not.toContain('(armed)')

    await $.prompt.submit(typedPromptOf('unrelated'))

    expect(reached).toEqual([undefined])
  })

  test('an armed description with no room in the context is dropped, not truncated silently', async ($, on) => {
    const kept = world(on, {
      branch: 'feature',
      repo: 'acme/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'na', url: 'https://github.com/acme/app/pull/42', state: 'OPEN' }],
    })
    const full = 'x'.repeat(32_000)
    on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))

    await $.session.start(SESSION)
    await $.command.run(RUN)
    await $.ui.render(PANE)
    await $.ui.press({ plugin: PLUGIN, key: 'pr:42:button' })
    await settle()

    await $.prompt.submit(typedPromptOf('why?', [full]))

    expect(kept.statuses.at(-1)).toBe("#42's description did not fit in the prompt and was dropped")
    expect(textOf(await $.ui.render(PANE))).not.toContain('(armed)')
  })

  // `claude plugin test`'s kit has no call for `ui.message` (checked: it is not in
  // EventCalls['ui'], only `render`, `resolve`, `scroll` and `focus` are — a Client's post
  // reaches the hooks module only through the real engine, never through a test's `$`). What
  // the `on('ui.message', ...)` hook in mod.ts does with a post is covered here as the plain
  // functions it is built from instead: `selectionMessageOf` validates the untrusted `data`,
  // `nextArmedOf` decides what a validated message does to what is armed, and
  // `statusForArmedOf`/`contextTextOf` cover the two wordings a whole-entry arm and a
  // range arm produce. The hook itself is the thin, unavoidably untested wiring between them
  // and `state`/`host` — see docs/decisions/0004's revision for this note in full.
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

    test('statusForArmedOf names the field for a range arm, and says how each kind is dropped', () => {
      const entry = { kind: 'pr' as const, number: 42, title: '', body: '', url: '', state: 'OPEN' }

      expect(statusForArmedOf({ entry, field: 'description' })).toBe('#42 rides your next prompt (press it again to drop it)')
      expect(statusForArmedOf({ entry, field: 'description', range: { start: 0, end: 3 } })).toBe(
        "#42's description selection rides your next prompt (click it again to drop it)",
      )
      expect(statusForArmedOf({ entry, field: 'title', range: { start: 0, end: 3 } })).toBe("#42's title selection rides your next prompt (click it again to drop it)")
    })

    test('contextTextOf quotes only the range when one is given, and the title when asked for it', () => {
      const entry = { kind: 'pr' as const, number: 42, title: 'Add login', body: 'line one\nline two', url: 'https://github.com/acme/app/pull/42', state: 'OPEN' }

      expect(contextTextOf(entry, 'acme/app', 'description')).toBe(
        "The user attached acme/app pull request #42's description from pull-request-pane to this prompt. " +
          'Edit it on GitHub with `gh pr edit 42 --body`:\n> line one\n> line two',
      )
      expect(contextTextOf(entry, 'acme/app', 'description', { start: 0, end: 8 })).toBe(
        "The user attached a selection from acme/app pull request #42's description from pull-request-pane to this prompt. " +
          'Edit it on GitHub with `gh pr edit 42 --body`:\n> line one',
      )
      expect(contextTextOf(entry, 'acme/app', 'title')).toBe(
        "The user attached acme/app pull request #42's title from pull-request-pane to this prompt. " +
          'Edit it on GitHub with `gh pr edit 42 --title`:\n> Add login',
      )
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
    expect(links).toEqual([{ href: 'https://github.com/acme/app/actions/runs/1/job/2', text: '✗\n deploy-check' }])
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

  test('an armed entry keeps its own text through a refresh, even if gh now answers differently', async ($, on) => {
    const options: WorldOptions = {
      branch: 'feature',
      repo: 'acme/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'original body', url: 'https://github.com/acme/app/pull/42', state: 'OPEN' }],
    }
    world(on, options)
    await $.session.start(SESSION)
    await $.command.run(RUN)
    await $.ui.render(PANE)
    await $.ui.press({ plugin: PLUGIN, key: 'pr:42:button' })
    await settle()

    // As if the description changed on GitHub (or gh just answered a fresh fetch) while armed.
    options.branchPrs = [{ number: 42, title: 'Add login', body: 'a different body entirely', url: 'https://github.com/acme/app/pull/42', state: 'OPEN' }]
    await $.command.run(RUN)
    await $.command.run(RUN)

    const props = clientPropsOf(await $.ui.render(PANE), 'pr:42:body-select')
    expect(props).toEqual({ lines: ['original body'] })
  })

  test('the status poll keeps updating an armed entry, without disarming it', async ($, on) => {
    const kept = world(on, {
      branch: 'feature',
      repo: 'acme/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'na', url: 'https://github.com/acme/app/pull/42', state: 'OPEN' }],
      statuses: { 42: { isDraft: false, mergeable: 'MERGEABLE', reviewDecision: '', statusCheckRollup: [] } },
    })
    await $.session.start(SESSION)
    await $.command.run(RUN)
    await settle()
    await $.ui.render(PANE)
    await $.ui.press({ plugin: PLUGIN, key: 'pr:42:button' })
    await settle()

    const before = kept.runs.filter((argv) => argv.includes(STATUS_JSON_FIELDS)).length
    await kept.clock.advance(POLL_MS)
    const after = kept.runs.filter((argv) => argv.includes(STATUS_JSON_FIELDS)).length

    // The poll still asked (status has nothing to do with the text an offset points into)...
    expect(after).toBe(before + 1)
    // ...and the arm itself is untouched by it.
    expect(textOf(await $.ui.render(PANE))).toContain('(armed)')
  })
})
