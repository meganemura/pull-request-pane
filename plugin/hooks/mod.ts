// PROBE — not the plugin's real module. Measures one thing the spec could not: whether
// `$.prompt.fill` reaches the prompt box from a Button's `onPress`, in a real terminal
// (`claude plugin test` runs no terminal, so this cannot be measured there).
//
// `/pull-request-pane` opens a pane with one Button. Pressing it calls
// `host.fill` with a fixed string and logs `{ isFilled }` with `$.ui.log`, so the
// result is visible in the transcript without reading `~/.claude/debug/`.
//
// Delete this file's content and replace it with the real module once the probe's
// result is in report.md. Do not build the real module on an unmeasured assumption
// about `onPress` → `fill`.

import type { Elements, On } from 'claude-code'

const PANE_ID = 'pull-request-pane'
const PANE_TITLE = 'pull-request-pane'
const COMMAND = 'pull-request-pane'

const PROBE_TEXT = 'pull-request-pane probe: fixed string from onPress -> $.prompt.fill\n'

type Host = {
  fill: (text: string) => Promise<{ isFilled: boolean }>
  log: (text: string) => void
  invalidate: () => void
  open: () => Promise<void>
  close: () => Promise<void>
  register: () => Promise<unknown>
}

// Same shape as the real module's `hostOf`: `$` is handed only to the top-level
// function declarations the validator reads statically.
function hostOf($: any): Host {
  return {
    fill: (text) => $.prompt.fill({ text }),
    log: (text) => $.ui.log(text),
    invalidate: () => $.ui.invalidate('ui.render'),
    open: () => $.ui.open({ id: PANE_ID, title: PANE_TITLE }),
    close: () => $.ui.close({ id: PANE_ID }),
    register: () => $.command.register({ name: COMMAND, description: 'Probe: press the button, watch the prompt box' }),
  }
}

type Ui = Pick<Elements['terminal'], 'Box' | 'Button' | 'Text'>

function paneOf(ui: Ui, host: Host): ReturnType<Ui['Box']> {
  const { Box, Button, Text } = ui
  return Box({
    key: 'probe',
    flexDirection: 'column',
    paddingTop: 1,
    paddingRight: 1,
    children: [
      Text({ children: 'press the button; watch this pane and the prompt box' }),
      Button({
        key: 'probe-button',
        label: 'fill the prompt box',
        onPress: () => {
          void host.fill(PROBE_TEXT).then(({ isFilled }) => {
            host.log(`pull-request-pane probe: fill isFilled=${isFilled}`)
            host.invalidate()
          })
        },
      }),
    ],
  })
}

export function register(on: On) {
  let host: Host | null = null
  let isOpen = false

  on('session.start', async ($, e, next) => {
    host = hostOf($)
    await host.register().catch((error: unknown) => {
      host?.log(`pull-request-pane probe: /${COMMAND} is not available: ${error instanceof Error ? error.message : String(error)}`)
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    if (host === null) return next(e)
    if (isOpen) {
      await host.close()
      isOpen = false
      return { text: 'probe pane hidden' }
    }
    await host.open()
    isOpen = true
    return { text: 'probe pane shown' }
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID || host === null) return next(e)
    const { Box, Button, Text } = await $.ui.resolve(e)
    return paneOf({ Box, Button, Text }, host)
  })

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) isOpen = false
    return result
  })
}
