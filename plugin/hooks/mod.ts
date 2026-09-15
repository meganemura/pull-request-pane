// The plugin's one function-hooks module (the validator admits one per plugin). `/pull-
// request-pane` opens a pane beside the transcript with the pull requests and issues related
// to this session: the checked-out branch's pull request first, then the issues its body
// closes, then anything the transcript names. A press on an entry's Button arms its
// description to ride the person's next prompt as context: it never touches the prompt box, so
// nothing already typed there is lost. The person types one instruction and presses Enter;
// Claude reads the description beside it and edits it on GitHub through `gh pr edit` / `gh
// issue edit`. A second press on the same entry drops it before it rides anywhere.
//
// While the pane is open, a 60-second timer refetches each pull request's checks, review
// decision and mergeability and draws them beside the entry; the timer starts when the pane
// opens and stops when it closes.
//
// Must NOT know about: how the description gets edited (that is the model's job, driven by
// the armed text, never this file's); GitHub authentication (`gh auth status` failing is shown
// as a line in the pane, not handled); paragraph- or line-level selection (a later milestone).
//
// It loads only where Claude Code has function hooks enabled. The engine's validator reads
// this file statically, so every call on `$` is spelled `$.noun.event(...)` and `$` is handed
// only to the function declarations at the top of the file; the rest of the module holds a
// `Host`, a bundle of closures built once at `session.start`.

import type { Elements, On, RenderElement, SessionMessage, Timer } from 'claude-code'
import type { SelectionMessage } from './description-selection'

const PANE_ID = 'pull-request-pane'
const PANE_TITLE = 'pull-request-pane'
const COMMAND = 'pull-request-pane'

// `gh` reaches the network; this bounds a hung call, not a slow one.
const GH_TIMEOUT_MS = 15_000

const MAX_BODY_LINES = 60
const POLL_MS = 60_000

// `prompt.submit`'s `context` is capped at this many characters total, across every entry it
// carries (the d.ts states the cap; matched here rather than discovered by a rejected prompt).
const PROMPT_CONTEXT_MAX_CHARS = 32_000
const CONTEXT_CUT_NOTE = '(The rest of this description was cut: it did not fit in the prompt.)'

const NOT_IN_REPOSITORY_TEXT = 'not in a GitHub repository'
const NO_RELATED_TEXT = 'no related pull request or issue'

// The closing-keyword set the spec names, one `#<n>` per match, case-insensitive.
const CLOSE_KEYWORD_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*#(\d+)/gi

// A CheckRun's `conclusion` values the spec sorts into fail and skipped; anything else
// completed reads as pass, and an incomplete or absent conclusion reads as pending.
const FAIL_CONCLUSIONS = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const SKIP_CONCLUSIONS = new Set(['SKIPPED', 'NEUTRAL'])

type Entry = {
  kind: 'pr' | 'issue'
  number: number
  title: string
  body: string
  url: string
  state: string
  status?: PrStatus
}

// Filled by the status poll; undefined until the first one lands after the pane opens.
type PrStatus = {
  isDraft: boolean
  mergeable: string
  reviewDecision: string
  checks: { pass: number; fail: number; pending: number; skipped: number }
  checkItems: CheckItem[]
  fetchedAt: string
}

type CheckOutcome = 'pass' | 'fail' | 'pending' | 'skipped'

// One check by name, for the expanded list — gh's rollup has no stable id to key on, so the
// name (falling back to its position) is what a re-render matches against.
type CheckItem = { name: string; outcome: CheckOutcome; url?: string }

type GhRecord = { number: number; title: string; body: string; url: string; state: string }

// One `statusCheckRollup` element: a CheckRun (`name`, `status`, `conclusion`, `detailsUrl`) or
// a StatusContext (`context`, `state`, `targetUrl`) — gh's two shapes for one check, told apart
// by which fields are present.
type CheckRollupItem = { name?: string; context?: string; status?: string; conclusion?: string | null; state?: string; detailsUrl?: string; targetUrl?: string }

