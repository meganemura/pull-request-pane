# 0011. CI runs the same three gates, pinned, with one stated exception

- Status: accepted
- Date: 2026-09-16

## Context

The three quality gates (`claude plugin validate plugin`, `tsc -p plugin/hooks`, the plugin
tests) ran locally only, before a commit. Making the repository public is a good point to also
run them on every push and pull request, so a change from anyone (including a future fork or
contributor) gets checked the same way.

Whether this needs an API credential mattered for the design: a workflow needing a secret is a
bigger commitment (managing the secret, the cost of the calls it makes) than one that does not.
Checked directly, with every environment variable cleared except `HOME`, `PATH` and `USER`:
`claude plugin validate plugin`, `claude plugin test plugin`, and
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude -p "/plugin-types"` (needed to write
`.claude/types/`, which `tsc` reads) all ran and produced their normal output with nothing set.
None of the three gates, or `/plugin-types`, calls the model.

The first version pinned for this (2.1.266, chosen only for being a week old) failed CI outright:
`claude plugin validate` refused `on("ui.message", ...)` as "not an event". Bisected against
every npm-published version from 2.1.266 through 2.1.273: `ui.message` support and the `claude
plugin test` subcommand itself both arrive only at 2.1.273, published the day before this
decision. Every version old enough to satisfy the project's usual "released a week ago" pin rule
predates one or the other; there is no version that is both compliant and able to run this
plugin's own gates.

(One false start along the way: this machine's own `~/.npmrc` sets `min-release-age=7`, a real
npm feature that silently hides — from `npm view` and `npm install` alike — any version newer
than 7 days, with no error naming the reason. That made `npm view ...versions` appear to stop at
2.1.270 and suggested 2.1.273 was native-installer-only. It is not: `npm_config_min_release_age=0
npm install @anthropic-ai/claude-code@2.1.273` on this same machine, and a plain `npm install` on
a machine with no such config, both install it normally. The registry has it; only this
machine's own local policy was hiding it.)

## Decision

`.github/workflows/test.yml` runs on every push to `main` and every pull request:
`actions/checkout`, `actions/setup-node` (Node 22.23.2), `npm install -g
@anthropic-ai/claude-code@2.1.273`, `/plugin-types` (under
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, the same flag the plugin itself needs), then the three
gates — `tsc` through `npx --package typescript@7.0.2 tsc -p plugin/hooks`, not the project's
own unpinned `npx -p typescript tsc` invocation named in `CLAUDE.md`'s development-loop line.

Every pin is exact. Most also satisfy `CLAUDE.md`'s "released a week ago, no known security fix
since" rule: `actions/checkout` and `actions/setup-node` by commit SHA (their latest tagged
release, `v7.0.1` and `v7.0.0`, published 2026-07-20 and 2026-07-14), `typescript@7.0.2`
(published 2026-07-08), Node `22.23.2` (published 2026-07-29). `@anthropic-ai/claude-code@2.1.273`
(published 2026-09-15, one day before this decision) is a stated exception, approved as such
rather than assumed: the feature this workflow exists to test did not exist a week ago, and the
plugin already depends on tracking the function-hooks early-access channel by design (`AGENTS.md`:
"the API can change between releases"). No secret is configured; the workflow has none to leak.

## Consequences

- Bumping any pinned version is a deliberate edit to this file, never an implicit `latest` on
  the next run — the same property `CLAUDE.md`'s dependency rule asks of the plugin's own
  dependencies (it has none; this is the first place the project pins anything at all).
- The `claude` pin will need to move again soon, on its own schedule rather than the project's
  usual one: revisit once a version with both `ui.message` and `plugin test` is a week old
  (2026-09-22 at the earliest, for 2.1.273 itself), checking first whether whatever ships between
  now and then still supports both — the function-hooks surface areas moves fast enough that this
  is not a one-time exception so much as a standing fact about this dependency specifically.
- The workflow's `tsc` invocation and `CLAUDE.md`'s development-loop line now name two
  different `typescript` invocations (pinned in CI, unpinned for a person's own local loop) —
  a person can still run `npx -p typescript tsc -p plugin/hooks` locally against whatever
  `typescript` npm already resolves; only CI is pinned.
