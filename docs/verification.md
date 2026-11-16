# Implementation verification

## Requirement-to-evidence audit

Local verification uses Pi 1.5.2 on Node.js 24.14.1. `npm run validate` passes TypeScript checking and all 87 tests. `npm run test:package` builds and installs a real local tarball and loads the installed extension through Pi (14 published files). `git diff --check` passes. CI retains the Node.js 22.19.0 / 24 matrix; remote CI is not claimed as locally executed evidence.

| Requirement | Implementation | Regression evidence |
| --- | --- | --- |
| Independent ignore switches, ancestor masking, restore without losing results/effort/history | `src/model.ts`: node fields, ignore transitions, `nodeState` | `test/dependencies.test.ts`: certainty/completion/restore, split identity |
| Certain/uncertain/ignored separate from completion, ignored never done, empty leaves block ancestors | `nodeState`, `metrics` | Derived-state and empty-leaf cases in `test/dependencies.test.ts`; existing model metrics tests |
| Progress counts done + ignored, displays each separately | `metrics`, `src/view.ts`, `src/manage-renderers.ts` | `test/pages.test.ts`, management ignored-count regression |
| Multiple strict/soft prerequisites, creation and retained certainty invariants, atomic rejection | Dependency assignment validation and post-transition invariants | Strict/soft atomic rejection, duplicate and archived-target cases |
| Ancestor prerequisites, cross-page references, containment-mediated cycle rejection | `validateGraph`, `executionBlockers` | Ancestor inheritance and graph cycles in `test/dependencies.test.ts`; real SDK cross-page flow |
| Transitive dirty propagation and structural invalidation | Mutation invalidation, fixed-point propagation | Cross-page transitive dirty, added work, reopened source, split repair cases |
| Direct task dirty blocks descendants; aggregate dirty leaves healthy siblings executable | Direct reasons on affected subtree, derived aggregate dirty | Healthy-sibling execution and active-sibling repair regressions |
| Per-node atomic refresh, pending-clean prerequisite review, explicit keep/reopen | Refresh transition and recursive prerequisite admission | Done-result choice, task refresh not bulk-confirming children, kept result cannot bypass pending upstream |
| Split preserves source/replacement history, outgoing edges, incoming constraints and effort | Checkpoint/task split transitions | Existing split conservation tests plus archived-edge repair, incoming-dependency and ignore/dirty inheritance tests |
| Reject invalidation of active work and its evidence without locking unrelated work | `assertMutationSafe`, existing attribution gateway | Active upstream reservation, independent page mutation, sibling repair and concurrent attribution tests |
| Virtual pages, default-page migration, stable global IDs, explicit top-level page, inherited child page | Page model and legacy/new semantic journal replay | Legacy migration, cross-page IDs, full new-state replay; paged recovery test |
| Browser independent from execution; page-local selection/folds/search; wraparound shortcuts | `src/view.ts`, shortcut registration in `src/index.ts` | Four page tests, extension shortcut integration, traditional/Kitty encoding |
| Bounded resident panel, full tree, English semantic cues and native tool cards | View and existing renderers | Narrow widths, dark/light colors, regular/fullscreen in-memory TUI, native edit/write/bash regressions |
| Branch-local replay, accounting recovery and executed-call attribution retained | Semantic event envelopes, existing recovery/attribution | Model branch replay, four recovery tests, concurrency/error/nesting tests, real Pi SDK offline execution |
| Usable tool schemas, blockers, history and archived-node access | Management actions; `availableWork`; `list.archived` | Management integration and SDK tests; available includes inherited/transitive blocker IDs |

## Independent adversarial review

Fresh-context `contrarian` reviews were read-only. Repository inspection in the review subprocess was unavailable because its tools lacked the task gateway, so review input used explicit contracts and inline source excerpts. Review claims apply to those supplied artifacts, not an independently read checkout. Findings were checked against local source and regression tests.

Actionable findings fixed:

- Checkpoint split could lose own ignore/dirty state: replacements now inherit both, with regression coverage.
- Comparing ancestor aggregate state overlocked independent sibling repairs: direct gates and actual consumed evidence are compared separately.
- Recursive prerequisite traversal repeated shared paths exponentially: validation-local memoization now bounds a 42-checkpoint layered-diamond regression to fewer than 200 dependency reads and preserves fresh results on subsequent checks.

The archived-prerequisite-copy concern was checked against assignment validation: new references to archived targets are rejected atomically; retained historical edges remain explicit repair blockers. Follow-up source review found no further actionable issue in the memoization change. Local audit additionally fixed task-refresh bulk acknowledgment and retained-result admission through pending upstream evidence.

## Verification boundaries

Tests use synthetic offline model responses and in-memory terminals; they do not claim live-provider, live-MCP, or physical-terminal visual verification. Page browsing state is preserved while switching pages in the current view, not persisted as task journal data. The package version remains 0.1.0; no npm publication or global Pi configuration change is part of this delivery.

## Dependency visibility follow-up

`test/view-dependencies.test.ts` adds seven regressions for own/inherited strict/soft markers, ready versus blocked work, cross-page details, dirty/archived targets, narrow rows, Unicode wrapping, and detail scrolling. At height 8 with a search filter, the last blocker remains reachable while the selected tree row remains visible. The follow-up independent read-only review used inline implementation behavior because the subprocess could not inspect the checkout; it found no substantive issue and requested that short-overlay boundary check, which passes.
