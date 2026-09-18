// Tests for the plugin's function-hooks module, run by `claude plugin test plugin` with
// `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. The kit loads the module as the engine does and hands
// each test the engine's own `$`; the hooks a test registers with `on` sit beneath the module,
// where `git`, `gh` and the terminal would be. Nothing here spawns a real process: `process.run`
// answers from a script keyed on the argument vector, so what is tested is what the module asks
// `gh` for and what it draws and fills, never what a real `gh` prints.

import type { CommandRunInput, On, RenderInput, SessionMessage } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

import { FEEDBACK_HEADER_PREFIX, reviewHeaderOf, withOrphanedReviewDropped, withReviewPreserved } from '../hooks/mod'
import { EMPTY_REVIEW, selectionMessageOf } from '../hooks/review'

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
  submit?: (text: string) => { text: string } | { drop: string }
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
  const submittedTexts: string[] = []
  const clock = mock.clock(on)

  // A chain event, not a plain call: the terminal fake answers with the shape `prompt.submit`
  // itself resolves to (`{ text }` or `{ drop }`), never wrapped in `{ value }`.
  on('prompt.submit', ($, e) => {
    submittedTexts.push(e.text)
    return options.submit ? options.submit(e.text) : { text: e.text }
  })
  // Not a plain call: `ui.focus` is a genuine chain event whose own core moves the ring for
  // real, so the stub only lets `next(e)` reach that core rather than replacing it.
  on('ui.focus', ($, e, next) => next(e))

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
      return { value: { exitCode: 0, stdout: `${options.repo ?? 'meganemura/app'}\n`, stderr: '' } }
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

  return { runs, opened, closed, logged, statuses, submittedTexts, clock, store }
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

