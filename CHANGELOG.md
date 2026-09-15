# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project has no
stable release yet: version numbers may still change shape between releases (see README's
"Status" section).

## [0.1.0] - 2026-09-16

### Added

- A pane beside the transcript listing the checked-out branch's pull request, the issues it
  closes, and the pull requests and issues the session's transcript mentions. A pull request and
  an issue are separated by a divider when the list crosses between the two kinds.
- Each entry's identifier links to it on GitHub; its title (bold) and full description are
  drawn below it, with its checks, review decision and mergeability (a pull request only) once
  fetched.
- Drag over a title or a description to arm the covered text: it rides the next prompt as
  context (never the prompt box itself), so one instruction edits it on GitHub with `gh pr edit`
  or `gh issue edit` — or, if the prompt asks something else about it, Claude answers that
  instead. Click the same field again, with a drag or not, to drop what is armed.
- Checks, review decision and mergeability refresh every 60 seconds while the pane is open. A
  button above the entries refetches everything — entries and checks together — right now, and
  restarts that 60-second schedule from the press.
- The pane's own data persists to the plugin's store, so a hot reload during development shows
  the last known entries immediately instead of `reading…`.

[0.1.0]: https://github.com/meganemura/pull-request-pane/releases/tag/pull-request-pane--v0.1.0
