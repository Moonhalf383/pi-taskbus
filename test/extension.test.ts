import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import taskbus, { ENTRY_TYPE } from "../src/index.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { TaskStore, type Envelope } from "../src/model.ts";

// This harness exposes lifecycle fault injection; sdk.test.ts exercises Pi's real dispatcher.
function harness() {
  const dir = mkdtempSync(join(tmpdir(), "taskbus-extension-"));
  const all: { type: "custom"; customType: string; data: Envelope }[] = [];
  let branch = all;
  let appendFails = false;
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const widgets = new Map<string, any>();
  const widgetCalls: { key: string; placement?: string }[] = [];
  let requestedRenders = 0;
  const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
  const pi = {
    on: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, handler); },
    registerTool: (definition: any) => tools.set(definition.name, definition),
    registerCommand: (name: string, definition: any) => commands.set(name, definition),
    registerShortcut: (key: string, definition: any) => shortcuts.set(key, definition),
    appendEntry: (customType: string, data: Envelope) => {
      if (appendFails) throw new Error("injected append failure");
      const entry = { type: "custom" as const, customType, data: structuredClone(data) };
      all.push(entry);
      if (branch !== all) branch.push(entry);
    },
    getAllTools: () => [{ name: "read", exposure: "direct", parameters: {}, description: "Read" }],
    sendMessage: () => {},
  } as unknown as ExtensionAPI;
  const sessionId = randomUUID();
  const ctx = {
    cwd: dir, mode: "tui", hasUI: true, isProjectTrusted: () => true,
    sessionManager: { getBranch: () => branch, getEntries: () => all, getSessionFile: () => join(dir, "session.jsonl"), getSessionId: () => sessionId },
    ui: {
      setWidget: (key: string, factory: any, options?: { placement?: string }) => {
        widgetCalls.push({ key, placement: options?.placement });
        if (factory === undefined) widgets.delete(key);
        else widgets.set(key, typeof factory === "function" ? factory({ terminal: { rows: 30 }, requestRender() { requestedRenders++; } }, theme) : factory);
      }, notify: () => {},
      custom: async (factory: any) => {
        const component = factory({ requestRender() {}, terminal: { rows: 24 } }, theme, {}, () => {});
        assert.ok(component.render(80).length);
        component.handleInput("j");
        assert.ok(component.render(40).length);
      },
    },
    tools: [{ name: "read" }],
    executeTool: async () => {
      await assert.rejects(() => tools.get("task_manage").execute("concurrent", { action: "complete", checkpointId: "CP-1", summary: "尝试并发完成" }, undefined, undefined, ctx), /active work/);
      const event = { toolCallId: "root/0", parentToolCallId: "root", toolName: "read", input: {} };
      assert.equal(await handlers.get("tool_call")!(event, ctx), undefined);
      handlers.get("tool_result")!({ ...event }, ctx);
      handlers.get("tool_execution_end")!({ ...event, isError: false, durationMs: 1 }, ctx);
      return { result: { content: [{ type: "text", text: "ok" }], details: {} }, isError: false };
    },
  };
  taskbus(pi);
  return { dir, all, ctx, handlers, tools, commands, shortcuts, widgets, widgetCalls, renders: () => requestedRenders, setBranch: (value: typeof all) => { branch = value; }, fail: (value: boolean) => { appendFails = value; } };
}

test("resident task tree installs once above editor and refreshes from live state", async () => {
  const h = harness();
  try {
    h.handlers.get("session_start")!({}, h.ctx);
    const panel = h.widgets.get("taskbus");
    assert.equal(h.widgetCalls[0].placement, "aboveEditor");
    assert.match(panel.render(90).join("\n"), /No tasks yet/);
    await h.tools.get("task_manage").execute("create", { action: "task_create", title: "可见任务", checkpoints: ["可见验收"] }, undefined, undefined, h.ctx);
    assert.equal(h.widgets.get("taskbus"), panel);
    assert.equal(h.widgetCalls.length, 1);
    assert.match(panel.render(90).join("\n"), /可见验收/);
    assert.ok(h.renders() > 1);
    h.handlers.get("session_shutdown")!({}, h.ctx);
    assert.equal(h.widgets.has("taskbus"), false);
  } finally { rmSync(h.dir, { recursive: true }); }
});

