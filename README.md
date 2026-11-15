# pi-taskbus

pi-taskbus gives Pi a task tree that stays connected to actual tool use. Every work call belongs to a checkpoint, progress follows completed checkpoints, and confidence decay helps the agent notice when a checkpoint hides more work than its plan describes.

![Taskbus connects agent tool calls to tasks and checkpoints, with checkpoint and task splitting to refine the plan.](https://raw.githubusercontent.com/Moonhalf383/pi-taskbus/main/assets/taskbus.svg)

## Install

Requires Node.js 22.19.0 or later; tested with Pi 1.5.2.

```sh
pi install npm:pi-taskbus
```

Start a new Pi session or run `/reload` after installation. To pin a release, use `pi install npm:pi-taskbus@0.1.0`; to try it for one invocation, use `pi -e npm:pi-taskbus`.

## How it works

The agent creates leaf tasks with explicit checkpoints through `task_manage`, then runs work through `task_run` with a task ID and pending checkpoint ID. The gateway enforces that attribution and preserves the original tool's validation, permission checks, streaming output, and cancellation. Nested in-process tools inherit the same attribution.

Progress is the fraction of active checkpoints marked done across a task's subtree. Confidence tracks planning granularity: `confidence = decay ^ effort`, with a default decay of `0.95` per executed leaf work call. Low confidence suggests hidden work worth making explicit; correctness is established through the work's own verification. Executed calls that return errors count as effort, while validation failures, permission blocks, and pre-execution cancellations count zero. Orchestration calls with executed children retain an audit entry, and their leaf calls supply the effort.

Default reminders appear below 60% and 30% confidence, reached on the tenth and twenty-fourth counted calls, and repeat after five more effort units. The agent can split a broad checkpoint into smaller checkpoints or group a large task into child tasks. Checkpoint splitting archives the original and distributes its historical effort; task splitting preserves checkpoint IDs and assigns each active checkpoint exactly once. Splitting changes the progress denominator to reflect the refined scope.

Completing a checkpoint records a summary and freezes its confidence; reopening requires a reason and retains previous effort. Task confidence is the effort-weighted average of active descendant checkpoints, including completed ones, with weight `max(1, effort)`. A separate reminder suggests splitting tasks with more than eight checkpoints.

## Everyday use

The agent manages the plan as it works, and you can inspect it at any time:

- The resident tree above the editor shows progress, confidence, and active work. Use `Alt+j/k` to move and `Alt+h/l` to fold, unfold, or move between parents and children.
- Open `/taskbus` for the full tree. Use `j/k` or arrows to move, `h/l` to fold or unfold, `/` to search, `Enter` for details, and `Esc` to close. `o/z` expands or folds all nodes; `g/G` selects the first or last row; `c` clears search.
- Use `/taskbus json` for the current state and `/taskbus history` for recent events. After fixing a persistence error, use `/taskbus recover` to replay pending accounting on its original session branch.

The resident panel is bounded to leave space for recent tool output. Pending and done states, selection, and confidence have separate visual cues, with cyan summaries and theme-aware focus colors. Built-in `edit`, `write`, and `bash` tools keep native diffs, previews, and streaming renderers; other extension tools use collapsible text output. Interface labels are English, and user-authored task content keeps its original language.

## Agent tools

Call `task_manage` directly to create a plan, then wait for the returned IDs before submitting `task_run`. For example, create a task with `{"action":"task_create","title":"Update authentication","checkpoints":["Inspect the request contract","Implement and test the change"]}`, then execute work using the actual returned IDs:

```json
{
  "taskId": "T-1",
  "checkpointId": "CP-1",
  "tool": "read",
  "args": { "path": "src/auth.ts" }
}
```

The main `task_manage` actions are:

- Inspect with `list(taskId?)`, `history(id?, limit?)`, or `tools(query?)`; `tools` returns original tool schemas and usage guidance.
- Plan with `task_create(title, checkpoints, parentId?)`, `checkpoint_add(taskId, title)`, and `rename(id, title)`.
- Record outcomes with `complete(checkpointId, summary)` and `reopen(checkpointId, reason)`.
- Refine with `checkpoint_split(checkpointId, parts)` or `task_split(taskId, groups)`. Checkpoint parts contain `title` and optional positive `share` values, supplied for all parts or none; task groups contain `title` and `checkpointIds`. Both splits require at least two parts or groups.

## Configuration and recovery

Configuration merges built-in defaults, global `<Pi agent dir>/taskbus.json` (usually `~/.pi/agent/taskbus.json`), and trusted-project `.pi/taskbus.json`. See [`taskbus.example.json`](./taskbus.example.json) for settings and reminder templates. Scalar overrides merge individually, while `thresholds` replaces the inherited array. Each session saves its effective configuration, so edits apply to new sessions.

Task events replay from the current Pi session branch, with archived checkpoints and execution history retained. Completed work is journaled under `<Pi agent dir>/taskbus-recovery/` before session persistence; a failed write pauses later work until recovery. The journal preserves accounting, while tool arguments and results remain in Pi's session records. If the process exits during a tool call, inspect external effects before deciding how to continue.

Attribution covers nestable tools in the current host process, including registered MCP tools. Model-only tools need dedicated adapters, independent subagents count the delegation call, and manual shell commands or extensions accessing Node.js directly are outside the tool-event chain. Coordinate model instructions when running alongside another task-management extension.

## Development

```sh
git clone https://github.com/Moonhalf383/pi-taskbus.git
cd pi-taskbus
npm ci
npm run validate
npm run test:package
pi -e ./src/index.ts
```

`npm run validate` runs TypeScript checks and tests for tracking, concurrency, recovery, SDK execution, and terminal rendering. `npm run test:package` installs a generated tarball in a temporary project and loads it through Pi. CI runs both on Node.js 22.19.0 and 24; live MCP services and real terminal appearance should also be checked in the target environment.

See [`CHANGELOG.md`](./CHANGELOG.md) for release notes and [`RELEASING.md`](https://github.com/Moonhalf383/pi-taskbus/blob/main/RELEASING.md) for the npm release procedure. Licensed under [MIT](./LICENSE).
