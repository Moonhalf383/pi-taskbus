import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, compositeTuiLine, stripTerminalSequences } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { TaskStore } from "../src/model.ts";
import { TaskPanelComponent, TaskTreeComponent, newViewState, overlayHeight, rowLine, safeText, treeRows } from "../src/view.ts";

const palette: Record<string, number> = { error: 31, warning: 33, success: 32, accent: 36, muted: 90, dim: 90, text: 37 };
const theme = { appearance: "dark", style: (text: string, options: { fg?: { r?: number; g?: number; b?: number } }) => `\x1b[38;2;${options.fg?.r};${options.fg?.g};${options.fg?.b}m${text}\x1b[39m`, fg: (color: string, text: string) => `\x1b[${palette[color] ?? 37}m${text}\x1b[39m`, bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[49m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` } as unknown as Theme;
function setup() {
  const store = new TaskStore(DEFAULT_CONFIG, () => {});
  store.commit({ type: "task_created", pageId: "P-1", title: "项目中文树 🌲", checkpoints: ["接口验收", "测试覆盖"] });
  store.commit({ type: "task_split", taskId: "T-1", groups: [{ title: "接口", checkpointIds: ["CP-1"] }, { title: "测试", checkpointIds: ["CP-2"] }] });
  const view = newViewState();
  let closed = false, renders = 0, height = 15;
  const component = new TaskTreeComponent({ state: () => store.state, history: () => store.history }, view, theme,
    () => { renders++; }, () => height, () => { closed = true; });
  return { store, view, component, closed: () => closed, renders: () => renders, resize: (value: number) => { height = value; } };
}

test("built-in panel and full-tree labels are English while custom text is preserved", () => {
  const store = new TaskStore(DEFAULT_CONFIG, () => {});
  store.commit({ type: "task_created", pageId: "P-1", title: "English task", checkpoints: ["English checkpoint"] });
  const view = newViewState();
  const panel = new TaskPanelComponent({ state: () => store.state, activeTasks: () => [], failure: () => undefined }, view, theme, () => 30);
  const full = new TaskTreeComponent({ state: () => store.state, history: () => store.history }, view, theme, () => {}, () => 20, () => {});
  for (const component of [panel, full]) {
    const text = component.render(140).map(stripTerminalSequences).join("\n");
    assert.doesNotMatch(text, /\p{Script=Han}/u);
    assert.match(text, /Confidence/);
    assert.match(text, /pending/);
  }
  full.handleInput("j");
  full.handleInput("\r");
  assert.match(full.render(140).join("\n"), /Details CP-1/);
  assert.match(full.render(140).join("\n"), /Status pending · Effort 0 · Confidence/);
  store.commit({ type: "renamed", id: "CP-1", title: "用户验收内容" });
  store.commit({ type: "checkpoint_completed", id: "CP-1", summary: "用户结果说明" });
  const text = full.render(140).map(stripTerminalSequences).join("\n");
  assert.match(text, /用户验收内容/);
  assert.match(text, /Result: 用户结果说明/);
  assert.match(text, /Status done/);
  assert.ok(DEFAULT_CONFIG.thresholds.every((threshold) => !/\p{Script=Han}/u.test(threshold.prompt)));
});

test("tree supports independent branch and leaf collapse", () => {
  const { store, view } = setup();
  assert.deepEqual(treeRows(store.state, view).map((row) => row.id), ["T-1", "T-2", "CP-1", "T-3", "CP-2"]);
  view.collapsed.add("T-2");
  assert.deepEqual(treeRows(store.state, view).map((row) => row.id), ["T-1", "T-2", "T-3", "CP-2"]);
  view.collapsed.add("T-1");
  assert.deepEqual(treeRows(store.state, view).map((row) => row.id), ["T-1"]);
  view.collapsed.delete("T-1");
  assert.ok(view.collapsed.has("T-2"));
});

test("search exposes matching checkpoints and their ancestor path", () => {
  const { store, view } = setup();
  view.collapsed.add("T-1");
  view.query = "覆盖";
  assert.deepEqual(treeRows(store.state, view).map((row) => row.id), ["T-1", "T-3", "CP-2"]);
  assert.ok(view.collapsed.has("T-1"));
});

test("jk move, hl navigate and collapse, Esc exits", () => {
  const { component, view, closed } = setup();
  component.render(80);
  assert.equal(view.selectedId, "T-1");
  component.handleInput("j");
  assert.equal(view.selectedId, "T-2");
  component.handleInput("l");
  assert.equal(view.selectedId, "CP-1");
  component.handleInput("h");
  assert.equal(view.selectedId, "T-2");
  component.handleInput("h");
  assert.ok(view.collapsed.has("T-2"));
  component.handleInput("l");
  assert.equal(view.collapsed.has("T-2"), false);
  component.handleInput("k");
  assert.equal(view.selectedId, "T-1");
  component.handleInput("\x1b");
  assert.equal(closed(), true);
});

test("Kitty encoded shortcuts navigate, fold and search", () => {
  const { component, view } = setup();
  component.render(80);
  component.handleInput("\x1b[106u");
  assert.equal(view.selectedId, "T-2");
  component.handleInput("\x1b[104u");
  assert.ok(view.collapsed.has("T-2"));
  component.handleInput("\x1b[108u");
  assert.equal(view.collapsed.has("T-2"), false);
  component.handleInput("\x1b[47u");
  component.handleInput("测试");
  assert.equal(view.query, "测试");
});

test("search mode accepts Chinese input and keeps movement keys as query text", () => {
  const { component, view, closed } = setup();
  component.handleInput("/");
  component.handleInput("覆");
  component.handleInput("盖");
  assert.equal(view.query, "覆盖");
  component.handleInput("\r");
  component.render(80);
  assert.equal(view.selectedId, "T-1");
  component.handleInput("c");
  assert.equal(view.query, "");
  assert.equal(closed(), false);
});

test("rendering respects widths, resize, details and scrolling bounds", () => {
  const { store, component, resize } = setup();
  for (let i = 0; i < 100; i++) store.commit({ type: "checkpoint_added", taskId: "T-3", title: `很长的中文标题 ${i} 🧪` });
  component.handleInput("G");
  component.handleInput("\r");
  for (const height of [3, 8, 24, 50]) {
    resize(height);
    for (const width of [1, 8, 20, 40, 80, 160]) {
      const lines = component.render(width);
      assert.ok(lines.length <= height);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} exceeds ${width}`);
    }
  }
});

