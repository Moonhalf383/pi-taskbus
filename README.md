# pi-taskbus

pi-taskbus is a Pi extension that organizes work into task trees and checkpoints, requires work tools to run under an explicit checkpoint, and tracks whether checkpoint granularity remains useful as work accumulates. Its terminal interface keeps a small task tree above the editor and provides a separate tree window for navigation, search, and details.

## Getting started

The package requires Node.js 22.19.0 or later and is currently tested with Pi 1.5.2. Install the npm package through Pi, then start a new Pi session or use /reload in an existing session:

```sh
pi install npm:pi-taskbus
```

For a version-pinned installation, use `pi install npm:pi-taskbus@0.1.0`. To try the package for one invocation, run `pi -e npm:pi-taskbus`. Installation enables checkpoint-based tool attribution, so the model plans tasks with task_manage and routes subsequent work through task_run. Release notes are maintained in CHANGELOG.md, with tagged releases available on GitHub as they are published.

For local development, clone the repository, install dependencies, and launch Pi with the source entry point:

```sh
git clone https://github.com/Moonhalf383/pi-taskbus.git
cd pi-taskbus
npm ci
npm run validate
pi -e ./src/index.ts
```

The launch argument enables the local extension for that invocation. To keep using a checkout, run `pi install /absolute/path/to/pi-taskbus`. After changing the extension source, use /reload in Pi to load the updated code; task state is restored from the session journal.

## Tasks, progress, and confidence

A leaf task contains checkpoints, and a branch task contains child tasks. Each active checkpoint is either pending or done, and a checkpoint replaced by a split is archived with its history preserved. Task progress is the number of completed active checkpoints divided by the total number of active checkpoints in its subtree, so splitting a checkpoint changes the denominator and the displayed completion ratio. An empty leaf task is marked as unplanned and needs checkpoints before work can be attributed to it.

Checkpoint confidence measures whether the chosen granularity is suitable for tracking work. It starts at 100% and follows the formula confidence = decay ^ effort, where effort is the number of counted work-tool executions. A falling score suggests that the checkpoint may contain work that has yet to be made explicit and prompts the model to reconsider the plan. Implementation correctness requires separate verification.

Each work tool that actually executes contributes one unit of effort, including an execution that returns an error. Argument validation failures, permission blocks, and cancellations before execution contribute zero. Nested tools inherit the enclosing checkpoint attribution, and an orchestration call with executed children receives a zero-effort audit entry because its executed leaf calls are counted individually. If an orchestration tool runs and all of its children are blocked, the orchestration call itself contributes one unit.

The default decay factor is 0.95, which takes confidence below 60% on the tenth counted call and below 30% on the twenty-fourth. Crossing a threshold produces a reminder to refine tracking, and the same threshold can produce another reminder after five additional effort units by default. Completing a checkpoint freezes its score, and reopening it retains previous effort and resumes decay from that point.

Task confidence is the effort-weighted average of all active descendant checkpoints, including completed checkpoints, with a minimum weight of one for each checkpoint. The detail view also exposes the lowest score and the number of low-confidence checkpoints. An empty task starts with 100% confidence and remains marked as unplanned.

When a checkpoint becomes too broad, checkpoint_split archives the original and distributes its accumulated effort across at least two replacements, either equally or according to positive shares supplied for every replacement. The original checkpoint, its source and replacement relationships, and its event history remain available. When a leaf task needs separate areas of work, task_split turns it into a branch and assigns every active checkpoint to exactly one of at least two child tasks, preserving checkpoint IDs, status, effort, and confidence.

A separate reminder suggests grouping checkpoints into child tasks when a task has more than eight active checkpoints; this limit is independent of confidence. During work execution, related management changes to the active leaf task or its ancestors are rejected. Unrelated tasks remain available for work and management.

## Using the tools