type Host = {
  cwd: () => Promise<string>
  messages: () => Promise<readonly SessionMessage[]>
  run: (argv: readonly string[], cwd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  status: (text: string | undefined) => void
  every: (ms: number, fn: () => void) => Timer
  open: () => Promise<void>
  close: () => Promise<void>
  invalidate: () => void
  log: (text: string) => void
  register: () => Promise<unknown>
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
}

// A whole entry's description (the Button's arm, `field` always `'description'`, `range`
// absent) or a character range into its title or its description (a drag over
// description-selection.ts's Client, reused for both fields — which one posted is told apart
// by the `element` key suffix in the `ui.message` hook).
type Armed = { entry: Entry; field: 'title' | 'description'; range?: { start: number; end: number } }

type State = {
  host: Host | null
  isOpen: boolean
  repo: string | null
  entries: Entry[]
  error: string | null
  refreshedAt: string | null
  isRefreshing: boolean
  isQueued: boolean
  armed: Armed | null
  expandedStatus: Set<string>
  pollTimer: Timer | null
  isPolling: boolean
  statusAt: string | null
}

// The host is a bundle of closures over `$`, built once at `session.start`, so the rest of
// this file never holds `$` itself. That is the validator's rule and also the seam a test
// fakes: every world a test builds stubs these same calls with `on(...)`.
function hostOf($: any): Host {
  return {
    cwd: () => $.session.cwd(),
    messages: () => $.session.messages(),
    run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: GH_TIMEOUT_MS }),
    status: (text) => $.ui.status(text),
    every: (ms, fn) => $.clock.every(ms, fn),
    open: () => $.ui.open({ id: PANE_ID, title: PANE_TITLE }),
    close: () => $.ui.close({ id: PANE_ID }),
    invalidate: () => $.ui.invalidate('ui.render'),
    log: (text) => $.ui.log(text),
    register: () => $.command.register({ name: COMMAND, description: 'Show or hide the pull-request-pane' }),
    storeGet: (key) => $.store.get(key),
    storeSet: (key, value) => $.store.set(key, value),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function firstLineOf(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '')
  return (line ?? text).trim()
}

function entryKeyOf(entry: Pick<Entry, 'kind' | 'number'>): string {
  return `${entry.kind}:${entry.number}`
}

// `$.store` survives a hot reload of this module (real-terminal feedback: while iterating on
// this file, or after Claude Code otherwise reloads it, the pane would drop back to `reading…`
// even though it had already shown real entries a moment before). Persisted after every
// successful `refresh`, read back once at `session.start`, so a redraw that lands before this
// session's own first `refresh` completes still shows the last known state instead of nothing.
const STORE_KEY = 'snapshot'

type Snapshot = { repo: string | null; entries: Entry[]; refreshedAt: string | null }

function isEntry(value: unknown): value is Entry {
  if (typeof value !== 'object' || value === null) return false
  const kind = Reflect.get(value, 'kind')
  return (
    (kind === 'pr' || kind === 'issue') &&
    typeof Reflect.get(value, 'number') === 'number' &&
    typeof Reflect.get(value, 'title') === 'string' &&
    typeof Reflect.get(value, 'body') === 'string' &&
    typeof Reflect.get(value, 'url') === 'string' &&
    typeof Reflect.get(value, 'state') === 'string'
  )
}

// What came out of the store is code's own past write, not the engine's word — validated the
// same way `selectionMessageOf` treats a Client's post, since a version this file has since
// changed the shape of could still be sitting there.
function snapshotFromStore(value: unknown): Snapshot | null {
  if (typeof value !== 'object' || value === null) return null
  const repo = Reflect.get(value, 'repo')
  const entries = Reflect.get(value, 'entries')
  const refreshedAt = Reflect.get(value, 'refreshedAt')
  if (repo !== null && typeof repo !== 'string') return null
  if (!Array.isArray(entries) || !entries.every(isEntry)) return null
  if (refreshedAt !== null && typeof refreshedAt !== 'string') return null
  return { repo, entries, refreshedAt }
}

// While an entry has something armed, its title or body must not change under the person: a
// drag's offsets and a Button's whole-body quote are both computed against one version of that
// text, and refreshing it mid-interaction — a real edit landing on GitHub, or just a re-fetch
// of the same content under a new object — would leave an offset pointing at the wrong thing
// (real-terminal feedback: the automatic refresh should leave an armed entry alone).
function withArmedPreserved(state: State, freshEntries: Entry[]): Entry[] {
  if (state.armed === null) return freshEntries
  const armedKey = entryKeyOf(state.armed.entry)
  const previous = state.entries.find((entry) => entryKeyOf(entry) === armedKey)
  if (previous === undefined) return freshEntries
  return freshEntries.map((entry) => (entryKeyOf(entry) === armedKey ? previous : entry))
}

// `ui.message`'s `data` is `unknown` — code sent it, not the engine, so this is the one place
// a description-selection.ts post is checked before anything trusts its shape.
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

// What a description-selection.ts message does to what is armed: 'selected' always arms this
// entry's field and range, replacing whatever was armed before (only one thing at a time,
// matching the Button's own arm); 'cleared' drops it only when this same entry and field was
// the one armed, so a stale clear from a Client that is no longer the armed one does not disarm
// another. description-selection.ts itself only posts 'cleared' for a click landing inside its
// own `armedRange` prop, so in practice a mismatched field never reaches here — checked anyway,
// since `data` is input to validate, not a fact.
export function nextArmedOf(current: Armed | null, entry: Entry, field: 'title' | 'description', message: SelectionMessage): Armed | null {
  if (message.type === 'cleared') {
    return current !== null && entryKeyOf(current.entry) === entryKeyOf(entry) && current.field === field ? null : current
  }
  return { entry, field, range: { start: message.start, end: message.end } }
}