test("resident shortcuts move selection and fold without opening a dialog", async () => {
  const h = harness();
  try {
    h.handlers.get("session_start")!({}, h.ctx);
    await h.tools.get("task_manage").execute("create", { action: "task_create", title: "快捷键任务", checkpoints: Array.from({ length: 20 }, (_, i) => `验收 ${i}`) }, undefined, undefined, h.ctx);
    const panel = h.widgets.get("taskbus");
    await h.shortcuts.get("alt+j").handler(h.ctx);
    assert.match(panel.render(90).join("\n"), />.*CP-1/);
    for (let i = 0; i < 15; i++) await h.shortcuts.get("alt+j").handler(h.ctx);
    assert.match(panel.render(90).join("\n"), />.*CP-16/);
    await h.shortcuts.get("alt+k").handler(h.ctx);
    assert.match(panel.render(90).join("\n"), />.*CP-15/);
    await h.shortcuts.get("alt+h").handler(h.ctx);
    await h.shortcuts.get("alt+h").handler(h.ctx);
    assert.equal(panel.render(90).join("\n").includes("CP-1"), false);
    await h.shortcuts.get("alt+l").handler(h.ctx);
    assert.match(panel.render(90).join("\n"), /CP-1/);
    assert.equal(h.widgetCalls.length, 1);
  } finally { rmSync(h.dir, { recursive: true }); }
});

test("navigating before initialization preserves the session's original config", () => {
  const h = harness();
  try {
    const log: Envelope[] = [];
    const seed = new TaskStore({ ...DEFAULT_CONFIG, decay: 0.91 }, (entry) => log.push(entry));
    seed.commit({ type: "initialized", config: { ...DEFAULT_CONFIG, decay: 0.91 } });
    h.all.push({ type: "custom", customType: ENTRY_TYPE, data: log[0] });
    h.handlers.get("session_start")!({}, h.ctx);
    h.setBranch([]);
    h.handlers.get("session_tree")!({}, h.ctx);
    const entry = h.all.at(-1)!.data;
    assert.equal(entry.event.type, "initialized");
    if (entry.event.type === "initialized") assert.equal(entry.event.config.decay, 0.91);
  } finally { rmSync(h.dir, { recursive: true }); }
});

test("failed accounting remains inspectable and recovers before work resumes", async () => {
  const h = harness();
  try {
    h.handlers.get("session_start")!({}, h.ctx);
    await h.tools.get("task_manage").execute("manage", { action: "task_create", title: "任务", checkpoints: ["验收"] }, undefined, undefined, h.ctx);
    h.fail(true);
    const outcome = await h.tools.get("task_run").execute("root", { taskId: "T-1", checkpointId: "CP-1", tool: "read", args: {} }, undefined, undefined, h.ctx);
    assert.equal(outcome.isError, true);
    await h.commands.get("taskbus").handler("", h.ctx);
    assert.throws(() => h.handlers.get("tool_call")!({ toolName: "read", toolCallId: "direct" }, h.ctx), /persistence error/);
    h.fail(false);
    await h.commands.get("taskbus").handler("recover", h.ctx);
    const store = TaskStore.restore(h.all.map((entry) => entry.data), DEFAULT_CONFIG, () => {});
    assert.equal(store.state.checkpoints["CP-1"].effort, 1);
    assert.equal(h.handlers.get("tool_call")!({ toolName: "task_manage", toolCallId: "inspect" }, h.ctx), undefined);
  } finally { rmSync(h.dir, { recursive: true }); }
});