The model calls task_manage directly to establish and maintain the plan, then uses task_run for work tools. A typical sequence begins with a task_manage call that supplies a title and checkpoint descriptions:

```json
{
  "action": "task_create",
  "title": "Implement the authentication endpoint",
  "checkpoints": [
    "Inspect the existing request contract",
    "Implement token issuance",
    "Test error paths"
  ]
}
```

After receiving the task and checkpoint IDs, the model can invoke a work tool through task_run. This example assumes the creation result returned T-1 and CP-1; callers should use the actual IDs returned by their session.

```json
{
  "taskId": "T-1",
  "checkpointId": "CP-1",
  "tool": "read",
  "args": { "path": "src/auth.ts" }
}
```

The gateway calls the original tool through the host's ctx.executeTool() API, preserving argument validation, permission checks, streaming updates, cancellation, and error results. Direct work-tool declarations are hidden from model requests, and the tools remain available for nested execution. The tools action of task_manage exposes their original schemas, usage guidance, and compatibility information.

For inspection, the list action accepts an optional taskId, history accepts an optional id and limit with a default of twenty recent entries, and tools accepts an optional query. To change the plan, task_create requires a title and an array of checkpoint strings and accepts an optional parentId naming a branch task; checkpoint_add requires taskId and title; rename requires the task or checkpoint id and its new title.

The complete action requires checkpointId and a result summary, and reopen requires checkpointId and a reason so that the record explains why completed work is active again. The checkpoint_split action takes checkpointId and a parts array whose entries contain a title and an optional share; callers must supply all shares or omit them all. The task_split action takes taskId and a groups array whose entries contain a title and checkpointIds, and every active checkpoint must appear in exactly one group. Task creation and subsequent work should be submitted in separate rounds so that the returned IDs are available before they are referenced.

## Terminal interface

The resident tree sits inline above the editor and displays tasks, checkpoints, progress, and granularity confidence within a bordered panel. It uses at most nine lines and approximately one third of the terminal height, leaving room for recent tool cards and the editor, and reports how many nodes are outside the visible area. An active task is marked with a filled circle. Alt+j and Alt+k move the selection, and Alt+h and Alt+l fold or unfold a node or move to its parent or child. Manual navigation makes the viewport follow the selected node, with active tasks retaining their execution marker.

The /taskbus command opens the full tree window, which supports narrow terminals, resizing, and Kitty-encoded keyboard input. In this window, j and k or the up and down arrows move through rows, h and l or the left and right arrows fold and unfold nodes or move between parents and children, and Esc or q closes the window. The slash key starts a search that retains ancestor paths for matching nodes, Enter or Esc finishes search input, and c clears the query. Outside search input, Enter toggles node details and recent history, o expands all nodes, z folds all nodes, and g or G moves to the first or last row. Folding changes are shared with the resident tree, and selection and folding state remain in memory until the extension is reloaded.

Task and checkpoint rows use separate visual cues for status, confidence, and selection: pending indicators and labels use the warning color, completed items use the success color, IDs and informational hints use muted tones, borders use a subdued tone, and the selected row combines a magenta marker and ID with a neutral title, bold text, and the theme's selection background. The summary line and active-work marker use cyan, with cyan and magenta lightness adapted to the theme appearance. Confidence values retain their own green, yellow, or red coloring so that a completed checkpoint can still show its frozen low-confidence score. Custom thresholds can choose warning or error colors. The /taskbus json command exposes the current state and /taskbus history shows recent events. Structural changes are made through task_manage.

All built-in interface text is English, including statuses, detail labels, shortcut hints, notifications, tool summaries, and default reminders. User-authored titles, completion summaries, reopening reasons, and custom reminder text retain their original language. Existing sessions keep the reminder configuration saved at initialization, so the English default reminders apply to newly initialized sessions.