// The status line for a freshly armed entry: the whole-body arm (the Button's) is the only one
// with no range, so it alone still says "press it again" (the Button); a range arm — from
// either field's description-selection.ts Client — says "click it again", since that is how it
// is actually dropped (clicking the highlighted text, not the Button — see docs/decisions/0006).
export function statusForArmedOf(armed: Armed): string {
  if (armed.range === undefined) return `#${armed.entry.number} rides your next prompt (press it again to drop it)`
  const fieldWord = armed.field === 'title' ? 'title' : 'description'
  return `#${armed.entry.number}'s ${fieldWord} selection rides your next prompt (click it again to drop it)`
}

// Step 2 of the collection order, and also the cheap gate `command.run` uses to decide
// whether there is anything to open a pane over: a failing `git rev-parse` here is read the
// same way whether the cause is "not a repository" or a detached, ref-less checkout.
async function branchOf(host: Host, cwd: string): Promise<string | null> {
  try {
    const { exitCode, stdout } = await host.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd)
    return exitCode === 0 ? stdout.trim() : null
  } catch {
    return null
  }
}

type RepoResult = { kind: 'ok'; repo: string } | { kind: 'error'; message: string }

// Step 1. `gh repo view` fails the same way for "no git remote" and for "no GitHub remote";
// its stderr is the only signal this file has to tell that apart from "gh is missing or
// unauthenticated", so a stderr naming a remote reads as the friendlier, generic text and
// anything else is shown as `gh` left it.
async function repoOf(host: Host, cwd: string): Promise<RepoResult> {
  try {
    const { exitCode, stdout, stderr } = await host.run(
      ['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
      cwd,
    )
    if (exitCode !== 0) {
      const line = firstLineOf(stderr || stdout)
      return { kind: 'error', message: /remote/i.test(line) ? NOT_IN_REPOSITORY_TEXT : line }
    }
    return { kind: 'ok', repo: stdout.trim() }
  } catch (error) {
    return { kind: 'error', message: firstLineOf(messageOf(error)) }
  }
}

// Step 3: the branch's own pull requests, at most 5, oldest decision-relevant fields only.
async function branchPrsOf(host: Host, cwd: string, branch: string): Promise<Entry[]> {
  try {
    const { exitCode, stdout } = await host.run(
      ['gh', 'pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,title,body,url,state', '--limit', '5'],
      cwd,
    )
    if (exitCode !== 0) return []
    const parsed = JSON.parse(stdout) as GhRecord[]
    return parsed.map((pr) => ({ kind: 'pr' as const, number: pr.number, title: pr.title, body: pr.body, url: pr.url, state: pr.state }))
  } catch {
    return []
  }
}

// Step 6: an issue first, a pull request on its failure. A number that answers neither is
// dropped rather than failing the whole collection — one stale reference should not blank
// the pane for every other entry.
async function fetchEntryOf(host: Host, cwd: string, number: number): Promise<Entry | null> {
  const issue = await ghViewOf(host, cwd, 'issue', number)
  if (issue) return issue
  return ghViewOf(host, cwd, 'pr', number)
}

async function ghViewOf(host: Host, cwd: string, kind: 'issue' | 'pr', number: number): Promise<Entry | null> {
  try {
    const { exitCode, stdout } = await host.run([...['gh', kind, 'view', String(number)], '--json', 'number,title,body,url,state'], cwd)
    if (exitCode !== 0) return null
    const parsed = JSON.parse(stdout) as GhRecord
    return { kind, number: parsed.number, title: parsed.title, body: parsed.body, url: parsed.url, state: parsed.state }
  } catch {
    return null
  }
}

// Step 4: closing-keyword numbers out of a PR body, and the digits in the branch name.
function closingNumbersOf(body: string): number[] {
  return [...body.matchAll(CLOSE_KEYWORD_RE)].map((match) => Number(match[1]))
}

function branchNumbersOf(branch: string): number[] {
  return [...branch.matchAll(/\d+/g)].map((match) => Number(match[0]))
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Step 5: `#n` (assumed this repository) and full GitHub URLs naming this repository, out of
// the transcript's text.
function transcriptNumbersOf(messages: readonly SessionMessage[], repo: string): number[] {
  const numbers: number[] = []
  const urlRe = new RegExp(`github\\.com/${escapeRegExp(repo)}/(?:pull|issues)/(\\d+)`, 'gi')
  for (const message of messages) {
    for (const match of message.text.matchAll(/#(\d+)/g)) numbers.push(Number(match[1]))
    for (const match of message.text.matchAll(urlRe)) numbers.push(Number(match[1]))
  }
  return numbers
}

type CollectResult = { kind: 'ok'; repo: string; entries: Entry[] } | { kind: 'error'; message: string }

// Steps 1-7: gather, dedupe (branch PR, the issues it closes, then the transcript's, first
// occurrence wins), and fetch. Every failure short of "not a repository" (already refused by
// `command.run` before this runs) resolves here rather than throwing, so a bad `gh` call
// leaves the pane with one line instead of leaving the hook to fail open silently.
async function collectEntries(host: Host, cwd: string, branch: string): Promise<CollectResult> {
  const repoResult = await repoOf(host, cwd)
  if (repoResult.kind === 'error') return repoResult
  const repo = repoResult.repo

  const seen = new Set<number>()
  const entries: Entry[] = []

  const branchPrs = await branchPrsOf(host, cwd, branch)
  for (const entry of branchPrs) {
    if (seen.has(entry.number)) continue
    seen.add(entry.number)
    entries.push(entry)
  }

  const candidateNumbers = [...branchPrs.flatMap((pr) => closingNumbersOf(pr.body)), ...branchNumbersOf(branch)]
  for (const number of candidateNumbers) {
    if (seen.has(number)) continue
    seen.add(number)
    const entry = await fetchEntryOf(host, cwd, number)
    if (entry) entries.push(entry)
  }

  const messages = await host.messages()
  for (const number of transcriptNumbersOf(messages, repo)) {
    if (seen.has(number)) continue
    seen.add(number)
    const entry = await fetchEntryOf(host, cwd, number)
    if (entry) entries.push(entry)
  }

  if (entries.length === 0) return { kind: 'error', message: NO_RELATED_TEXT }
  return { kind: 'ok', repo, entries }
}

// What an armed entry's title or description reads as once it rides a prompt as context: a
// sentence telling the model what the person attached and how to act on it (the shape
// `mods/diff` uses for its own arm-and-ride ask), then the text quoted line by line (an empty
// line becomes a bare `>`), cut at 60 lines with a trailing marker. Never shown to the person —
// see docs/decisions/0004 for why the prompt box itself is never touched.
export function contextTextOf(entry: Entry, repo: string, field: 'title' | 'description', range?: { start: number; end: number }): string {
  const kindWord = entry.kind === 'pr' ? 'pull request' : 'issue'
  const editNoun = entry.kind === 'pr' ? 'pr' : 'issue'
  const source = field === 'title' ? entry.title : entry.body
  const body = range === undefined ? source : source.slice(range.start, range.end)
  const flag = field === 'title' ? '--title' : '--body'
  const subject = range === undefined ? `${repo} ${kindWord} #${entry.number}'s ${field}` : `a selection from ${repo} ${kindWord} #${entry.number}'s ${field}`
  const header = `The user attached ${subject} from pull-request-pane to this prompt. Edit it on GitHub with \`gh ${editNoun} edit ${entry.number} ${flag}\`:`
  const rawLines = body.split('\n')
  const isTruncated = rawLines.length > MAX_BODY_LINES
  const kept = isTruncated ? rawLines.slice(0, MAX_BODY_LINES) : rawLines
  const quoted = kept.map((line) => (line === '' ? '>' : `> ${line}`))
  if (isTruncated) quoted.push(`> …(truncated, ${rawLines.length - MAX_BODY_LINES} more lines)`)
  return [header, ...quoted].join('\n')
}

// `mods/diff`'s own fitting: whole when it fits the context room left, else as many whole
// lines as fit plus a cut note — never a line sliced mid-word. `undefined` when not even the
// header fits, so the caller can drop the attach instead of sending a note with no body.
function fittedContextTextOf(text: string, room: number): string | undefined {
  if (text.length <= room) return text
  const kept: string[] = []
  let used = CONTEXT_CUT_NOTE.length
  for (const line of text.split('\n')) {
    const cost = line.length + 1
    if (used + cost > room) break
    kept.push(line)
    used += cost
  }
  const hasBody = kept.length > 1
  return hasBody ? `${kept.join('\n')}\n${CONTEXT_CUT_NOTE}` : undefined
}

// The spec's aggregation, item by item: a CheckRun (has `conclusion`) is read by its
// conclusion, a StatusContext (has `state` and no `conclusion`) by its state; a CheckRun still
// running (no conclusion yet) and a StatusContext still pending both fall into `pending`.
function outcomeOf(item: CheckRollupItem): CheckOutcome {
  const isCheckRun = item.conclusion !== undefined || item.status !== undefined
  if (isCheckRun) {
    const conclusion = item.conclusion ?? null
    if (conclusion === 'SUCCESS') return 'pass'
    if (conclusion !== null && FAIL_CONCLUSIONS.has(conclusion)) return 'fail'
    if (conclusion !== null && SKIP_CONCLUSIONS.has(conclusion)) return 'skipped'
    return 'pending'
  }
  if (item.state === 'SUCCESS') return 'pass'
  if (item.state === 'FAILURE' || item.state === 'ERROR') return 'fail'
  return 'pending'
}

function checksOf(items: readonly CheckRollupItem[]): PrStatus['checks'] {
  const checks = { pass: 0, fail: 0, pending: 0, skipped: 0 }
  for (const item of items) checks[outcomeOf(item)] += 1
  return checks
}

// A CheckRun names itself `name`; a StatusContext, the older commit-status shape, names itself
// `context`. Neither is guaranteed present (gh's schema marks both nullable), so a position
// falls back for the rare rollup entry with no name of its own.
function checkItemsOf(items: readonly CheckRollupItem[]): CheckItem[] {
  return items.map((item, index) => {
    const url = item.detailsUrl ?? item.targetUrl
    return { name: item.name ?? item.context ?? `check ${index + 1}`, outcome: outcomeOf(item), ...(url === undefined ? {} : { url }) }
  })
}

type GhPrStatusRecord = { isDraft: boolean; mergeable: string; reviewDecision: string; statusCheckRollup: CheckRollupItem[] }

async function fetchStatusOf(host: Host, cwd: string, number: number): Promise<PrStatus | null> {
  try {
    const { exitCode, stdout } = await host.run(
      ['gh', 'pr', 'view', String(number), '--json', 'isDraft,mergeable,reviewDecision,statusCheckRollup'],
      cwd,
    )
    if (exitCode !== 0) return null
    const parsed = JSON.parse(stdout) as GhPrStatusRecord
    const items = parsed.statusCheckRollup ?? []
    return {
      isDraft: parsed.isDraft,
      mergeable: parsed.mergeable,
      reviewDecision: parsed.reviewDecision,
      checks: checksOf(items),
      checkItems: checkItemsOf(items),
      fetchedAt: new Date().toLocaleTimeString(),
    }
  } catch {
    return null
  }
}

// Not the entry re-collection `refresh` does: only the status of the pull requests already on
// screen. A PR whose fetch fails keeps its last known status rather than losing it, so one bad
// `gh pr view` does not blank a status the previous poll drew.
async function pollStatuses(state: State): Promise<void> {
  const host = state.host
  if (host === null || state.isPolling) return
  state.isPolling = true
  host.invalidate()
  try {
    const cwd = await host.cwd()
    // Not skipped for the armed entry, unlike withArmedPreserved: this only ever replaces
    // `status`, never `title` or `body`, so it cannot move the text an offset points into —
    // there is nothing here for arming to protect against (the lead's own correction, having
    // first paused this too).
    const numbers = state.entries.filter((entry) => entry.kind === 'pr').map((entry) => entry.number)
    for (const number of numbers) {
      const status = await fetchStatusOf(host, cwd, number)
      if (status === null) continue
      state.entries = state.entries.map((entry) => (entry.kind === 'pr' && entry.number === number ? { ...entry, status } : entry))
    }
    state.statusAt = new Date().toLocaleTimeString()
  } finally {
    state.isPolling = false
    host.invalidate()
  }
}

function startPoll(state: State, host: Host): void {
  if (state.pollTimer !== null) return
  state.pollTimer = host.every(POLL_MS, () => void pollStatuses(state).catch(() => undefined))
}

function stopPoll(state: State): void {
  state.pollTimer?.cancel()
  state.pollTimer = null
}

// Coalesced, headsign's shape exactly: a refresh asked for while one runs is run once more
// after it, not in parallel, and there is no separate debounce timer.
async function refresh(state: State): Promise<void> {
  const host = state.host
  if (host === null) return
  if (state.isRefreshing) {
    state.isQueued = true
    return
  }
  state.isRefreshing = true
  try {
    do {
      state.isQueued = false
      const cwd = await host.cwd()
      const branch = await branchOf(host, cwd)
      const result = branch === null ? { kind: 'error' as const, message: NOT_IN_REPOSITORY_TEXT } : await collectEntries(host, cwd, branch)
      state.refreshedAt = new Date().toLocaleTimeString()
      if (result.kind === 'ok') {
        state.repo = result.repo
        state.entries = withArmedPreserved(state, result.entries)
        state.error = null
        const snapshot: Snapshot = { repo: state.repo, entries: state.entries, refreshedAt: state.refreshedAt }
        void host.storeSet(STORE_KEY, snapshot).catch(() => undefined)
      } else {
        state.entries = []
        state.error = result.message
      }
      host.invalidate()
    } while (state.isQueued)
  } finally {
    state.isRefreshing = false
  }
}

// The real element types, so the typecheck refuses a prop the engine would refuse. `Text`
// takes no `key`: giving it one drops the whole tree (measured, see the probe this file
// replaced), so only `Box`, `Button` and `Client` below ever carry one. `Link` takes no `key`
// either (not in its props), so it is never a direct array child — always inside a keyed `Box`.
type Ui = Pick<Elements['terminal'], 'Box' | 'Button' | 'Text' | 'Link' | 'Client'>

// The `element` key suffix for each field's Client — distinct and non-overlapping (neither is a
// suffix of the other), so the `ui.message` hook can tell them apart by a plain `endsWith`
// check with no ordering dependency.
const TITLE_SELECT_SUFFIX = ':title-select'
const BODY_SELECT_SUFFIX = ':body-select'

// A drag over this draws its own coloured selection (description-selection.ts, reused for both
// the title and the description); this surface has no absolute positioning (checked: no
// `position`, `top`, `left` or `zIndex` in BoxProps), so the Client draws the text itself rather
// than sitting over a separate `Text` rendering of it. Posts a `SelectionMessage` on release,
// read by the `ui.message` hook in `register`. `armedRange` is what is already armed for this
// field (undefined otherwise), so a past drag's highlight and its click-to-drop both survive a
// redraw, not just the moment the mouse button is held.
function textSelectionOf(ui: Ui, key: string, suffix: string, text: string, armedRange: { start: number; end: number } | undefined): RenderElement {
  const lines = text.split('\n')
  return ui.Client({
    key: `${key}${suffix}`,
    module: './description-selection.ts',
    props: armedRange === undefined ? { lines } : { lines, armedRange },
    width: '100%',
    height: lines.length,
  })
}

// What is armed for one entry's one field, or undefined when nothing (or the other field, or
// a whole-body Button arm with no range) is.
function armedRangeFor(state: State, key: string, field: 'title' | 'description'): { start: number; end: number } | undefined {
  const armed = state.armed
  if (armed === null || entryKeyOf(armed.entry) !== key || armed.field !== field) return undefined
  return armed.range
}

function checksSegmentOf(checks: PrStatus['checks']): string {
  const parts: string[] = []
  if (checks.pass > 0) parts.push(`✓${checks.pass}`)
  if (checks.fail > 0) parts.push(`✗${checks.fail}`)
  if (checks.pending > 0) parts.push(`…${checks.pending}`)
  if (checks.skipped > 0) parts.push(`⏭${checks.skipped}`)
  return parts.join(' ')
}

// Red beats yellow beats green: one failing check makes the line red even if the rest passed.
function statusColorOf(checks: PrStatus['checks']): string | undefined {
  if (checks.fail > 0) return 'red'
  if (checks.pending > 0) return 'yellow'
  if (checks.pass > 0) return 'green'
  return undefined
}

// The summary line, once expanded: counts, review decision, mergeable state. Left uncoloured
// (dim, like the description) — a single colour for the whole line said "everything here is
// this one status", which was wrong the moment more than one check disagreed with the rest;
// each check's own colour lives on its own row below instead.
function summaryLineOf(ui: Ui, status: PrStatus): RenderElement {
  const { Text } = ui
  const segments = [checksSegmentOf(status.checks), status.reviewDecision, status.mergeable].filter((segment) => segment !== '')
  return Text({ dimColor: true, children: segments.join(' · ') })
}

function statusWordOf(checks: PrStatus['checks']): string {
  if (checks.fail > 0) return 'failing'
  if (checks.pending > 0) return 'running'
  if (checks.pass > 0) return 'passing'
  return 'no checks'
}

function outcomeSymbolOf(outcome: CheckOutcome): string {
  if (outcome === 'pass') return '✓'
  if (outcome === 'fail') return '✗'
  if (outcome === 'skipped') return '⏭'
  return '…'
}

function outcomeColorOf(outcome: CheckOutcome): string | undefined {
  if (outcome === 'pass') return 'green'
  if (outcome === 'fail') return 'red'
  if (outcome === 'pending') return 'yellow'
  return undefined
}

// A cyan neither outcome colour uses, so hovering a link reads as "this is clickable" and not
// as the check's state changing under the pointer.
const LINK_HOVER_COLOR = 'cyan'

// One row per check: the symbol carries the outcome's colour, the name stays the surface's
// plain text colour so a hover's colour is the only colour change it ever shows — a name
// already coloured red or green buried a hover highlight in a colour-on-colour change that was
// hard to see (measured, real terminal). Wrapped in a `Link` to the check's own run when gh
// gave one (a CheckRun's `detailsUrl`, a StatusContext's `targetUrl`); plain text otherwise.
// The hover colour needs the enclosing `Box` to be keyed (the d.ts refuses it outside one),
// which this row's `Box` already is.
function checkItemLineOf(ui: Ui, key: string, item: CheckItem): RenderElement {
  const { Box, Link, Text } = ui
  const color = outcomeColorOf(item.outcome)
  const symbol = Text({ ...(color === undefined ? {} : { color }), children: outcomeSymbolOf(item.outcome) })
  const name = Text({ ...(item.url === undefined ? {} : { hover: { color: LINK_HOVER_COLOR } }), children: ` ${item.name}` })
  const row = [symbol, name]
  const content = item.url === undefined ? row : [Link({ href: item.url, children: row })]
  return Box({ key, flexDirection: 'row', children: content })
}

// Collapsed by default: one word (coloured, so red/yellow/green reads before the word does)
// answers "is anything failing, still running, or all clear" without reading numbers. Expanded,
// each check draws its own name and outcome — pressing the toggle was the point of asking for
// them, so the names are what expanding buys, not just the same summary spelled out.
function checksSectionOf(ui: Ui, key: string, status: PrStatus, state: State, host: Host): RenderElement[] {
  const { Box, Button, Text } = ui
  const isExpanded = state.expandedStatus.has(key)
  const color = statusColorOf(status.checks)
  const toggleKey = `${key}:checks-toggle`

  const toggleRow = Box({
    key: toggleKey,
    flexDirection: 'row',
    columnGap: 1,
    children: [
      Button({
        key: `${toggleKey}:button`,
        label: `${isExpanded ? '▼' : '▶'} checks`,
        onPress: () => {
          if (isExpanded) state.expandedStatus.delete(key)
          else state.expandedStatus.add(key)
          host.invalidate()
        },
      }),
      Text({ ...(color === undefined ? {} : { color }), children: statusWordOf(status.checks) }),
    ],
  })

  if (!isExpanded) return [toggleRow]

  return [
    toggleRow,
    summaryLineOf(ui, status),
    ...status.checkItems.map((item, index) => checkItemLineOf(ui, `${key}:check:${index}`, item)),
  ]
}

// A PR whose status has not landed yet says so, rather than leaving a gap the same as an
// issue's — the poll is already running (see `command.run`'s immediate `pollStatuses`), so
// this is a "coming" state, not a "there is nothing here" one.
function checksRowsOf(ui: Ui, key: string, entry: Entry, state: State, host: Host): RenderElement[] {
  if (entry.kind !== 'pr') return []
  if (entry.status) return checksSectionOf(ui, key, entry.status, state, host)
  return [ui.Text({ dimColor: true, children: 'fetching checks…' })]
}

// The title is drawn by its own textSelectionOf row, not the Button's label, so it can be
// drag-selected the same way the description is (the user asked to be able to edit the title
// too, not just read it in the label). The Button keeps only what identifies the entry without
// being text worth quoting on its own: number, kind, GitHub state. Only the whole-body arm (no
// range) shows a text suffix — a range arm's own highlight in its textSelectionOf row is the
// only feedback it needs (real-terminal feedback: a text label duplicating a visible highlight
// was redundant).
function entryBoxOf(ui: Ui, entry: Entry, state: State, host: Host): RenderElement {
  const { Box, Button } = ui
  const key = entryKeyOf(entry)
  const isArmed = state.armed !== null && entryKeyOf(state.armed.entry) === key
  const armedSuffix = isArmed && state.armed?.range === undefined ? ' (armed)' : ''
  const kindWord = entry.kind === 'pr' ? 'PR' : 'Issue'
  const label = `#${entry.number} ${kindWord} ${entry.state}${armedSuffix}`

  return Box({
    key,
    flexDirection: 'column',
    children: [
      Button({
        key: `${key}:button`,
        label,
        onPress: () => {
          if (isArmed) {
            state.armed = null
            host.status(undefined)
          } else {
            state.armed = { entry, field: 'description' }
            host.status(statusForArmedOf(state.armed))
          }
          host.invalidate()
        },
      }),
      textSelectionOf(ui, key, TITLE_SELECT_SUFFIX, entry.title, armedRangeFor(state, key, 'title')),
      ...checksRowsOf(ui, key, entry, state, host),
      textSelectionOf(ui, key, BODY_SELECT_SUFFIX, entry.body, armedRangeFor(state, key, 'description')),
    ],
  })
}

function paneOf(ui: Ui, state: State, host: Host): RenderElement {
  const { Box, Text } = ui
  const rows: RenderElement[] =
    state.error !== null
      ? [Text({ color: 'red', children: state.error })]
      : state.entries.map((entry) => entryBoxOf(ui, entry, state, host))

  const refreshedLine = state.refreshedAt === null ? 'reading…' : `refreshed ${state.refreshedAt}`
  const statusLine = state.isPolling ? 'status updating…' : state.statusAt === null ? null : `status ${state.statusAt}`
  const footerLines = [Text({ dimColor: true, children: refreshedLine }), ...(statusLine === null ? [] : [Text({ dimColor: true, children: statusLine })])]

  return Box({
    key: 'pull-request-pane',
    flexDirection: 'column',
    paddingTop: 1,
    paddingRight: 1,
    children: [Box({ flexDirection: 'column', children: rows }), Box({ flexDirection: 'column', marginTop: 1, children: footerLines })],
  })
}

export function register(on: On) {
  const state: State = {
    host: null,
    isOpen: false,
    repo: null,
    entries: [],
    error: null,
    refreshedAt: null,
    isRefreshing: false,
    isQueued: false,
    armed: null,
    expandedStatus: new Set(),
    pollTimer: null,
    isPolling: false,
    statusAt: null,
  }

  // `mods/diff`'s own guard: a second `prompt.submit` arriving while the first one's `next` is
  // still in flight must not attach the same armed entry twice.
  let carrying: Armed | null = null

  on('session.start', async ($, e, next) => {
    state.host = hostOf($)
    await state.host.register().catch((error: unknown) => {
      state.host?.log(`pull-request-pane: /${COMMAND} is not available: ${messageOf(error)}`)
    })
    // Rehydrates from the last successful `refresh`, in case this session starts because the
    // module hot-reloaded while the pane was already open: without this, the pane would show
    // `reading…` again for however long the next `refresh` takes, even though it already had
    // real entries a moment ago.
    const snapshot = snapshotFromStore(await state.host.storeGet(STORE_KEY).catch(() => undefined))
    if (snapshot !== null) {
      state.repo = snapshot.repo
      state.entries = snapshot.entries
      state.refreshedAt = snapshot.refreshedAt
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    const host = state.host
    if (host === null) return next(e)

    if (state.isOpen) {
      await host.close()
      state.isOpen = false
      stopPoll(state)
      return { text: 'pull-request-pane hidden' }
    }

    const cwd = await host.cwd()
    const branch = await branchOf(host, cwd)
    if (branch === null) return { text: NOT_IN_REPOSITORY_TEXT }

    await host.open()
    state.isOpen = true
    startPoll(state, host)
    await refresh(state)
    // `host.every` only fires after its first full period; without this, the person who just
    // opened the pane would wait up to POLL_MS for the first status, not just for the poll
    // after that. Not awaited: entries are already drawn, and the checks section shows its own
    // "fetching checks…" line until this lands.
    void pollStatuses(state).catch(() => undefined)
    return { text: 'pull-request-pane shown' }
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID || state.host === null) return next(e)
    // `Client` is a terminal-only element (not every surface's table has one — checked: this
    // is the only branch this plugin ever draws into, since it opens its pane with no surface
    // override, but the guard also narrows `$.ui.resolve`'s return type to `Elements['terminal']`.
    if (e.surface !== 'terminal') return next(e)
    const { Box, Button, Text, Link, Client } = await $.ui.resolve(e)
    return paneOf({ Box, Button, Text, Link, Client }, state, state.host)
  })

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) {
      state.isOpen = false
      stopPoll(state)
    }
    return result
  })

  on('turn.complete', ($, e, next) => {
    if (state.isOpen) void refresh(state).catch(() => undefined)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      if (state.isOpen && typeof e.command === 'string' && e.command.includes('gh ')) void refresh(state).catch(() => undefined)
    }
  })

  // A description-selection.ts Client posted this on a drag's release ('client' origin, per
  // the d.ts: code sent it, on nobody's behalf, so `data` is input to validate, never a fact).
  // Its `element` key is `${entryKey}${TITLE_SELECT_SUFFIX}` or `${entryKey}${BODY_SELECT_SUFFIX}`
  // (set in textSelectionOf) — the two suffixes are checked in full and neither is a suffix of
  // the other, so which one matched tells the field apart from the entry key in one step.
  on('ui.message', { requestId: PANE_ID }, async ($, e, next) => {
    const host = state.host
    if (host === null) return next(e)
    const field: 'title' | 'description' | null = e.element.endsWith(TITLE_SELECT_SUFFIX) ? 'title' : e.element.endsWith(BODY_SELECT_SUFFIX) ? 'description' : null
    if (field === null) return next(e)
    const suffix = field === 'title' ? TITLE_SELECT_SUFFIX : BODY_SELECT_SUFFIX
    const entryKey = e.element.slice(0, -suffix.length)
    const entry = state.entries.find((candidate) => entryKeyOf(candidate) === entryKey)
    const message = selectionMessageOf(e.data)
    if (entry === undefined || message === null) return next(e)

    const before = state.armed
    state.armed = nextArmedOf(before, entry, field, message)
    if (state.armed !== before) {
      host.status(state.armed === null ? undefined : statusForArmedOf(state.armed))
      host.invalidate()
    }
    return next(e)
  })

  // The armed entry's description rides the next prompt as context, never the prompt box
  // itself — see docs/decisions/0004. Wired exactly as `mods/diff` wires its own ask: fit the
  // text to the room the context has left, attach it on the way down, and disarm only once the
  // prompt actually entered (a drop leaves it armed, so a refused prompt does not silently
  // spend the one attach the person meant to make).
  on('prompt.submit', async ($, e, next) => {
    const host = state.host
    const asked = state.armed
    if (host === null || asked === null || carrying === asked) return next(e)

    const context = e.context ?? []
    const room = PROMPT_CONTEXT_MAX_CHARS - context.reduce((sum, block) => sum + block.length, 0)
    const text = fittedContextTextOf(contextTextOf(asked.entry, state.repo ?? '', asked.field, asked.range), room)

    if (text === undefined) {
      state.armed = null
      host.status(`#${asked.entry.number}'s ${asked.field} did not fit in the prompt and was dropped`)
      host.invalidate()
      return next(e)
    }

    carrying = asked
    try {
      const result = await next({ ...e, context: [...context, text] })
      if (result.drop === undefined && state.armed === asked) {
        state.armed = null
        host.status(undefined)
        host.invalidate()
      }
      return result
    } finally {
      carrying = null
    }
  })
}