test("tree separates status, confidence, selection and informational colors", () => {
  const { store, view } = setup();
  const checkpoint = treeRows(store.state, view).find((row) => row.id === "CP-1")!;
  const pending = rowLine(store.state, checkpoint, view, theme, 100);
  assert.match(pending, /\x1b\[33mpending/);
  assert.match(pending, /\x1b\[32mC:100%/);
  assert.match(pending, /\x1b\[90mCP-1/);
  store.commit({ type: "checkpoint_completed", id: "CP-1", summary: "通过" });
  const done = rowLine(store.state, checkpoint, view, theme, 100);
  assert.match(done, /\x1b\[32mdone/);
  view.selectedId = "CP-1";
  const selected = rowLine(store.state, checkpoint, view, theme, 100);
  assert.match(selected, /\x1b\[44m/);
  assert.match(selected, /\x1b\[37m接口验收/);
  assert.match(selected, /\x1b\[32mdone/);
  assert.equal(stripTerminalSequences(selected), stripTerminalSequences(done).replace(/^ /, ">"));
  const panel = new TaskPanelComponent({ state: () => store.state, activeTasks: () => [], failure: () => undefined }, view, theme, () => 30);
  assert.match(panel.render(140).join("\n"), /\x1b\[90m.*Alt\+j\/k/);
  for (const width of [1, 8, 20, 40, 100]) assert.equal(visibleWidth(rowLine(store.state, checkpoint, view, theme, width)), width);
});

test("summary and focus have distinct colors in dark and light appearances", () => {
  const { store, view } = setup();
  view.selectedId = "CP-1";
  const checkpoint = treeRows(store.state, view).find((row) => row.id === "CP-1")!;
  for (const appearance of ["dark", "light"] as const) {
    const themed = { ...theme, appearance } as unknown as Theme;
    const cyan = appearance === "dark" ? "103;232;249" : "0;105;120";
    const magenta = appearance === "dark" ? "240;171;252" : "150;40;160";
    const panel = new TaskPanelComponent({ state: () => store.state, activeTasks: () => [], failure: () => undefined }, view, themed, () => 30);
    const full = new TaskTreeComponent({ state: () => store.state, history: () => [] }, view, themed, () => {}, () => 20, () => {});
    for (const component of [panel, full]) {
      const summary = component.render(140).find((line) => stripTerminalSequences(line).includes("Confidence"))!;
      assert.ok(summary.includes(`\x1b[38;2;${cyan}m0% 0/2 · Confidence 100% · Low 0`));
    }
    const selected = rowLine(store.state, checkpoint, view, themed, 100);
    assert.ok(selected.includes(`\x1b[38;2;${magenta}m>`));
    assert.ok(selected.includes(`\x1b[38;2;${magenta}mCP-1`));
    assert.match(selected, /\x1b\[44m/);
    assert.match(selected, /\x1b\[33mpending/);
    assert.match(selected, /\x1b\[32mC:100%/);
  }
});

test("task and checkpoint rows follow confidence colors", () => {
  const { store, view } = setup();
  for (let i = 0; i < 24; i++) store.commit({ type: "work_recorded", taskId: "T-2", checkpointId: "CP-1", callId: String(i), tool: "read", units: 1, durationMs: 0, isError: false });
  const rows = treeRows(store.state, view);
  assert.match(rowLine(store.state, rows.find((row) => row.id === "CP-1")!, view, theme, 80), /\x1b\[31m/);
  assert.match(rowLine(store.state, rows.find((row) => row.id === "T-2")!, view, theme, 80), /\x1b\[31m/);
  assert.match(rowLine(store.state, rows.find((row) => row.id === "CP-2")!, view, theme, 80), /\x1b\[32m/);
});

test("bordered overlays fill every cell and cover underlying transcript", () => {
  const { component, resize } = setup();
  for (const height of [5, 8, 15, 30]) {
    resize(height);
    for (const width of [8, 20, 80]) {
      const lines = component.render(width);
      assert.equal(lines.length, height);
      assert.match(stripTerminalSequences(lines[0]), /^╭.*╮$/);
      assert.match(stripTerminalSequences(lines.at(-1)!), /^╰.*╯$/);
      for (const line of lines) {
        assert.equal(visibleWidth(line), width);
        const composed = compositeTuiLine("X".repeat(width + 4), line, 2, width, width + 4);
        assert.equal(stripTerminalSequences(composed).slice(2, -2).includes("X"), false);
      }
    }
  }
});

test("overlay height fits host margins even in a short terminal", () => {
  for (const rows of [4, 5, 8, 10, 12, 24, 50]) assert.ok(overlayHeight(rows) <= rows - 2);
});

test("resident panel shows live task/checkpoint rows, active work and bounded overflow", () => {
  const { store, view } = setup();
  let active: string[] = [];
  let failure: string | undefined;
  const panel = new TaskPanelComponent({ state: () => store.state, activeTasks: () => active, failure: () => failure }, view, theme, () => 30);
  const initial = panel.render(90).map(stripTerminalSequences).join("\n");
  assert.match(initial, /Task tree/);
  assert.match(initial, /项目中文树/);
  assert.match(initial, /接口验收/);
  active = ["T-3"];
  assert.match(panel.render(90).map(stripTerminalSequences).join("\n"), /●/);
  store.commit({ type: "checkpoint_completed", id: "CP-1", summary: "通过" });
  assert.match(panel.render(90).map(stripTerminalSequences).join("\n"), /50%/);
  for (let i = 0; i < 20; i++) store.commit({ type: "checkpoint_added", taskId: "T-3", title: `额外 ${i}` });
  assert.match(panel.render(90).map(stripTerminalSequences).join("\n"), /more nodes/);
  failure = "写入失败\n请重试";
  assert.match(panel.render(90).map(stripTerminalSequences).join("\n"), /Tracking error/);
  for (const rows of [4, 8, 12, 24, 60]) {
    const resized = new TaskPanelComponent({ state: () => store.state, activeTasks: () => active, failure: () => undefined }, view, theme, () => rows);
    for (const width of [1, 8, 20, 80]) {
      const lines = resized.render(width);
      assert.ok(lines.length <= 10);
      for (const line of lines) assert.equal(visibleWidth(line), width);
    }
  }
});

test("titles display as a single line with terminal escapes removed", () => {
  assert.equal(safeText("标题\x1b[31m变色\x1b[0m\n第二行"), "标题变色 第二行");
  assert.equal(safeText("a\x1b]0;title\x07b"), "ab");
});
