# 0011. CI runs the same three gates, pinned, with no API credential

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

## Decision

`.github/workflows/test.yml` runs on every push to `main` and every pull request:
`actions/checkout`, `actions/setup-node` (Node 22.23.2), `npm install -g
@anthropic-ai/claude-code@2.1.266`, `/plugin-types` (under
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, the same flag the plugin itself needs), then the three
gates — `tsc` through `npx --package typescript@7.0.2 tsc -p plugin/hooks`, not the project's
own unpinned `npx -p typescript tsc` invocation named in `CLAUDE.md`'s development-loop line.

Every external version is an exact pin, per `CLAUDE.md`'s dependency rule (released at least a
week before this decision, no known security fix superseding it since): `actions/checkout` and
`actions/setup-node` by commit SHA (their latest tagged release, `v7.0.1` and `v7.0.0`,
published 2026-07-20 and 2026-07-14), `@anthropic-ai/claude-code@2.1.266` (published
2026-09-08), `typescript@7.0.2` (published 2026-07-08), Node `22.23.2` (published 2026-07-29).
No secret is configured; the workflow has none to leak.

## Consequences

- Bumping any pinned version is a deliberate edit to this file, never an implicit `latest` on
  the next run — the same property `CLAUDE.md`'s dependency rule asks of the plugin's own
  dependencies (it has none; this is the first place the project pins anything at all).
- The workflow's `tsc` invocation and `CLAUDE.md`'s development-loop line now name two
  different `typescript` invocations (pinned in CI, unpinned for a person's own local loop) —
  a person can still run `npx -p typescript tsc -p plugin/hooks` locally against whatever
  `typescript` npm already resolves; only CI is pinned.
