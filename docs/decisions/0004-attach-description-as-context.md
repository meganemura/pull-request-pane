# 0004. Arm a description to ride the next prompt, instead of filling the prompt box

- Status: superseded by [0014](0014-review-comments-replace-the-single-arm.md)
- Date: 2026-09-16

## Context

The shipped design (0001) filled the prompt box on a press: `$.prompt.fill` always replaces the
box's whole content, cursor at the end. There is no append mode. A press after the person had
already started typing an instruction erased it. That cost showed up in real use and had no fix
within `prompt.fill` itself — the event's own contract is "write this, replacing what is
there."

`prompt.suggest` was considered: a dim, Tab-to-take suggestion that the engine itself refuses to
show once the box holds text (`isShown: false`). It avoids erasing, but it does not append
either — a press while the box already holds text would silently do nothing, which is its own
kind of surprising, and a multi-line description as a dim suggestion is unproven (every example
in the engine's own types is one line).

`prompt.submit`'s `context` field carries text the model reads beside the prompt without
writing anything into the box at all: a hook attaches on the way down,
`next({ ...e, context: [...(e.context ?? []), mine] })`, and the person types normally,
whatever they already had in the box included. `mods/diff` (shipped with Claude Code) uses
exactly this for its own "ask" feature — a pane press arms a file's diff, a status line says so,
and the diff rides the person's next prompt as one context block.

## Decision

A press on an entry's Button arms it instead of filling the box: `state.armed` holds the entry,
`$.ui.status` shows `#<n> rides your next prompt (press it again to drop it)`, and the entry's
label gains `(armed)`. A second press on the same entry disarms it before it rides anywhere.

A `prompt.submit` hook attaches the armed entry's description as one context block, fitted to
whatever room is left under the engine's 32,000-character total (`mods/diff`'s own
`fittedAskTextOf` shape: whole text if it fits, else whole lines up to the limit plus a cut
note, never a line sliced mid-word). The block reads as an instruction to the model, not a
quote for the person: `The user attached <repo> <pull request|issue> #<n>'s description from
pull-request-pane to this prompt. Edit it on GitHub with \`gh pr edit <n> --body\`:` followed by
the body, quoted line by line. Disarming happens only once the prompt actually entered (the
`next` call's result carries no `drop`); a refused prompt (a settings hook's block, for example)
leaves the entry armed rather than spending the one attach the person meant to make.

An entry with nothing armed, or a prompt submitted with a different entry armed since, attaches
nothing — the hook is a no-op unless `state.armed` names the entry the press set.

## Consequences

- Nothing already typed in the prompt box is ever at risk from a press; the box is untouched.
- The description is not visible to the person before they press Enter — the engine's own
  contract for `context` states the model reads it and the person does not see it. The pane
  already draws each entry's full description below its title (0003), so the person reads the
  body there, not in the composer, before deciding what instruction to type.
- The workflow order is unchanged from 0001: press the entry, then type one instruction, then
  Enter. Arming does not require typing the instruction first.
- A `/pull-request-pane:update-description`-style skill bundled with the plugin, to spell out
  what a filled quote was for, is no longer useful — the framing sentence in the context block
  does that job instead, and there is no filled text left to explain. Worth revisiting only if a
  future milestone (paragraph- or line-level selection) brings back a fill-based interaction.
