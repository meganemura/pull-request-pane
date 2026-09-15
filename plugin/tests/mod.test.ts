// Tests for the plugin's function-hooks module, run by `claude plugin test plugin` with
// `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. The kit loads the module as the engine does and hands
// each test the engine's own `$`; the hooks a test registers with `on` sit beneath the module,
// where `git`, `gh` and the terminal would be. Nothing here spawns a real process: `process.run`
// answers from a script keyed on the argument vector, so what is tested is what the module asks
// `gh` for and what it draws and fills, never what a real `gh` prints.

import type { CommandRunInput, On, RenderInput, SessionMessage } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

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
  isFilled?: boolean
}

// The world beneath the module: a checkout on `branch` (or none, when `branch` is null), a
// `gh` that answers from the fixtures given, and a terminal that keeps what was opened, closed,
// logged and filled.
function world(on: On, options: WorldOptions = {}) {
  const runs: (readonly string[])[] = []
  const opened: string[] = []
  const closed: string[] = []
  const logged: string[] = []
  const filled: string[] = []
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
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: options.isFilled ?? true }
  })

  return { runs, opened, closed, logged, filled, clock }
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

// Every Text node in a drawn tree, each with the colour it set (absent when it set none).
function coloredLinesOf(tree: unknown): { text: string; color?: string }[] {
  if (Array.isArray(tree)) return tree.flatMap(coloredLinesOf)
  if (typeof tree !== 'object' || tree === null) return []
  const type: unknown = Reflect.get(tree, 'type')
  const props: unknown = Reflect.get(tree, 'props')
  const children: unknown = Reflect.get(tree, 'children')
  if (type === 'Text') {
    const text = (Array.isArray(children) ? children : []).filter((child): child is string => typeof child === 'string').join('')
    const color = typeof props === 'object' && props ? Reflect.get(props, 'color') : undefined
    return [{ text, ...(typeof color === 'string' ? { color } : {}) }]
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

    const text = textOf(await $.ui.render(PANE))

    expect(text).toContain('#42')
    expect(text).toContain('Add login')
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

    const text = textOf(await $.ui.render(PANE))

    expect(text).toContain('line four')
    expect(text).toContain('line five')
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

    const text = textOf(await $.ui.render(PANE))

    expect(text).toContain('#12')
    expect(text).toContain('Login is broken')
  })

  test('pressing a Button fills the prompt box with an identifier line, the quoted body, and a trailing blank line', async ($, on) => {
    const kept = world(on, {
      branch: 'feature',
      repo: 'acme/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'line one\nline two', url: 'https://github.com/acme/app/pull/42', state: 'OPEN' }],
    })
    await $.session.start(SESSION)
    await $.command.run(RUN)
    await $.ui.render(PANE)
    await $.ui.press({ plugin: PLUGIN, key: 'pr:42:button' })
    await settle()

    expect(kept.filled).toEqual(['acme/app PR #42 "Add login" (https://github.com/acme/app/pull/42) description:\n> line one\n> line two\n'])
  })

  test('when prompt.fill answers isFilled:false, the press is not silently dropped', async ($, on) => {
    const kept = world(on, {
      branch: 'feature',
      repo: 'acme/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'na', url: 'https://github.com/acme/app/pull/42', state: 'OPEN' }],
      isFilled: false,
    })
    await $.session.start(SESSION)
    await $.command.run(RUN)
    await $.ui.render(PANE)
    await $.ui.press({ plugin: PLUGIN, key: 'pr:42:button' })
    await settle()

    expect(kept.logged).toHaveLength(1)
  })

  test('rendering the pane never spawns', async ($, on) => {
    const kept = world(on, {
      branch: 'feature',
      repo: 'acme/app',
      branchPrs: [{ number: 42, title: 'Add login', body: 'na', url: 'https://github.com/acme/app/pull/42', state: 'OPEN' }],
    })
    await $.session.start(SESSION)
    await $.command.run(RUN)
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

    const statusCallsBefore = kept.runs.filter((argv) => argv.includes(STATUS_JSON_FIELDS))
    expect(statusCallsBefore).toHaveLength(0)

    await kept.clock.advance(POLL_MS)

    const statusCalls = kept.runs.filter((argv) => argv.includes(STATUS_JSON_FIELDS))
    expect(statusCalls).toHaveLength(1)

    const collapsed = textOf(await $.ui.render(PANE))
    expect(collapsed).toContain('▶ checks')
    expect(collapsed).toContain('failing')
    expect(collapsed).not.toContain('✓3 ✗1 …2 · APPROVED · MERGEABLE')

    await $.ui.press({ plugin: PLUGIN, key: 'pr:42:checks-toggle:button' })

    const expanded = textOf(await $.ui.render(PANE))
    expect(expanded).toContain('▼ checks')
    expect(expanded).toContain('✓3 ✗1 …2 · APPROVED · MERGEABLE')
    expect(expanded).toContain('✗ deploy-check')
    expect(expanded).toContain('✓ lint')
    expect(expanded).toContain('… e2e')
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
    await kept.clock.advance(POLL_MS)
    await $.ui.render(PANE)
    await $.ui.press({ plugin: PLUGIN, key: 'pr:42:checks-toggle:button' })

    const tree = await $.ui.render(PANE)
    const lines = coloredLinesOf(tree)

    expect(lines.find((line) => line.text.includes('MERGEABLE'))).toEqual({ text: expect.stringContaining('MERGEABLE') })
    expect(lines.find((line) => line.text === '✓ lint')).toEqual({ text: '✓ lint', color: 'green' })
    expect(lines.find((line) => line.text === '✗ deploy-check')).toEqual({ text: '✗ deploy-check', color: 'red' })

    const links = linksOf(tree)
    expect(links).toEqual([{ href: 'https://github.com/acme/app/actions/runs/1/job/2', text: '✗ deploy-check' }])
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
})
