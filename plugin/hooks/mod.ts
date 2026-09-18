// The plugin's one function-hooks module (the validator admits one per plugin). `/pull-
// request-pane` opens a pane beside the transcript with the pull requests and issues related
// to this session: the checked-out branch's pull request first, then the issues its body
// closes, then anything the transcript names. A drag over an entry's title or description opens
// a comment box for that span; Enter adds it to the entry's own list, any number of times,
// across either field. A second, always-present box takes one comment on the entry as a whole.
// Pressing Submit sends every comment for that entry as one prompt that quotes each span, in
// place of the person's own next prompt — this is a review pane, not a quoting one, so the
// comments are the instruction (see docs/decisions/0014, superseding 0004's "ride the next
// prompt as context").
//
// While the pane is open, a 60-second timer refetches each pull request's checks, review
// decision and mergeability and draws them beside the entry; the timer starts when the pane
// opens and stops when it closes.
//
// Must NOT know about: how a comment gets acted on (that is the model's job, driven by the
// prompt Submit sends, never this file's); GitHub authentication (`gh auth status` failing is
// shown as a line in the pane, not handled); paragraph- or line-level selection (a later
// milestone).
//
// It loads only where Claude Code has function hooks enabled. The engine's validator reads
// this file statically, so every call on `$` is spelled `$.noun.event(...)` and `$` is handed
// only to the function declarations at the top of the file; the rest of the module holds a
// `Host`, a bundle of closures built once at `session.start`.

import type { Elements, On, RenderElement, SessionMessage, Timer } from 'claude-code'
import {
  EMPTY_REVIEW,
  WHOLE_LABEL,
  commentCountOf,
  feedbackTextOf,
  hasUnsentTextOf,
  selectionMessageOf,
  shortQuoteOf,
  withSelection,
  withSpanCommitted,
  withSpanRemoved,
  withSpanText,
  withWholeCommitted,
  withWholeRemoved,
  withWholeText,
} from './review'
import type { Field, Review } from './review'

const PANE_ID = 'pull-request-pane'
const PANE_TITLE = 'pull-request-pane'
const COMMAND = 'pull-request-pane'

// `gh` reaches the network; this bounds a hung call, not a slow one.
const GH_TIMEOUT_MS = 15_000

const POLL_MS = 60_000

const NOT_IN_REPOSITORY_TEXT = 'not in a GitHub repository'
const NO_RELATED_TEXT = 'no related pull request or issue'

// The pane's own right padding, named once: everything inside it (rows, entries, the Clients at
// `width: '100%'`) draws into `bodyColumns` less this, so the kind divider is sized the same way
// or it ends up one cell wider than everything around it and wraps onto a second row.
const PANE_PADDING_RIGHT = 1

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
  submit: (text: string) => Promise<{ drop?: string }>
  status: (text: string | undefined) => void
  every: (ms: number, fn: () => void) => Timer
  open: () => Promise<void>
  close: () => Promise<void>
  invalidate: () => void
  log: (text: string) => void
  register: () => Promise<unknown>
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  focus: (key: string) => Promise<unknown>
}

