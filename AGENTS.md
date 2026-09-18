# AGENTS.md

Context for agents that work in this repository.

## What this is

pull-request-pane, a Claude Code plugin whose behavior lives in one hooks
module (a "Claude Mod"). It draws a pane beside the transcript with the
GitHub pull requests that relate to the current session: the pull request of
the checked-out branch first, then the issues it closes and the pull
requests and issues the transcript mentions. The pane has two functions:

1. **Review comments.** A drag over an entry's title or description, through
   a `Client` surface module (`plugin/hooks/description-selection.ts`,
   reused for both fields — see `docs/decisions/0005-0007`), opens a comment
   box for that span; Enter commits `{ field, start, end, comment }` into the
   entry's own list (`plugin/hooks/review.ts`'s `Review`), any number of
   times across either field, plus one comment on the entry as a whole.
   Submit sends every comment for that entry as one prompt that quotes each
   span (`review.ts`'s `feedbackTextOf`) — see `docs/decisions/0014`, which
   superseded 0004's single-slot "ride the next prompt" design. An entry
   with review activity (a pending selection, a committed span, an overall
   comment, or unsent text in a comment box) freezes its own title and body
   against the next re-collection, so an offset never points at text that
   has since changed; its checks keep polling live regardless — they never
   touch the text an offset points into.
2. **Status.** While the pane is open, the module polls `gh` for each pull
   request's checks, review decision and mergeability, and draws the result
   beside the entry.

Pull requests are the primary subject. Issues share the same entry shape
(`kind: 'pr' | 'issue'`) so both functions work on either.

The plugin lives in `plugin/`. There is no build step and no runtime package
dependency. The module calls `gh` through the engine's `$.process.run`.

## Visibility

The repository is public. Commit messages, comments, README and docs are in
English. Follow ASD-STE100 Simplified Technical English.

## Rules

- Function hooks are early access. The module loads only where
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` is set. The API can change between
  releases. The types come from `/plugin-types`, which writes
  `.claude/types/claude-code.d.ts` at the repository root; that directory is
  gitignored, so run `/plugin-types` once in a new checkout.
- The validator reads the module statically. Hand `$` only to function
  declarations at the top of the module, and spell every call
  `$.noun.event(...)`. Build one `host` bundle of closures over `$` at
  `session.start`; the rest of the module holds the host, never `$`.
- Never spawn from the render hook. A pane redraws several times a second.
  Fetch on `command.run`, `turn.complete`, a `gh` shell command and the poll
  timer, keep the result, and draw from the kept result.
- Every `Pane` element prop must be one the surface declares. One unknown
  prop drops the whole tree without a message. Type the element constructors
  with `Elements['terminal']` so the compiler catches it.
- Tests are `plugin/tests/*.test.ts`, run with
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test plugin`. They stub
  `process.run` (so no test calls the real `gh`), `ui.status`, `store.get`/
  `store.set` and the clock (`mock.clock`). A drag has no engine-level test
  path (`ui.message` is not callable from a test — see the `Client` note
  below), so `review.ts`'s transitions are covered as the plain functions
  they are built from instead; Submit IS a real Button (reachable through
  `$.ui.press`), but only its zero-comment refusal is testable this way — its
  success path needs spans no test can seed.
- Quality gates: `claude plugin validate plugin`, `npx -p typescript tsc -p
  plugin/hooks`, and the plugin tests. Run all three before a commit.
  `.github/workflows/test.yml` runs the same three on every push and pull
  request, against a pinned `claude` CLI and `typescript` version — none of
  the three calls the model, so the workflow needs no API credential.
- Development loop: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir
  "$PWD/plugin"` in a repository that has a pull request, in a real terminal.
  `-p` has no pane surface. Hook failures are fail-open and appear only in
  `~/.claude/debug/<session>.txt` as `hook failed ... skipped`.
- Design decisions go to `docs/decisions/` as short numbered notes.
- A `Client` surface module (`description-selection.ts` is the one example) never receives `$`;
  it is a plain `(props, surface) => RenderElement` function, referenced from `mod.ts` by a
  relative path string (`Client({ module: './description-selection.ts', ... })`). Test its
  pointer handling with a hand-rolled `ClientSurface` double, calling the module function
  directly — `claude plugin test plugin`'s kit has no built-in way to drive one, and no call for
  `ui.message` either (not in `EventCalls['ui']`), so the mod-side wiring that reads a Client's
  post is tested as the plain functions it is built from, not end to end.
