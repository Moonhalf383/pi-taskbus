import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { createManageRenderers } from "../src/manage-renderers.ts";

type Context = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
function context(args: Record<string, unknown>): Context {
  return { args, state: {}, cwd: process.cwd(), toolCallId: "test", executionStarted: true, lastComponent: undefined, durationMs: 1,
    argsComplete: true, isPartial: false, expanded: false, showImages: false, isError: false,
    outputPad: 1, invalidate() {}, keyHint: (_key, label) => `Ctrl+O ${label}`, keyText: () => "" };
}
const plain = (component: Component) => component.render(140).join("\n");

test("management summary replaces pending heading and expands raw details", () => {
  const renderer = createManageRenderers();
  const ctx = context({ action: "task_create", title: "用户标题" });
  const call = renderer.renderCall!(ctx.args, theme, ctx);
  assert.match(plain(call), /Created task/);
  const result = { content: [{ type: "text" as const, text: '{"revision":1}' }], details: {
    ids: ["T-1", "CP-1"], metrics: { completed: 0, total: 1, progress: 0, confidence: 1 }, notices: ["Consider splitting"] } };
  const compact = renderer.renderResult!(result, { expanded: false, isPartial: false }, theme, ctx);
  assert.equal(plain(call), "");
  assert.match(plain(compact), /Created task → T-1, CP-1 · 用户标题/);
  assert.match(plain(compact), /0\/1 0% · C:100%/);
  assert.match(plain(compact), /Consider splitting/);
  assert.doesNotMatch(plain(compact), /revision/);
  const expanded = renderer.renderResult!(result, { expanded: true, isPartial: false }, theme, ctx);
  assert.match(plain(expanded), /revision/);
  for (const line of compact.render(30)) assert.ok(visibleWidth(line) <= 30);
});

test("query summaries and error messages use English labels", () => {
  const renderer = createManageRenderers();
  for (const action of ["list", "history", "tools"]) {
    const ctx = context({ action });
    const result = renderer.renderResult!({ content: [{ type: "text", text: "raw output" }], details: action === "list" ? { tasks: [{ id: "T-1" }] } : [{}] }, { expanded: false, isPartial: false }, theme, ctx);
    assert.match(plain(result), /1 items/);
    assert.match(plain(result), /show details/);
    assert.doesNotMatch(plain(result), /\p{Script=Han}/u);
    assert.doesNotMatch(plain(result), /raw output/);
  }
  const ctx = { ...context({ action: "complete", checkpointId: "CP-1" }), isError: true };
  const result = renderer.renderResult!({ content: [{ type: "text", text: "Checkpoint was not found" }], details: undefined }, { expanded: false, isPartial: false }, theme, ctx);
  assert.match(plain(result), /✗ Completed checkpoint CP-1/);
  assert.match(plain(result), /Checkpoint was not found/);
});