type State = {
  host: Host | null
  isOpen: boolean
  repo: string | null
  entries: Entry[]
  error: string | null
  refreshedAt: string | null
  isRefreshing: boolean
  isQueued: boolean
  // One entry's pending review comments, by `entryKeyOf`. An entry with nothing in it (yet) is
  // not a key here — see `reviewOf`, which hands back `EMPTY_REVIEW` for one that is missing.
  review: Map<string, Review>
  isSubmitting: boolean
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
    submit: (text) => $.prompt.submit({ text }),
    status: (text) => $.ui.status(text),
    every: (ms, fn) => $.clock.every(ms, fn),
    open: () => $.ui.open({ id: PANE_ID, title: PANE_TITLE }),
    close: () => $.ui.close({ id: PANE_ID }),
    invalidate: () => $.ui.invalidate('ui.render'),
    log: (text) => $.ui.log(text),
    register: () => $.command.register({ name: COMMAND, description: 'Show or hide the pull-request-pane' }),
    storeGet: (key) => $.store.get(key),
    storeSet: (key, value) => $.store.set(key, value),
    focus: (key) => $.ui.focus({ requestId: PANE_ID, key }),
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

function reviewOf(state: Pick<State, 'review'>, key: string): Review {
  return state.review.get(key) ?? EMPTY_REVIEW
}

// True while an entry's review has anything a refresh must not disturb: a pending selection, a
// committed span (its offsets point into the frozen text), an overall comment, or unsent text
// still sitting in an Input. `commentCountOf` alone would miss the first and the last of those.
function hasReviewActivityOf(review: Review): boolean {
  return review.selection !== null || review.spans.length > 0 || review.whole !== null || hasUnsentTextOf(review)
}

// While an entry has review activity, its title or body must not change under the person: a
// span's offsets are computed against one version of that text, and refreshing it mid-review — a
// real edit landing on GitHub, or just a re-fetch of the same content under a new object — would
// leave an offset pointing at the wrong thing, or a quote in a Submit's prompt reading as
// something the person never actually selected.
export function withReviewPreserved(state: Pick<State, 'review' | 'entries'>, freshEntries: Entry[]): Entry[] {
  const activeKeys = new Set([...state.review].filter(([, review]) => hasReviewActivityOf(review)).map(([key]) => key))
  if (activeKeys.size === 0) return freshEntries
  return freshEntries.map((entry) => {
    const key = entryKeyOf(entry)
    if (!activeKeys.has(key)) return entry
    return state.entries.find((candidate) => entryKeyOf(candidate) === key) ?? entry
  })
}

// A key with review activity whose entry is missing from `priorEntries` fell out of
// `state.entries` since it was last set — usually a transient `collectEntries` error that
// blanked the list — so `withReviewPreserved` could not freeze its text and handed back the
// fresh entry instead. Keeping that review would risk a committed span's offsets slicing the
// wrong characters out of text they were never actually drawn from, and a Submit quoting it
// silently. Dropping it is the same trade 0014 accepted for a manual refresh, just reached a
// different way.
export function withOrphanedReviewDropped(review: ReadonlyMap<string, Review>, priorEntries: readonly Entry[]): Map<string, Review> {
  const priorKeys = new Set(priorEntries.map(entryKeyOf))
  const next = new Map(review)
  for (const [key, entryReview] of review) {
    if (hasReviewActivityOf(entryReview) && !priorKeys.has(key)) next.delete(key)
  }
  return next
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

// The header line for one entry's Submit prompt: `Feedback (pull-request-pane) on PR #42:` or
// `... on Issue #7:`. GitHub's PR/Issue wording is this file's own job — review.ts's
// `feedbackTextOf` only orders, quotes and joins what this hands it.
export const FEEDBACK_HEADER_PREFIX = 'Feedback (pull-request-pane) on '

export function reviewHeaderOf(entry: Pick<Entry, 'kind' | 'number'>): string {
  const kindWord = entry.kind === 'pr' ? 'PR' : 'Issue'
  return `${FEEDBACK_HEADER_PREFIX}${kindWord} #${entry.number}:`
}

function sourceOf(entry: Pick<Entry, 'title' | 'body'>, field: Field): string {
  return field === 'title' ? entry.title : entry.body
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
    // Not skipped for an entry with review activity, unlike withReviewPreserved: this only ever
    // replaces `status`, never `title` or `body`, so it cannot move the text an offset points
    // into — there is nothing here for a review to protect against (the lead's own correction,
    // having first paused this too).
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
        const priorEntries = state.entries
        state.entries = withReviewPreserved(state, result.entries)
        state.review = withOrphanedReviewDropped(state.review, priorEntries)
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

// The refresh button's own ask, distinct from the automatic refreshes `turn.complete` and the
// `gh ` Bash hook already trigger: all three preserve an entry with review activity
// (`withReviewPreserved`, inside `refresh`) so a drag or a half-written comment in progress does
// not have its offsets invalidated, or its text lost, out from under it. Restarts the poll timer
// too, so the person is not left waiting up to another `POLL_MS` for the checks fetch this same
// press just asked for. `refresh` before `pollStatuses`, not together: `refresh` replaces
// `state.entries` wholesale from `gh pr list`, whose records carry no `status` field, so
// running the two concurrently let `refresh` finish after `pollStatuses` and overwrite the
// status it had just written in (checked: run concurrently, the test below saw `fetching
// checks…` where it expects `no checks`) — the opposite of what asking for both at once is for.
async function manualRefresh(state: State, host: Host): Promise<void> {
  stopPoll(state)
  startPoll(state, host)
  host.invalidate()
  await refresh(state)
  await pollStatuses(state)
}

// The real element types, so the typecheck refuses a prop the engine would refuse. `Text`
// takes no `key`: giving it one drops the whole tree (measured, see the probe this file
// replaced), so only `Box`, `Button`, `Input` and `Client` below ever carry one. `Link` takes no
// `key` either (not in its props), so it is never a direct array child — always inside a keyed
// `Box`.
type Ui = Pick<Elements['terminal'], 'Box' | 'Button' | 'Text' | 'Link' | 'Input' | 'Client'>

// The `element` key suffix for each field's Client — distinct and non-overlapping (neither is a
// suffix of the other), so the `ui.message` hook can tell them apart by a plain `endsWith`
// check with no ordering dependency.
const TITLE_SELECT_SUFFIX = ':title-select'
const BODY_SELECT_SUFFIX = ':body-select'

// A drag over this draws its own coloured selection (description-selection.ts, reused for both
// the title and the description); this surface has no absolute positioning (checked: no
// `position`, `top`, `left` or `zIndex` in BoxProps), so the Client draws the text itself rather
// than sitting over a separate `Text` rendering of it. Posts a `SelectionMessage` on release,
// read by the `ui.message` hook in `register`. `pendingRange` is the entry's own pending
// selection for this field, undefined otherwise, so a past drag's highlight survives a redraw,
// not just the moment the mouse button is held.
function textSelectionOf(
  ui: Ui,
  key: string,
  suffix: string,
  text: string,
  pendingRange: { start: number; end: number } | undefined,
  bold: boolean,
): RenderElement {
  const lines = text.split('\n')
  return ui.Client({
    key: `${key}${suffix}`,
    module: './description-selection.ts',
    props: { lines, ...(pendingRange === undefined ? {} : { armedRange: pendingRange }), ...(bold ? { bold: true } : {}) },
    width: '100%',
  })
}

// The entry's pending selection, for one field, or undefined when nothing is pending (or it is
// pending on the other field).
function pendingRangeFor(review: Review, field: Field): { start: number; end: number } | undefined {
  const selection = review.selection
  if (selection === null || selection.field !== field) return undefined
  return { start: selection.start, end: selection.end }
}

// `⏭` (U+23ED) reads as an emoji glyph in some terminal fonts and rendered noticeably wider
// than the one cell the surface allots it, overlapping the character that followed it
// (real-terminal feedback). `~` is plain ASCII: no font can draw it wider than one cell.
const SKIPPED_SYMBOL = '~'

function checksSegmentOf(checks: PrStatus['checks']): string {
  const parts: string[] = []
  if (checks.pass > 0) parts.push(`✓${checks.pass}`)
  if (checks.fail > 0) parts.push(`✗${checks.fail}`)
  if (checks.pending > 0) parts.push(`…${checks.pending}`)
  if (checks.skipped > 0) parts.push(`${SKIPPED_SYMBOL}${checks.skipped}`)
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
  if (outcome === 'skipped') return SKIPPED_SYMBOL
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
      Text({ ...(color === undefined ? {} : { color }), bold: true, children: statusWordOf(status.checks) }),
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

// The identifier line is a `Link` to the entry's own GitHub page — hovering it highlights (the
// same cyan every other link in this pane uses), so it reads as clickable the same way a linked
// check does. Wrapped in its own keyed Box: the hover colour is refused outside one.
function identifierRowOf(ui: Ui, key: string, entry: Entry): RenderElement {
  const { Box, Link, Text } = ui
  const kindWord = entry.kind === 'pr' ? 'PR' : 'Issue'
  const label = `#${entry.number} ${kindWord} ${entry.state}`
  return Box({
    key: `${key}:identifier`,
    children: [Link({ href: entry.url, children: [Text({ hover: { color: LINK_HOVER_COLOR }, children: label })] })],
  })
}

const REFRESH_BUTTON_KEY = 'refresh'

// Moved to the top of the pane and turned into a button (asked for, in place of the plain
// `refreshed <time>` line the footer used to end with): pressing it is an explicit ask for the
// latest entries and checks right now, not just a status readout. See `manualRefresh` for what
// a press actually does.
function refreshButtonOf(ui: Ui, state: State, host: Host): RenderElement {
  const { Box, Button } = ui
  const label = state.refreshedAt === null ? '↻ reading…' : `↻ refreshed ${state.refreshedAt}`
  return Box({
    key: REFRESH_BUTTON_KEY,
    marginBottom: 1,
    children: [Button({ key: `${REFRESH_BUTTON_KEY}:button`, label, onPress: () => void manualRefresh(state, host).catch(() => undefined) })],
  })
}

// Marks where the list crosses from a pull request to an issue or back, so the two do not read
// as one undivided list of the same kind of thing (asked for: the branch's own closing issues
// and the transcript's mentions mix pull requests and issues together with nothing between them).
// Sized to `bodyColumns`, the render input's own cells-across-the-body figure — its d.ts names
// this exact use ("size a table or a rule to it rather than to `viewport.columns`").
function kindDividerOf(ui: Ui, bodyColumns: number): RenderElement {
  return ui.Text({ dimColor: true, children: '─'.repeat(Math.max(bodyColumns - PANE_PADDING_RIGHT, 0)) })
}

// `isSubmitting` guards a press arriving while a previous submit is still in flight. Refusing
// with unsent text, or with zero comments, guards the other press patterns: focus already on
// Submit, one Enter that would otherwise spend a whole turn on an empty or half-written prompt.
async function submitReview(state: State, host: Host, entry: Entry): Promise<void> {
  if (state.isSubmitting) return
  const key = entryKeyOf(entry)
  const review = reviewOf(state, key)
  if (hasUnsentTextOf(review)) {
    host.status(`#${entry.number} has text in a comment box; press Enter to add it, or clear it`)
    return
  }
  if (commentCountOf(review) === 0) {
    host.status(`#${entry.number} has no comments to submit`)
    return
  }

  state.isSubmitting = true
  try {
    const text = feedbackTextOf(reviewHeaderOf(entry), { title: entry.title, body: entry.body }, review.spans, review.whole)
    const result = await host.submit(text)
    if (result.drop === undefined) {
      state.review.delete(key)
      host.status(undefined)
      host.invalidate()
    }
    // A `drop` leaves the entry's review exactly where it was, so the person can press Submit
    // again without redoing anything.
  } finally {
    state.isSubmitting = false
  }
}

// The transitions behind an `Input` or a `Button`, each one line so the closure drawn beside it
// stays one line too (the test kit cannot type into an `Input`, so these are what
// review.test.ts's plain functions cover instead). No `host.invalidate()` on an `onInput`: the
// `Input` already shows what the person types, so redrawing on every keystroke is wasted work,
// and it can move the cursor out from under the person's hands. The mirror kept in `state.review`
// exists so a redraw triggered by something else (a `turn.complete`, another entry's own action)
// hands the typed text back rather than losing it.
function onSpanTextInput(state: State, key: string, text: string): void {
  state.review.set(key, withSpanText(reviewOf(state, key), text))
}

function onSpanTextSubmit(state: State, host: Host, key: string, text: string): void {
  state.review.set(key, withSpanCommitted(reviewOf(state, key), text))
  host.invalidate()
}

function onSpanRemove(state: State, host: Host, key: string, index: number): void {
  state.review.set(key, withSpanRemoved(reviewOf(state, key), index))
  host.invalidate()
}

function onWholeTextInput(state: State, key: string, text: string): void {
  state.review.set(key, withWholeText(reviewOf(state, key), text))
}

function onWholeTextSubmit(state: State, host: Host, key: string, text: string): void {
  state.review.set(key, withWholeCommitted(reviewOf(state, key), text))
  host.invalidate()
}

function onWholeRemove(state: State, host: Host, key: string): void {
  state.review.set(key, withWholeRemoved(reviewOf(state, key)))
  host.invalidate()
}

function commentRowOf(ui: Ui, key: string, quote: string, comment: string, onRemove: () => void): RenderElement {
  const { Box, Button, Text } = ui
  return Box({
    key,
    flexDirection: 'row',
    columnGap: 1,
    children: [Button({ key: `${key}:remove`, label: 'x', onPress: onRemove }), Text({ dimColor: true, children: `> ${quote}` }), Text({ children: comment })],
  })
}

// The pending selection's own comment box: a quote line above an `Input`. Only one of an entry's
// two textSelectionOf rows can have posted the selection this draws from — `pendingRangeFor`
// decided which one draws the live highlight, and `selection.field` says which text to slice.
function pendingCommentRowOf(ui: Ui, state: State, host: Host, entry: Entry, key: string, review: Review): RenderElement | null {
  const selection = review.selection
  if (selection === null) return null
  const { Box, Input, Text } = ui
  const text = sourceOf(entry, selection.field).slice(selection.start, selection.end)
  return Box({
    key: `${key}:span-input-row`,
    flexDirection: 'column',
    children: [
      Text({ dimColor: true, children: `> ${shortQuoteOf(text)}` }),
      Input({
        key: `${key}:span-input`,
        label: 'comment',
        placeholder: 'Enter adds it; empty Enter drops the selection',
        value: review.spanText,
        autoFocus: true,
        onInput: (value) => onSpanTextInput(state, key, value),
        onSubmit: (value) => onSpanTextSubmit(state, host, key, value),
      }),
    ],
  })
}

// Every span already committed, each with its quote and its `x` remove button, then the one
// overall comment (if any), the same shape with its own remove button and no quote to draw.
function committedRowsOf(ui: Ui, state: State, host: Host, entry: Entry, key: string, review: Review): RenderElement {
  const { Box, Button, Text } = ui
  const rows: RenderElement[] = review.spans.map((span, index) =>
    commentRowOf(ui, `${key}:c${index}`, shortQuoteOf(sourceOf(entry, span.field).slice(span.start, span.end)), span.comment, () =>
      onSpanRemove(state, host, key, index),
    ),
  )
  if (review.whole !== null) {
    const whole = review.whole
    rows.push(
      Box({
        key: `${key}:whole`,
        flexDirection: 'row',
        columnGap: 1,
        children: [Button({ key: `${key}:whole:remove`, label: 'x', onPress: () => onWholeRemove(state, host, key) }), Text({ children: `${WHOLE_LABEL} ${whole}` })],
      }),
    )
  }
  return Box({ key: `${key}:comments`, flexDirection: 'column', children: rows })
}

// Always drawn, whether or not anything else is pending: the one place to leave a comment that
// is not about any particular span.
function wholeInputRowOf(ui: Ui, state: State, host: Host, key: string, review: Review): RenderElement {
  const { Box, Input } = ui
  return Box({
    key: `${key}:whole-input-row`,
    children: [
      Input({
        key: `${key}:whole-input`,
        label: 'overall',
        placeholder: 'a comment on the whole entry',
        value: review.wholeText,
        onInput: (value) => onWholeTextInput(state, key, value),
        onSubmit: (value) => onWholeTextSubmit(state, host, key, value),
      }),
    ],
  })
}

function submitRowOf(ui: Ui, state: State, host: Host, entry: Entry, key: string, review: Review): RenderElement {
  const { Box, Button, Text } = ui
  const n = commentCountOf(review)
  return Box({
    key: `${key}:actions`,
    flexDirection: 'row',
    columnGap: 1,
    children: [
      Button({
        key: `${key}:submit`,
        label: 'Submit',
        onPress: () => {
          submitReview(state, host, entry).catch((error: unknown) => host.log(`pull-request-pane: submit failed: ${messageOf(error)}`))
        },
      }),
      Text({ dimColor: true, children: n === 1 ? '1 comment' : `${n} comments` }),
    ],
  })
}

// No button to arm the whole entry: a drag already covers all of a field's text the same way
// (docs/decisions/0007). The title and description are each their own textSelectionOf row, both
// drag-selectable, then whatever the review has going: a pending selection's own comment box,
// every comment already committed, the always-present overall-comment box, and Submit.
// `rowGap` separates the identifier, the title, the checks (grouped into one child so the gap
// lands around them, not between each check line) and the description from each other — asked
// for, to make the entry easier to read at a glance.
function entryBoxOf(ui: Ui, entry: Entry, state: State, host: Host): RenderElement {
  const { Box } = ui
  const key = entryKeyOf(entry)
  const review = reviewOf(state, key)
  const checksRows = checksRowsOf(ui, key, entry, state, host)
  const pendingRow = pendingCommentRowOf(ui, state, host, entry, key, review)

  return Box({
    key,
    flexDirection: 'column',
    rowGap: 1,
    children: [
      identifierRowOf(ui, key, entry),
      textSelectionOf(ui, key, TITLE_SELECT_SUFFIX, entry.title, pendingRangeFor(review, 'title'), true),
      ...(checksRows.length === 0 ? [] : [Box({ key: `${key}:checks`, flexDirection: 'column', children: checksRows })]),
      textSelectionOf(ui, key, BODY_SELECT_SUFFIX, entry.body, pendingRangeFor(review, 'description'), false),
      ...(pendingRow === null ? [] : [pendingRow]),
      committedRowsOf(ui, state, host, entry, key, review),
      wholeInputRowOf(ui, state, host, key, review),
      submitRowOf(ui, state, host, entry, key, review),
    ],
  })
}

function paneOf(ui: Ui, state: State, host: Host, bodyColumns: number): RenderElement {
  const { Box, Text } = ui
  const rows: RenderElement[] = []
  if (state.error !== null) {
    rows.push(Text({ color: 'red', children: state.error }))
  } else {
    state.entries.forEach((entry, index) => {
      const previous = state.entries[index - 1]
      if (previous !== undefined && previous.kind !== entry.kind) rows.push(kindDividerOf(ui, bodyColumns))
      rows.push(entryBoxOf(ui, entry, state, host))
    })
  }

  const statusLine = state.isPolling ? 'status updating…' : state.statusAt === null ? null : `status ${state.statusAt}`
  const footerLines = statusLine === null ? [] : [Text({ dimColor: true, children: statusLine })]

  // `rowGap` between entries (and a divider counts as one of the rows it separates), not
  // before the first or after the last — a blank line between one entry and the next.
  const children: RenderElement[] = [refreshButtonOf(ui, state, host), Box({ flexDirection: 'column', rowGap: 1, children: rows })]
  if (footerLines.length > 0) children.push(Box({ flexDirection: 'column', marginTop: 1, children: footerLines }))

  return Box({
    key: 'pull-request-pane',
    flexDirection: 'column',
    paddingTop: 1,
    paddingRight: PANE_PADDING_RIGHT,
    children,
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
    review: new Map(),
    isSubmitting: false,
    expandedStatus: new Set(),
    pollTimer: null,
    isPolling: false,
    statusAt: null,
  }

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
    const { Box, Button, Text, Link, Input, Client } = await $.ui.resolve(e)
    return paneOf({ Box, Button, Text, Link, Input, Client }, state, state.host, e.props.bodyColumns)
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
    const field: Field | null = e.element.endsWith(TITLE_SELECT_SUFFIX) ? 'title' : e.element.endsWith(BODY_SELECT_SUFFIX) ? 'description' : null
    if (field === null) return next(e)
    const suffix = field === 'title' ? TITLE_SELECT_SUFFIX : BODY_SELECT_SUFFIX
    const key = e.element.slice(0, -suffix.length)
    const entry = state.entries.find((candidate) => entryKeyOf(candidate) === key)
    const message = selectionMessageOf(e.data)
    if (entry === undefined || message === null) return next(e)

    const review = reviewOf(state, key)
    state.review.set(key, withSelection(review, message.type === 'selected' ? { field, start: message.start, end: message.end } : null))
    host.invalidate()

    if (message.type === 'selected') {
      // The `Input` may not be drawn yet when this runs; its own `autoFocus` prop is the second
      // path to the same end, so a failure here is not the only way the person's keyboard lands
      // on the comment field.
      try {
        await host.focus(`${key}:span-input`)
      } catch (error) {
        host.log(`pull-request-pane: focus failed: ${messageOf(error)}`)
      }
    }
    return next(e)
  })
}
