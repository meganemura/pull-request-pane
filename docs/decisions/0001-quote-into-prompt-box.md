# 0001. Quote a whole entry, not a selection

- Status: accepted
- Date: 2026-09-15

## Context

A press on an entry needs to hand Claude enough text to edit the right description on GitHub.
The text has to name which pull request or issue it is (Claude cannot guess), and it has to
carry the current description so the person's next instruction can refer to it ("shorten the
second paragraph") without retyping it.

## Decision

The fill text has two parts: one identifier line, then the whole body quoted line by line.

```
<owner/repo> PR #<n> "<title>" (<url>) description:
> <body line 1>
> <body line 2>
> …

```

The identifier line carries what Claude cannot infer on its own: which repository, which
number, the kind (`PR` or `Issue`), the title, and the URL `gh pr edit`/`gh issue edit` need. A
body over 60 lines is cut with a `> …(truncated, N more lines)` marker rather than sent whole,
so one long description does not push the identifier line and the person's own words out of
the model's near context. The text ends in one blank line; the person's cursor lands there and
types the instruction.

Quoting the whole body, not a selection the person made in the terminal, is deliberate for a
first version: the engine gives a pane's `Button` an `onPress`, not a text-selection event, so
a paragraph- or line-level quote needs a different interaction (a `+` beside a line, GitHub's
own review-comment affordance, was the shape raised for it) that a single Button press cannot
express. Building that well is worth its own milestone rather than a shortcut here.

## Consequences

- One press always sends the same shape of text; nothing about the interaction depends on where
  in the description the person's cursor was.
- A very long description costs the person more scrolling in the prompt box before their own
  instruction, until paragraph- or line-level selection exists.
- Paragraph- or line-level quoting (and the `+`-beside-a-line affordance it would need) is
  tracked as follow-up work, not built here.
