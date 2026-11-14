import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { createRunRenderers } from "../src/renderers.ts";

initTheme("dark", false);
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
type Context = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
function context(tool: string, args: Record<string, unknown>): Context {
  return {
    args: { taskId: "T-1", checkpointId: "CP-1", tool, args },
    toolCallId: "test", state: {}, lastComponent: undefined, cwd: process.cwd(),
    executionStarted: true, argsComplete: false, isPartial: false, expanded: true,
    showImages: false, isError: false, durationMs: 2, outputPad: 1,
    invalidate() {}, keyHint: () => "", keyText: () => "",
  };
}
function plain(component: Component): string { return component.render(100).map(stripTerminalSequences).join("\n"); }

test("task_run edit renderer receives original args, diff details and shared native state", () => {
  const renderer = createRunRenderers();
  const ctx = context("edit", { path: "fixture.ts", edits: [{ oldText: "before", newText: "after" }] });
  const call = renderer.renderCall!(ctx.args, theme, ctx);
  assert.match(plain(call), /Taskbus T-1\/CP-1/);
  assert.match(plain(call), /edit.*fixture.ts/);
  const result = renderer.renderResult!({ content: [{ type: "text", text: "edited" }], details: {
    original: { diff: "-1 before\n+1 after", firstChangedLine: 1 }, taskbus: { notices: [] },
  } }, { expanded: true, isPartial: false }, theme, ctx);
  const output = plain(call) + plain(result);
  assert.match(output, /before/);
  assert.match(output, /after/);
  assert.equal(output.includes('"original"'), false);
});

test("default tool call and result share a card with exactly one padding pair", () => {
  const renderer = createRunRenderers();
  const ctx = context("read", { path: "fixture.txt" });
  const call = renderer.renderCall!(ctx.args, theme, ctx);
  const result = renderer.renderResult!({ content: [{ type: "text", text: "fixture output" }], details: { original: {}, taskbus: { notices: [] } } }, { expanded: true, isPartial: false }, theme, ctx);
  const lines = call.render(100).map(stripTerminalSequences);
  assert.match(lines[0], /Taskbus/);
  assert.equal(lines[1].trim(), "");
  assert.equal(lines.at(-1)!.trim(), "");
  assert.match(lines.join("\n"), /fixture output/);
  assert.equal(result.render(100).length, 0);
});

test("task_run write renderer displays source preview and expansion", () => {
  const renderer = createRunRenderers();
  const ctx = context("write", { path: "fixture.txt", content: Array.from({ length: 20 }, (_, i) => `source line ${i}`).join("\n") });
  const expanded = renderer.renderCall!(ctx.args, theme, ctx);
  assert.match(plain(expanded), /source line 19/);
  const compact = renderer.renderCall!(ctx.args, theme, { ...ctx, expanded: false });
  assert.match(plain(compact), /more lines/);
  assert.equal(plain(compact).includes("source line 19"), false);
});

test("streaming tool result uses raw details and renders partial bash output", () => {
  const renderer = createRunRenderers();
  const ctx = context("bash", { command: "printf hello" });
  const call = renderer.renderCall!(ctx.args, theme, ctx);
  const output = renderer.renderResult!({ content: [{ type: "text", text: "streaming hello" }], details: {} }, { expanded: true, isPartial: true }, theme, { ...ctx, isPartial: true });
  assert.match(plain(call) + plain(output), /streaming hello/);
  renderer.renderResult!({ content: [{ type: "text", text: "done" }], details: { original: {}, taskbus: { notices: [] } } }, { expanded: true, isPartial: false }, theme, ctx);
});

test("custom tool fallback limits collapsed visual lines and expands on request", () => {
  const renderer = createRunRenderers();
  const ctx = context("custom_tool", {});
  const result = { content: [{ type: "text" as const, text: Array.from({ length: 40 }, (_, i) => `long output ${i}`).join("\n") }], details: {} };
  const call = renderer.renderCall!(ctx.args, theme, ctx);
  renderer.renderResult!(result, { expanded: false, isPartial: false }, theme, ctx);
  assert.ok(call.render(80).length <= 13);
  assert.match(plain(call), /more lines/);
  renderer.renderResult!(result, { expanded: true, isPartial: false }, theme, ctx);
  assert.match(plain(call), /long output 39/);
});

test("partial shell output keeps pending background", () => {
  const renderer = createRunRenderers();
  const colors: string[] = [];
  const themed = { ...theme, bg: (color: string, text: string) => { colors.push(color); return text; } } as Theme;
  const ctx = context("write", { path: "fixture.txt", content: "hello" });
  const output = renderer.renderCall!(ctx.args, themed, { ...ctx, isPartial: true, durationMs: undefined });
  output.render(80);
  assert.ok(colors.includes("toolPendingBg"));
  assert.equal(colors.includes("toolSuccessBg"), false);
});

test("unknown tool fallback remains readable for errors and notices", () => {
  const renderer = createRunRenderers();
  const ctx = context("custom_tool", {});
  const call = renderer.renderCall!(ctx.args, theme, ctx);
  const output = renderer.renderResult!({ content: [{ type: "text", text: "permission denied" }], details: { original: {}, taskbus: { notices: ["consider splitting"] } } }, { expanded: false, isPartial: false }, theme, { ...ctx, isError: true });
  assert.match(plain(call) + plain(output), /permission denied/);
  assert.match(plain(call) + plain(output), /consider splitting/);
  for (const line of output.render(40)) assert.ok(visibleWidth(line) <= 40);
});
