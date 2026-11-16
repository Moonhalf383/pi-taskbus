# Changelog

## [0.1.1]

Release packaging update with a version bump to 0.1.1; no runtime changes.

## [0.1.0]

Both trees expose strict/soft and inherited prerequisite markers plus blocked status. Dependency details show cross-page targets and blocker reasons on wrapped, scrollable lines.

Initial release includes a paged task forest with cross-page strict/soft prerequisites, reversible ignore, derived certainty/completion, transitive dirty tracking, explicit refresh, and available-work queries with blockers. Legacy session trees migrate into the default page with IDs preserved.

Initial release of pi-taskbus, tested with Pi 1.5.2 and requiring Node.js 22.19.0 or later.

Task trees organize work into leaf tasks and binary checkpoints, with count-based progress, effort-based granularity confidence, configurable reminders, and checkpoint or task splitting that preserves historical effort. Work tools run through task_run with explicit attribution, including nested in-process calls, concurrent task isolation, and execution auditing.

The terminal interface provides a bounded resident tree above the editor and a searchable full tree with keyboard navigation, node details, and shared folding state. Semantic colors separate status, focus, confidence, and informational text across dark and light appearances. Built-in tools retain native diff, source-preview, and streaming renderers, while task_manage presents compact summaries with expandable details.

Session events preserve branch-local task state and configuration, and a recovery journal supports replaying interrupted accounting writes through /taskbus recover. Built-in interface text and default reminders are English, and user-authored content retains its original language.

Compatibility covers host-process tools that support nested execution. Model-only tools require dedicated adapters, independent subagents count the delegation call, and custom extension renderers currently use a collapsible text fallback.
