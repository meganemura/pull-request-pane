# 0010. Edit on GitHub only when the person's own prompt asks for a change

- Status: accepted
- Date: 2026-09-16

## Context

`contextTextOf`'s header (0004) always named `gh pr edit` / `gh issue edit` as what to do with
an armed selection, regardless of what the person then typed. Attaching a selection is not only
how someone asks for an edit, though — it is also how someone asks a question about it ("why is
this failing", "what does this check mean"). A header that named the edit command unconditionally
told the model to edit GitHub even for a question that asked for nothing of the sort.

## Decision

`contextTextOf`'s header now makes the edit conditional on the person's own prompt: "If they ask
you to change it, edit it on GitHub with `gh <pr|issue> edit <n> <flag>`; if they ask something
else about it, answer that instead". The armed text and its framing sentence still ride
`prompt.submit`'s `context`, unchanged from 0004 — only the sentence's own wording changed, to
stop assuming every attach is an edit request.

## Consequences

- A question about an armed selection ("what is this check checking") now reads as a question
  to answer, not a nudge toward an edit that was never asked for.
- An edit instruction still names the exact `gh edit` invocation and flag (`--title` or
  `--body`) for the model to reach for, unchanged from 0004.
