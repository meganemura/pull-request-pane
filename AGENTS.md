# AGENTS.md

Context for agents that work in this repository.

## What this is

pull-request-pane, a Claude Code plugin whose behavior lives in one hooks
module (a "Claude Mod"). It draws a pane beside the transcript with the
GitHub pull requests that relate to the current session: the pull request of
the checked-out branch first, then the issues it closes and the pull
requests and issues the transcript mentions. The pane has two functions:

1. **Description quote.** Each entry has a button. A press quotes that
   entry's description into the prompt box, so the person types one
   instruction after the quote and Claude edits the description on GitHub.
2. **Status.** While the pane is open, the module polls `gh` for each pull
   request's checks, review decision and mergeability, and draws the result
   beside the entry.

Pull requests are the primary subject. Issues share the same entry shape
(`kind: 'pr' | 'issue'`) so both functions work on either.

The plugin lives in `plugin/`. There is no build step and no runtime package
dependency. The module calls `gh` through the engine's `$.process.run`.

## Visibility

The repository is private today. The layer is public-possible: commit
messages, comments, README and docs are in English. Follow ASD-STE100
Simplified Technical English.

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
  `process.run` (so no test calls the real `gh`), `prompt.fill` and the
  clock (`mock.clock`).
- Quality gates: `claude plugin validate plugin`, `npx -p typescript tsc -p
  plugin/hooks`, and the plugin tests. Run all three before a commit.
- Development loop: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir
  "$PWD/plugin"` in a repository that has a pull request, in a real terminal.
  `-p` has no pane surface. Hook failures are fail-open and appear only in
  `~/.claude/debug/<session>.txt` as `hook failed ... skipped`.
- Design decisions go to `docs/decisions/` as short numbered notes.