The task_run card keeps a separate task/checkpoint attribution heading and delegates built-in tool output to the host's native renderers, allowing edit to show diffs, write to show source previews, and bash to show streaming output. Original arguments, result details, and shared call/result rendering state are passed through, including support for expanding output. Default-shell tools share a single card with one blank line above and below the combined call and result. Tools that draw their own shell retain their native framing.

The task_manage result uses a compact action summary with target or newly created IDs, progress, and confidence where available; warnings and errors remain visible, and expanded output includes the full JSON response. Other extension tools currently use a text fallback that shows at most eight output lines when collapsed. Delegation to arbitrary custom renderers requires further host integration.

## Configuration

Configuration is merged from built-in defaults, then the global taskbus.json in the Pi agent directory, then a trusted project's .pi/taskbus.json. The global path is usually ~/.pi/agent/taskbus.json, and the project path follows the host's configuration-directory name and is read only when the project is trusted. The taskbus.example.json file provides a complete example.

Scalar settings can be overridden individually, and a supplied thresholds array replaces the inherited array as a whole. Thresholds are processed in descending order of below, and both threshold IDs and numeric boundaries must be unique. Reminder prompts support the placeholders {taskId}, {checkpointId}, {title}, {confidence}, and {effort}.

Each session stores its effective configuration in an initialization event, and recovery, forks, and branch navigation continue using that saved configuration. Changes to configuration files therefore affect new sessions. Separate sessions maintain their own task trees.

## Persistence and recovery

Task changes are written as custom Pi session entries and replayed from the current branch, with an additional state snapshot stored every fifty events. Archived checkpoints and tool-execution audit records remain in history.

After work completes, accounting is first written to a recovery journal at <Pi agent dir>/taskbus-recovery/<session-key>.json and then committed to the session. If session persistence fails, later work is paused and the full tree remains available for inspecting the latest committed state. Once the underlying write problem is fixed, /taskbus recover replays or deduplicates the pending accounting. If the session has moved to another branch, return to the original branch before recovering.

The recovery journal stores accounting information, tool names, and call IDs. Pi's session records retain tool arguments and results. A process that exits during tool execution may leave no completion event, so the actual effects of that interrupted call need to be checked in the external system or filesystem.

## Compatibility and verification

Attribution covers work tools that pass through the tool-event chain in the current Pi process, including built-in tools, ordinary extension tools, and registered dynamic or MCP tools that support nested execution. Tools exposed only to the model require a dedicated adapter, and the gateway reports that limitation when they are requested. Independent subagent processes contribute the delegation call; accounting for their internal tool executions requires additional integration. Manual host commands such as ! and extensions that access Node.js APIs directly are outside the tool-event chain. If another task-panel extension is enabled, its model instructions and management tools should be coordinated with taskbus; trying this package on its own makes that behavior easier to assess.

Run `npm run validate` to perform TypeScript checks and the test suite, `npm pack --dry-run` to inspect the package contents, and `npm run test:package` to install a generated tarball into an isolated temporary project and load its extension through Pi. The package check verifies the manifest, changelog, and published file list, installs with host peers omitted, and uses the development host to verify that the installed extension registers both task tools and the taskbus command. GitHub Actions runs these checks on Node.js 22.19.0 and 24. Tests cover task constraints, confidence and reminders, splitting, branch replay, configuration, concurrent attribution, recovery failures, keyboard navigation, multilingual user content, colors, and narrow-terminal rendering. SDK tests use the real Pi 1.5.2 dispatcher with synthetic offline model responses to exercise built-in reads, parallel orchestration, nested calls, deferred tool registration, permission blocks, and error accounting. Renderer tests cover native diffs, source previews, streaming output, collapsed results, and English interface labels, and regular and fullscreen TUI tests use an in-memory terminal to check tool-card, resident-tree, and editor ordering as well as overlay resizing. Live MCP services and real model behavior still need to be exercised in the intended deployment environment. Maintainers can follow RELEASING.md in the repository for the npm publishing and Git tagging procedure.
