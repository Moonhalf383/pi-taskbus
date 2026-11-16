import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import taskbus, { ENTRY_TYPE } from "../src/index.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { TaskStore, nodeState } from "../src/model.ts";

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function tool(id: string, name: string, args: ToolCall["arguments"]): ToolCall { return { type: "toolCall", id, name, arguments: args }; }

test("real Pi SDK enforces attribution and executes built-in and nested tools offline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "taskbus-sdk-"));
  const agentDir = join(dir, "agent");
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [taskbus, (pi: ExtensionAPI) => {
      pi.on("session_start", () => {
        pi.registerTool({ name: "mcp__fixture__lookup", label: "MCP fixture", description: "Late-registered deferred tool", exposure: "deferred", parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "late tool result" }], details: {} }; } });
      });
      pi.on("tool_call", (event) => {
        if (event.toolName === "bash" && event.input.command === "blocked-by-permission") return { block: true, reason: "permission denied" };
      });
      pi.registerTool({
        name: "nested_probe", label: "nested", description: "Test nested work", parameters: Type.Object({}),
        async execute(_id, _args, signal, _update, ctx) {
          const result = await ctx.executeTool("read", { path: "fixture.txt" }, { signal });
          return { content: result.result.content, details: {}, isError: result.isError };
        },
      });
      pi.registerTool({ name: "model_only_probe", label: "model-only", description: "Test model-only compatibility", exposure: "model-only", parameters: Type.Object({}), async execute() { throw new Error("should be rejected before execution"); } });
    }],
  });
  let dispose: (() => void) | undefined;
  try {
    writeFileSync(join(dir, "fixture.txt"), "taskbus fixture\n");
    await loader.reload();
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
    await runtime.setRuntimeApiKey("anthropic", "offline-test-key");
    const manager = SessionManager.inMemory(dir);
    const model = getModel("anthropic", "claude-sonnet-4-5");
    assert.ok(model);
    const { session, extensionsResult } = await createAgentSession({ cwd: dir, agentDir, resourceLoader: loader, modelRuntime: runtime, model, thinkingLevel: "off", settingsManager, sessionManager: manager });
    dispose = () => session.dispose();
    assert.deepEqual(extensionsResult.errors, []);
    const extensionErrors: string[] = [];
    await session.bindExtensions({ mode: "print", onError: (error) => extensionErrors.push(error.error) });
    const responses: ToolCall[][] = [
      [tool("unbound", "read", { path: "fixture.txt" })],
      [tool("plan", "task_manage", { action: "task_create", pageId: "P-1", title: "SDK 验证", checkpoints: ["内置读取", "嵌套读取"] })],
      [tool("run1", "task_run", { taskId: "T-1", checkpointId: "CP-1", tool: "read", args: { path: "fixture.txt" } }), tool("run2", "task_run", { taskId: "T-1", checkpointId: "CP-2", tool: "nested_probe", args: {} })],
      [tool("invalid", "task_run", { taskId: "T-1", checkpointId: "CP-1", tool: "read", args: {} })],
      [tool("modelonly", "task_run", { taskId: "T-1", checkpointId: "CP-1", tool: "model_only_probe", args: {} })],
      [tool("late", "task_run", { taskId: "T-1", checkpointId: "CP-2", tool: "mcp__fixture__lookup", args: {} })],
      [tool("blocked", "task_run", { taskId: "T-1", checkpointId: "CP-2", tool: "bash", args: { command: "blocked-by-permission" } })],
      [tool("missing", "task_run", { taskId: "T-1", checkpointId: "CP-2", tool: "read", args: { path: "missing.txt" } })],
      [tool("done", "task_manage", { action: "complete", checkpointId: "CP-1", summary: "成功读取 fixture" })],
      [tool("page", "task_manage", { action: "page_create", title: "SDK page" })],
      [tool("dependent", "task_manage", { action: "task_create", pageId: "P-2", title: "Dependent", dependencies: [{ id: "CP-1", kind: "strict" }], checkpoints: ["work"] })],
      [tool("depRun", "task_run", { taskId: "T-2", checkpointId: "CP-3", tool: "read", args: { path: "fixture.txt" } })],
      [tool("ignoreBlocked", "task_manage", { action: "ignore", id: "CP-1", ignored: true, reason: "Protected prerequisite" })],
      [tool("invalidate", "task_manage", { action: "reopen", checkpointId: "CP-1", reason: "Upstream changed" })],
      [tool("dirtyRun", "task_run", { taskId: "T-2", checkpointId: "CP-3", tool: "read", args: { path: "fixture.txt" } })],
      [tool("repair", "task_manage", { action: "refresh", id: "T-2", dependencies: [], summary: "Independent evidence" })],
      [tool("ignored", "task_manage", { action: "ignore", id: "CP-3", ignored: true, reason: "Deferred" })],
      [tool("ignoredRun", "task_run", { taskId: "T-2", checkpointId: "CP-3", tool: "read", args: { path: "fixture.txt" } })],
      [tool("restore", "task_manage", { action: "ignore", id: "CP-3", ignored: false, reason: "Resume" })],
      [tool("refreshCP", "task_manage", { action: "refresh", id: "CP-3", summary: "Reviewed" })],
      [tool("restoredRun", "task_run", { taskId: "T-2", checkpointId: "CP-3", tool: "read", args: { path: "fixture.txt" } })],
      [tool("ready", "task_manage", { action: "available", pageId: "P-2", includeBlocked: true })],
      [],
    ];
    session.agent.streamFunction = () => {
      const content = responses.shift();
      assert.ok(content, "unexpected model request");
      const message: AssistantMessage = { role: "assistant", content: content.length ? content : [{ type: "text", text: "完成" }], api: "anthropic-messages", provider: "anthropic", model: model.id, usage: structuredClone(zeroUsage), stopReason: content.length ? "toolUse" : "stop", timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: content.length ? "toolUse" : "stop", message });
      return stream;
    };
    await session.prompt("离线验证 taskbus");
    assert.deepEqual(extensionErrors, []);
    const results = session.messages.filter((message) => message.role === "toolResult");
    const unbound = results.find((message) => message.toolCallId === "unbound")!;
    assert.equal(unbound.isError, true);
    assert.match(JSON.stringify(unbound.content), /task_run/);
    const run1 = results.find((message) => message.toolCallId === "run1")!;
    assert.equal(run1.isError, false);
    assert.match(JSON.stringify(run1.content), /taskbus fixture/);
    const run2 = results.find((message) => message.toolCallId === "run2")!;
    assert.equal(run2.isError, false);
    assert.equal(results.find((message) => message.toolCallId === "invalid")!.isError, true);
    assert.match(JSON.stringify(results.find((message) => message.toolCallId === "modelonly")!.content), /model-only/);
    const entries = manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE).map((entry) => entry.type === "custom" ? entry.data : undefined);
    const restored = TaskStore.restore(entries, DEFAULT_CONFIG, () => {});
    assert.equal(restored.state.checkpoints["CP-1"].effort, 1);
    assert.equal(restored.state.checkpoints["CP-2"].effort, 3);
    assert.equal(results.find((message) => message.toolCallId === "late")!.isError, false);
    assert.equal(results.find((message) => message.toolCallId === "blocked")!.isError, true);
    assert.equal(results.find((message) => message.toolCallId === "missing")!.isError, true);
    assert.equal(restored.state.checkpoints["CP-1"].status, "pending");
    assert.equal(restored.state.pages.length, 2);
    assert.equal(restored.state.pageByTask["T-2"], "P-2");
    assert.equal(restored.state.checkpoints["CP-3"].effort, 2);
    assert.equal(nodeState(restored.state, "CP-3").dirty, false);
    for (const callId of ["ignoreBlocked", "dirtyRun", "ignoredRun"]) assert.equal(results.find((item) => item.toolCallId === callId)!.isError, true);
    for (const callId of ["depRun", "repair", "refreshCP", "restoredRun", "ready"]) assert.equal(results.find((item) => item.toolCallId === callId)!.isError, false);
    const ready = results.find((item) => item.toolCallId === "ready")!;
    assert.match(JSON.stringify(ready.content), /available/);
    const records = restored.history.filter((entry) => entry.event.type === "work_recorded");
    assert.equal(records.length, 7);
    assert.equal(records.filter((entry) => entry.event.type === "work_recorded" && entry.event.units === 0).length, 1);
    const planEntry = manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "plan");
    assert.ok(planEntry);
    await session.navigateTree(planEntry.id, { summarize: false });
    const branchEntries = manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE).map((entry) => entry.type === "custom" ? entry.data : undefined);
    const historical = TaskStore.restore(branchEntries, DEFAULT_CONFIG, () => {});
    assert.equal(historical.state.checkpoints["CP-1"].effort, 0);
    assert.equal(historical.state.checkpoints["CP-1"].status, "pending");
    assert.equal(historical.state.config.decay, 0.95);
  } finally { dispose?.(); rmSync(dir, { recursive: true, force: true }); }
});