// Every Text node in a drawn tree, each with the colour it set (absent when it set none), its
// hover colour (absent the same way), and whether it set `bold`.
function coloredLinesOf(tree: unknown): { text: string; color?: string; bold?: boolean; hoverColor?: string }[] {
  if (Array.isArray(tree)) return tree.flatMap(coloredLinesOf)
  if (typeof tree !== 'object' || tree === null) return []
  const type: unknown = Reflect.get(tree, 'type')
  const props: unknown = Reflect.get(tree, 'props')
  const children: unknown = Reflect.get(tree, 'children')
  if (type === 'Text') {
    const text = (Array.isArray(children) ? children : []).filter((child): child is string => typeof child === 'string').join('')
    const color = typeof props === 'object' && props ? Reflect.get(props, 'color') : undefined
    const bold = typeof props === 'object' && props ? Reflect.get(props, 'bold') : undefined
    // `hover` sits beside `props`, not inside it (measured: dumped a tree and read the shape).
    const hover = Reflect.get(tree, 'hover')
    const hoverColor = typeof hover === 'object' && hover ? Reflect.get(hover, 'color') : undefined
    return [
      {
        text,
        ...(typeof color === 'string' ? { color } : {}),
        ...(bold === true ? { bold: true } : {}),
        ...(typeof hoverColor === 'string' ? { hoverColor } : {}),
      },
    ]
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

function buttonsOf(tree: unknown): { key: string; label: string }[] {
  if (Array.isArray(tree)) return tree.flatMap(buttonsOf)
  if (typeof tree !== 'object' || tree === null) return []
  const type: unknown = Reflect.get(tree, 'type')
  const props: unknown = Reflect.get(tree, 'props')
  const children: unknown = Reflect.get(tree, 'children')
  if (type === 'Button') {
    const key = typeof props === 'object' && props ? Reflect.get(props, 'key') : undefined
    const label = typeof props === 'object' && props ? Reflect.get(props, 'label') : undefined
    return [{ key: typeof key === 'string' ? key : '', label: typeof label === 'string' ? label : '' }]
  }
  return buttonsOf(children)
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
      repo: 'meganemura/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'na', url: 'https://github.com/meganemura/app/pull/42', state: 'OPEN' }],
    })
    await $.session.start(SESSION)
    await $.command.run(RUN)

    const tree = await $.ui.render(PANE)

    expect(textOf(tree)).toContain('#42')
    // The identifier line is a Link to the pull request itself.
    expect(linksOf(tree)).toEqual([{ href: 'https://github.com/meganemura/app/pull/42', text: '#42 PR OPEN' }])
    // The title is drawn by its own textSelectionOf row (a Client, opaque to textOf), not the
    // Button's label — see docs/decisions/0006.
    expect(clientPropsOf(tree, 'pr:42:title-select')).toEqual({ lines: ['Add login'], bold: true })
  })

  test('the whole description is drawn, not cut to a few lines', async ($, on) => {
    const body = ['line one', 'line two', 'line three', 'line four', 'line five'].join('\n')
    world(on, {
      branch: 'feature',
      repo: 'meganemura/app',
      branchPrs: [{ number: 42, title: 'Add login', body, url: 'https://github.com/meganemura/app/pull/42', state: 'OPEN' }],
    })
    await $.session.start(SESSION)
    await $.command.run(RUN)

    const props = clientPropsOf(await $.ui.render(PANE), 'pr:42:body-select')

    expect(props).toEqual({ lines: ['line one', 'line two', 'line three', 'line four', 'line five'] })
  })

  test('a closing keyword in the PR body pulls in the issue it closes', async ($, on) => {
    world(on, {
      branch: 'feature',
      repo: 'meganemura/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'Closes #12', url: 'https://github.com/meganemura/app/pull/42', state: 'OPEN' }],
      issues: { 12: { number: 12, title: 'Login is broken', body: 'na', url: 'https://github.com/meganemura/app/issues/12', state: 'OPEN' } },
    })
    await $.session.start(SESSION)
    await $.command.run(RUN)

    const tree = await $.ui.render(PANE)

    expect(textOf(tree)).toContain('#12')
    expect(clientPropsOf(tree, 'issue:12:title-select')).toEqual({ lines: ['Login is broken'], bold: true })

    // A pull request and the issue it closes are two different kinds of thing; a divider marks
    // the crossing so the list does not read as one undivided run of entries. Sized to the
    // render input's own `bodyColumns` (80 in the `PANE` fixture above) less the pane's own
    // right padding, the same width everything else inside the pane draws into.
    const text = textOf(tree)
    const divider = '─'.repeat(79)
    expect(text.indexOf('#42')).toBeLessThan(text.indexOf(divider))
    expect(text.indexOf(divider)).toBeLessThan(text.indexOf('#12'))
  })

  // There is no ui.message call in `claude plugin test`'s kit (checked: not in EventCalls['ui'],
  // only `render`, `resolve`, `scroll` and `focus` are — a Client's post reaches the hooks
  // module only through the real engine), so a drag can never seed `state.review` from inside a
  // test. `selectionMessageOf` validating a post is covered directly here; the rest of the drag
  // path — every `with*` transition, `feedbackTextOf`, `withReviewPreserved` — is covered in
  // review.test.ts as the plain functions it is built from; `on('ui.message', ...)` in mod.ts is
  // the thin, unavoidably untested wiring between a post and `state.review`. Submit itself IS a
  // real Button, reachable through `$.ui.press` — its zero-comment refusal is covered below; its
  // success path is not, for the same reason a drag cannot seed the spans it would send.
  describe('review message handling', () => {
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

    test('reviewHeaderOf names PR or Issue and the number', () => {
      expect(reviewHeaderOf({ kind: 'pr', number: 42 })).toBe(`${FEEDBACK_HEADER_PREFIX}PR #42:`)
      expect(reviewHeaderOf({ kind: 'issue', number: 7 })).toBe(`${FEEDBACK_HEADER_PREFIX}Issue #7:`)
    })

    test('withReviewPreserved keeps an entry with review activity, lets every other one refresh', () => {
      const reviewedEntry = { kind: 'pr' as const, number: 1, title: 'old title', body: 'old body', url: '', state: 'OPEN' }
      const otherEntry = { kind: 'pr' as const, number: 2, title: 'other', body: 'other body', url: '', state: 'OPEN' }
      const review = new Map([['pr:1', { selection: { field: 'description' as const, start: 0, end: 3 }, spanText: '', spans: [], whole: null, wholeText: '' }]])
      const state = { review, entries: [reviewedEntry, otherEntry] }

      const fresh = [
        { kind: 'pr' as const, number: 1, title: 'NEW title', body: 'NEW body', url: '', state: 'OPEN' },
        { kind: 'pr' as const, number: 2, title: 'other', body: 'fresher other body', url: '', state: 'OPEN' },
      ]

      const result = withReviewPreserved(state, fresh)

      expect(result[0]).toBe(reviewedEntry)
      expect(result[1]).toBe(fresh[1])
    })

    test('withReviewPreserved is a no-op when no entry has review activity', () => {
      const entries = [{ kind: 'pr' as const, number: 1, title: 't', body: 'b', url: '', state: 'OPEN' }]
      expect(withReviewPreserved({ review: new Map(), entries: [] }, entries)).toBe(entries)
    })

    // A `collectEntries` error blanks `state.entries` entirely; if the same entry then
    // reappears under the same key on a later, successful refresh, `withReviewPreserved` cannot
    // find it in the (now empty) `priorEntries` to freeze its text against, so a review left
    // over from before the entry disappeared would otherwise carry offsets into text nobody can
    // vouch for any more (0014's own note on this).
    test('withOrphanedReviewDropped drops a review whose entry is missing from priorEntries, keeps the rest', () => {
      const withSpan = { selection: null, spanText: '', spans: [{ field: 'title' as const, start: 0, end: 3, comment: 'c' }], whole: null, wholeText: '' }
      const withUnsentText = { selection: null, spanText: 'typing', spans: [], whole: null, wholeText: '' }
      const review = new Map([
        ['pr:1', withSpan],
        ['pr:2', withUnsentText],
        ['pr:3', EMPTY_REVIEW],
      ])
      const priorEntries = [{ kind: 'pr' as const, number: 2, title: 't', body: 'b', url: '', state: 'OPEN' }]

      const result = withOrphanedReviewDropped(review, priorEntries)

      expect(result.has('pr:1')).toBe(false)
      expect(result.get('pr:2')).toBe(withUnsentText)
      expect(result.has('pr:3')).toBe(true)
    })
  })

  test('pressing Submit with zero comments sends nothing and sets the status', async ($, on) => {
    const kept = world(on, {
      branch: 'feature',
      repo: 'meganemura/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'na', url: 'https://github.com/meganemura/app/pull/42', state: 'OPEN' }],
    })
    await $.session.start(SESSION)
    await $.command.run(RUN)
    await $.ui.render(PANE)

    await $.ui.press({ plugin: PLUGIN, key: 'pr:42:submit' })
    await settle()

    expect(kept.submittedTexts).toEqual([])
    expect(kept.statuses.at(-1)).toBe('#42 has no comments to submit')
  })

  test('the Submit button and comment count are drawn for every entry', async ($, on) => {
    world(on, {
      branch: 'feature',
      repo: 'meganemura/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'na', url: 'https://github.com/meganemura/app/pull/42', state: 'OPEN' }],
    })
    await $.session.start(SESSION)
    await $.command.run(RUN)

    const tree = await $.ui.render(PANE)

    expect(buttonsOf(tree).some((button) => button.key === 'pr:42:submit' && button.label === 'Submit')).toBe(true)
    expect(textOf(tree)).toContain('0 comments')
  })

  test('rendering the pane never spawns', async ($, on) => {
    const kept = world(on, {
      branch: 'feature',
      repo: 'meganemura/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'na', url: 'https://github.com/meganemura/app/pull/42', state: 'OPEN' }],
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
      repo: 'meganemura/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'na', url: 'https://github.com/meganemura/app/pull/42', state: 'OPEN' }],
      statuses: {
        42: {
          isDraft: false,
          mergeable: 'MERGEABLE',
          reviewDecision: 'APPROVED',
          statusCheckRollup: [
            { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'deploy-check', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/meganemura/app/actions/runs/1/job/2' },
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
      repo: 'meganemura/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'na', url: 'https://github.com/meganemura/app/pull/42', state: 'OPEN' }],
      statuses: {
        42: {
          isDraft: false,
          mergeable: 'MERGEABLE',
          reviewDecision: 'APPROVED',
          statusCheckRollup: [
            { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'deploy-check', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/meganemura/app/actions/runs/1/job/2' },
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
    // The collapsed toggle row's status word is bold, alongside its colour — simple decoration,
    // asked for alongside the identifier link and the title's own bold.
    expect(lines.find((line) => line.text === 'failing')).toEqual({ text: 'failing', color: 'red', bold: true })
    expect(lines.find((line) => line.text === '✓')).toEqual({ text: '✓', color: 'green' })
    expect(lines.find((line) => line.text === ' lint')).toEqual({ text: ' lint' })
    expect(lines.find((line) => line.text === '✗')).toEqual({ text: '✗', color: 'red' })
    expect(lines.find((line) => line.text === ' deploy-check')).toEqual({ text: ' deploy-check', hoverColor: 'cyan' })

    const links = linksOf(tree)
    expect(links).toEqual([
      { href: 'https://github.com/meganemura/app/pull/42', text: '#42 PR OPEN' },
      { href: 'https://github.com/meganemura/app/actions/runs/1/job/2', text: '✗\n deploy-check' },
    ])
  })

  // `⏭` (the symbol this used to be) reads as an emoji glyph in some terminal fonts and drew
  // wider than the one cell it was given, overlapping the digit right after it (real-terminal
  // feedback). `~` is plain ASCII, so no font can widen it past one cell.
  test('a skipped check uses a plain ASCII symbol, not one that can render wider than one cell', async ($, on) => {
    const kept = world(on, {
      branch: 'feature',
      repo: 'meganemura/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'na', url: 'https://github.com/meganemura/app/pull/42', state: 'OPEN' }],
      statuses: {
        42: {
          isDraft: false,
          mergeable: 'MERGEABLE',
          reviewDecision: '',
          statusCheckRollup: [
            { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'legacy-check', status: 'COMPLETED', conclusion: 'SKIPPED' },
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
    const text = textOf(tree)

    expect(text).toContain('~1')
    expect(text).not.toContain('⏭')
    expect(coloredLinesOf(tree).find((line) => line.text === '~')).toEqual({ text: '~' })
  })

  test('pressing the refresh button refetches entries and checks, and resets the poll', async ($, on) => {
    const kept = world(on, {
      branch: 'feature',
      repo: 'meganemura/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'na', url: 'https://github.com/meganemura/app/pull/42', state: 'OPEN' }],
      statuses: { 42: { isDraft: false, mergeable: 'MERGEABLE', reviewDecision: '', statusCheckRollup: [] } },
    })
    await $.session.start(SESSION)
    await $.command.run(RUN)
    await settle()
    await $.ui.render(PANE)

    const listCallsAfterOpen = kept.runs.filter((argv) => argv.includes('list')).length
    const statusCallsAfterOpen = kept.runs.filter((argv) => argv.includes(STATUS_JSON_FIELDS)).length

    await kept.clock.advance(40_000)
    await $.ui.press({ plugin: PLUGIN, key: 'refresh:button' })
    await settle()

    expect(kept.runs.filter((argv) => argv.includes('list')).length).toBeGreaterThan(listCallsAfterOpen)
    const statusCallsAfterPress = kept.runs.filter((argv) => argv.includes(STATUS_JSON_FIELDS)).length
    expect(statusCallsAfterPress).toBeGreaterThan(statusCallsAfterOpen)
    // `refresh` (re-collecting entries from `gh pr list`, which carries no status) runs before
    // `pollStatuses`, not alongside it — the other order would let `refresh` overwrite the
    // status this same press just fetched, back to "fetching checks…".
    expect(textOf(await $.ui.render(PANE))).toContain('no checks')

    // The pane's own original schedule would have polled again here, 60s after it opened; the
    // press restarted the timer, so nothing fires until a full period from the press itself.
    await kept.clock.advance(20_000)
    expect(kept.runs.filter((argv) => argv.includes(STATUS_JSON_FIELDS)).length).toBe(statusCallsAfterPress)

    await kept.clock.advance(40_000)
    expect(kept.runs.filter((argv) => argv.includes(STATUS_JSON_FIELDS)).length).toBeGreaterThan(statusCallsAfterPress)
  })

  test('closing the pane stops the poll', async ($, on) => {
    const kept = world(on, {
      branch: 'feature',
      repo: 'meganemura/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'na', url: 'https://github.com/meganemura/app/pull/42', state: 'OPEN' }],
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
      repo: 'meganemura/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'na', url: 'https://github.com/meganemura/app/pull/42', state: 'OPEN' }],
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
