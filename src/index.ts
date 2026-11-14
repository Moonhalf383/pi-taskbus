import { CONFIG_DIR_NAME, getAgentDir, truncateHead, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { WorkRecovery } from "./recovery.ts";
import { createRunRenderers } from "./renderers.ts";
import { createManageRenderers } from "./manage-renderers.ts";
import { Attribution } from "./attribution.ts";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { TaskStore, affectedTasks, assertUnlocked, metrics, type Event } from "./model.ts";
import { TaskPanelComponent, TaskTreeComponent, newViewState, navigateTree, overlayHeight, safeText } from "./view.ts";

export const ENTRY_TYPE = "pi-taskbus.event.v1";
const MANAGEMENT = new Set(["task_manage"]);
const string = () => Type.String({ minLength: 1, maxLength: 8000 });
const id = () => Type.String({ minLength: 1 });
const ActionSchema = Type.Union([
  Type.Object({ action: Type.Literal("list"), taskId: Type.Optional(id()) }),
  Type.Object({ action: Type.Literal("history"), id: Type.Optional(id()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
  Type.Object({ action: Type.Literal("tools"), query: Type.Optional(Type.String()) }),
  Type.Object({ action: Type.Literal("task_create"), title: string(), parentId: Type.Optional(id()), checkpoints: Type.Array(string(), { maxItems: 100 }) }),
  Type.Object({ action: Type.Literal("checkpoint_add"), taskId: id(), title: string() }),
  Type.Object({ action: Type.Literal("rename"), id: id(), title: string() }),
  Type.Object({ action: Type.Literal("complete"), checkpointId: id(), summary: string() }),
  Type.Object({ action: Type.Literal("reopen"), checkpointId: id(), reason: string() }),
  Type.Object({ action: Type.Literal("checkpoint_split"), checkpointId: id(), parts: Type.Array(Type.Object({ title: string(), share: Type.Optional(Type.Number({ exclusiveMinimum: 0 })) }), { minItems: 2, maxItems: 100 }) }),
  Type.Object({ action: Type.Literal("task_split"), taskId: id(), groups: Type.Array(Type.Object({ title: string(), checkpointIds: Type.Array(id(), { maxItems: 1000 }) }), { minItems: 2, maxItems: 100 }) }),
]);
// Providers require an object at the tool-schema root. Validate action-specific fields in execute.
const ManagementSchema = Type.Object({
  action: Type.Union(["list", "history", "tools", "task_create", "checkpoint_add", "rename", "complete", "reopen", "checkpoint_split", "task_split"].map((value) => Type.Literal(value))),
  taskId: Type.Optional(id()), checkpointId: Type.Optional(id()), id: Type.Optional(id()),
  title: Type.Optional(string()), parentId: Type.Optional(id()), query: Type.Optional(Type.String()),
  checkpoints: Type.Optional(Type.Array(string(), { maxItems: 100 })),
  summary: Type.Optional(string()), reason: Type.Optional(string()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  parts: Type.Optional(Type.Array(Type.Object({ title: string(), share: Type.Optional(Type.Number({ exclusiveMinimum: 0 })) }), { minItems: 2, maxItems: 100 })),
  groups: Type.Optional(Type.Array(Type.Object({ title: string(), checkpointIds: Type.Array(id(), { maxItems: 1000 }) }), { minItems: 2, maxItems: 100 })),
});
const RunSchema = Type.Object({
  taskId: id(), checkpointId: id(), tool: Type.String({ minLength: 1 }),
  args: Type.Record(Type.String(), Type.Unknown()),
});

function jsonResult(data: unknown) {
  const output = truncateHead(JSON.stringify(data, null, 2), { maxBytes: 40_000, maxLines: 1000 });
  return { content: [{ type: "text" as const, text: output.content + (output.truncated ? "\n[Output truncated; narrow the query using taskId or limit]" : "") }], details: data };
}

export default function taskbus(pi: ExtensionAPI): void {
  let store: TaskStore | undefined;
  let failure: string | undefined;
  let recovery: WorkRecovery | undefined;
  let view = newViewState();
  let changed: (() => void) | undefined;
  let updatePanel: (() => void) | undefined;
  const attribution = new Attribution(MANAGEMENT);
  const persist = (entry: Parameters<ExtensionAPI["appendEntry"]>[1]) => pi.appendEntry(ENTRY_TYPE, entry);
  function ready(): TaskStore {
    if (failure) throw new Error(`Taskbus initialization or persistence error: ${failure}`);
    if (!store) throw new Error("Taskbus is waiting for session initialization");
    return store;
  }
  function refresh(ctx: ExtensionContext): void {
    changed?.();
    if (ctx.mode !== "tui") return;
    if (!updatePanel) {
      ctx.ui.setWidget("taskbus", (tui, theme) => {
        const panel = new TaskPanelComponent({
          state: () => store?.state,
          activeTasks: () => [...new Set(attribution.activeTasks())],
          failure: () => failure,
        }, view, theme, () => tui.terminal.rows);
        updatePanel = () => { panel.invalidate(); tui.requestRender(); };
        return panel;
      }, { placement: "aboveEditor" });
    }
    updatePanel?.();
  }
  function restore(ctx: ExtensionContext): void {
    attribution.clear();
    failure = undefined;
    try {
      const entries = ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE).map((entry) => entry.type === "custom" ? entry.data : undefined);
      if (entries.length) store = TaskStore.restore(entries, DEFAULT_CONFIG, persist);
      else {
        const original = ctx.sessionManager.getEntries().find((entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE && (entry.data as { event?: Event })?.event?.type === "initialized");
        const originalEvent = original?.type === "custom" ? (original.data as { event: Event }).event : undefined;
        const config = originalEvent?.type === "initialized" ? originalEvent.config : loadConfig(getAgentDir(), ctx.cwd, CONFIG_DIR_NAME, ctx.isProjectTrusted());
        store = new TaskStore(config, persist);
        store.commit({ type: "initialized", config });
      }
      const sessionKey = createHash("sha256").update(ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId()).digest("hex");
      recovery = new WorkRecovery(join(getAgentDir(), "taskbus-recovery", `${sessionKey}.json`));
      recovery.recover(store);
    } catch (error) {
      failure = (error as Error).message;
      if (ctx.hasUI) ctx.ui.notify(`Taskbus: ${safeText(failure)}`, "error");
    }
    refresh(ctx);
  }
  pi.on("session_start", (_event, ctx) => { view = newViewState(); restore(ctx); });
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    attribution.clear();
    changed = undefined;
    updatePanel = undefined;
    if (ctx.mode === "tui") ctx.ui.setWidget("taskbus", undefined);
  });

  pi.on("tool_call", (event) => {
    const reason = attribution.gate(event, ready().state);
    if (reason) return { block: true, reason };
  });
  pi.on("tool_result", (event) => { attribution.executed(event.toolCallId); });
  pi.on("tool_execution_end", (event, ctx) => {
    const record = attribution.end(event.toolCallId, event.isError, event.durationMs);
    if (!record) return;
    try {
      if (!store || !recovery) throw new Error("Work recovery journal is not ready");
      const notices = recovery.record(store, { type: "work_recorded", ...record });
      attribution.notify(event.toolCallId, notices);
      refresh(ctx);
    } catch (error) {
      failure = (error as Error).message;
      attribution.notify(event.toolCallId, [`Taskbus tracking failed: ${failure}. Fix the issue, then recover the session.`]);
      if (ctx.hasUI) ctx.ui.notify(`Taskbus: ${safeText(failure)}`, "error");
      refresh(ctx);
    }
  });
  pi.on("before_agent_start", (event) => {
    const current = ready();
    event.systemPromptOptions.sections["taskbus"] = [
      "<taskbus>",
      "All work tools must run through task_run with an explicit leaf taskId and pending checkpointId. Create tasks and acceptance checkpoints using task_manage first.",
      "Use task_manage for task management: list/history/tools/task_create/checkpoint_add/rename/complete/reopen/checkpoint_split/task_split.",
      "task_run supports nestable in-process tools. Inspect names, parameters, promptGuidelines and compatibility with task_manage tools, and follow the target tool guidelines. Each executed leaf work call multiplies granularity confidence by the session decay factor.",
      "Low confidence suggests a checkpoint may hide untracked work. Refine tracking when reminded; splitting preserves and distributes historical effort. Include a result summary when completing checkpoints.",
      "Independent subagents count only the delegation call; in-process nested tools inherit attribution. Submit task mutations and task_run in separate rounds, waiting for returned IDs before using them.",
      `Current summary: ${JSON.stringify(metrics(current.state))}. Use task_manage list to inspect the task tree.`,
      "</taskbus>",
    ].join("\n");
  });

  pi.registerTool({
    name: "task_manage", label: "Taskbus Manage", parameters: ManagementSchema,
    description: "Manage the session task tree. Actions and required fields: list(taskId?); history(id?,limit?); tools(query?); task_create(title,checkpoints:string[],parentId?); checkpoint_add(taskId,title); rename(id,title); complete(checkpointId,summary); reopen(checkpointId,reason); checkpoint_split(checkpointId,parts:[{title,share?}]); task_split(taskId,groups:[{title,checkpointIds}]). Splits require at least two parts. Supply all shares or omit all. task_split assigns every active checkpoint exactly once. Plan checkpoints before work; tools returns original schemas and guidelines.",
    promptSnippet: "Create and manage task trees, checkpoints, splits and execution history",
    promptGuidelines: ["Use task_manage to create a leaf task and checkpoints before executing work through task_run. Provide a result summary when using task_manage complete."],
    executionMode: "sequential",
    async execute(_callId, input, _signal, _onUpdate, ctx) {
      const params: unknown = input;
      if (!Check(ActionSchema, params)) throw new Error("task_manage arguments do not match the action; provide the required fields in the tool description");
      const current = ready();
      if (params.action === "list") {
        const taskIds: string[] = [];
        const stack = params.taskId ? [params.taskId] : [...current.state.roots];
        while (stack.length) {
          const taskId = stack.pop()!;
          const task = current.state.tasks[taskId];
          if (!task) throw new Error(`Task ${taskId} was not found`);
          taskIds.push(taskId);
          if (task.kind === "branch") stack.push(...task.childIds);
        }
        return jsonResult({ revision: current.state.revision, config: current.state.config, tasks: taskIds.map((taskId) => {
          const task = current.state.tasks[taskId];
          return { ...task, metrics: metrics(current.state, taskId), ...(task.kind === "leaf" ? { checkpoints: task.checkpointIds.map((id) => current.state.checkpoints[id]) } : {}) };
        }) });
      }
      if (params.action === "history") {
        const history = current.history.filter((entry) => !params.id || JSON.stringify(entry.event).includes(`"${params.id}"`)).slice(-(params.limit ?? 20));
        return jsonResult(history);
      }
      if (params.action === "tools") {
        const query = params.query?.toLowerCase() ?? "";
        return jsonResult(pi.getAllTools().filter((tool) => !MANAGEMENT.has(tool.name) && tool.name !== "task_run" && `${tool.name} ${tool.description}`.toLowerCase().includes(query)).map((tool) => ({
          name: tool.name, description: tool.description, parameters: tool.parameters, exposure: tool.exposure, promptGuidelines: tool.promptGuidelines,
          callable: ctx.tools.some((item) => item.name === tool.name),
          guidance: tool.exposure === "model-only" ? "model-only tools require a dedicated adapter" : "Call through task_run; direct tools must remain active",
        })));
      }
      let change: Event;
      switch (params.action) {
        case "task_create": change = { type: "task_created", ...params }; break;
        case "checkpoint_add": change = { type: "checkpoint_added", ...params }; break;
        case "rename": change = { type: "renamed", ...params }; break;
        case "complete": change = { type: "checkpoint_completed", id: params.checkpointId, summary: params.summary }; break;
        case "reopen": change = { type: "checkpoint_reopened", id: params.checkpointId, reason: params.reason }; break;
        case "checkpoint_split": change = { type: "checkpoint_split", id: params.checkpointId, parts: params.parts }; break;
        case "task_split": change = { type: "task_split", ...params }; break;
      }
      assertUnlocked(current.state, affectedTasks(current.state, change), attribution.activeTasks());
      const result = current.commit(change);
      refresh(ctx);
      return jsonResult({ revision: result.state.revision, ids: result.ids, notices: result.notices, metrics: metrics(result.state) });
    },
    ...createManageRenderers(),
  });

  pi.registerTool({
    name: "task_run", label: "Taskbus Run", parameters: RunSchema,
    description: "Execute a work tool under a pending checkpoint of a leaf task. Requires taskId, checkpointId, tool and original tool args. Use task_manage tools to inspect schemas. Tracks nested calls, effort and granularity confidence.",
    promptSnippet: "Enforce task/checkpoint attribution for work tools",
    exposure: "model-only",
    reachesTools: () => "all",
    prepareLoadout(loadout) {
      return {
        hiddenDeclarations: loadout.declared.filter((tool) => tool.name !== "task_run" && !MANAGEMENT.has(tool.name)).map((tool) => tool.name),
      };
    },
    async execute(callId, params, signal, onUpdate, ctx) {
      const current = ready();
      if (MANAGEMENT.has(params.tool) || params.tool === "task_run") throw new Error("Call task management tools directly");
      const tool = pi.getAllTools().find((item) => item.name === params.tool);
      if (!ctx.tools.some((item) => item.name === params.tool)) {
        throw new Error(tool?.exposure === "model-only"
          ? `${params.tool} is model-only; a dedicated adapter is required to execute it through task_run`
          : `${params.tool} is not callable through task_run; inspect task_manage tools and enable the tool or MCP server`);
      }
      attribution.begin(callId, params, current.state);
      refresh(ctx);
      try {
        const outcome = await ctx.executeTool(params.tool, params.args, { signal, onUpdate });
        const audit = attribution.finish(callId);
        const notices = [...audit.notices, ...(failure ? [`Taskbus tracking error: ${failure}`] : [])];
        return {
          ...outcome.result,
          content: [...outcome.result.content, ...(notices.length ? [{ type: "text" as const, text: `\n[Taskbus]\n${notices.join("\n")}` }] : [])],
          details: { taskbus: { taskId: params.taskId, checkpointId: params.checkpointId, records: audit.records, notices }, original: outcome.result.details },
          isError: outcome.isError || Boolean(failure),
          // Pi automatically aggregates nested usage onto task_run.
          usage: undefined,
        };
      } finally {
        attribution.finish(callId);
        refresh(ctx);
      }
    },
    ...createRunRenderers(),
  });

  for (const [key, action, description] of [
    ["alt+j", "down", "Move down in the resident task tree"], ["alt+k", "up", "Move up in the resident task tree"],
    ["alt+h", "left", "Fold a resident task tree node"], ["alt+l", "right", "Unfold a resident task tree node"],
  ] as const) {
    pi.registerShortcut(key, { description, handler: async (ctx) => {
      if (ctx.mode !== "tui" || !store) return;
      navigateTree(store.state, view, action);
      refresh(ctx);
    } });
  }

  pi.registerCommand("taskbus", {
    description: "Open the task tree (jk move, hl fold/unfold, Esc close); /taskbus json or history inspects data",
    handler: async (args, ctx) => {
      if (args.trim() === "recover") {
        if (attribution.activeTasks().length) { ctx.ui.notify("Wait for active work calls to finish before retrying recovery", "warning"); return; }
        restore(ctx);
        if (!failure) ctx.ui.notify("Taskbus work accounting recovered", "info");
        return;
      }
      const current = store;
      if (!current) { ctx.ui.notify(`Taskbus: ${safeText(failure ?? "Waiting for initialization")}`, "error"); return; }
      if (args.trim() === "json" || args.trim() === "history") {
        const data = args.trim() === "json" ? current.state : current.history.slice(-20);
        pi.sendMessage({ customType: "taskbus-inspect", content: JSON.stringify(data, null, 2), display: true }, { triggerTurn: false });
        return;
      }
      if (ctx.mode !== "tui") { ctx.ui.notify("The full task tree requires TUI mode; use /taskbus json to inspect data", "warning"); return; }
      try {
        await ctx.ui.custom<void>((tui, theme, _keys, done) => {
          changed = () => tui.requestRender();
          return new TaskTreeComponent({ state: () => store?.state ?? current.state, history: () => store?.history ?? current.history }, view, theme,
            () => { tui.requestRender(); updatePanel?.(); }, () => overlayHeight(tui.terminal.rows), () => done());
        }, { overlay: true, overlayOptions: { width: "95%", anchor: "center", margin: 1 } });
      } finally { changed = undefined; updatePanel?.(); }
    },
  });
}
