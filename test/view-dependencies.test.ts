import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { TaskStore } from "../src/model.ts";
import { newViewState, rowLine, treeRows, TaskPanelComponent, TaskTreeComponent } from "../src/view.ts";
const theme = { fg: (_: string, t: string) => t, bg: (_: string, t: string) => t, style: (t: string) => t, bold: (t: string) => t } as unknown as Theme;
function setup() {
  const store = new TaskStore(DEFAULT_CONFIG, () => {});
  store.commit({ type: "task_created", pageId: "P-1", title: "Source", checkpoints: ["Input", "Optional"] });
  store.commit({ type: "page_created", title: "Delivery" });
  store.commit({ type: "task_created", pageId: "P-2", title: "Consumer", dependencies: [{ id: "CP-1", kind: "strict" }], checkpoints: ["Work"] });
  const view = { ...newViewState(), pageId: "P-2", selectedId: "CP-3", manualNavigation: true };
  let height = 24;
  const full = new TaskTreeComponent({ state: () => store.state, history: () => store.history }, view, theme, () => {}, () => height, () => {});
  const panel = new TaskPanelComponent({ state: () => store.state, activeTasks: () => [], failure: () => undefined }, view, theme, () => 30);
  const row = (id: string, width = 120) => rowLine(store.state, treeRows(store.state, view).find((r) => r.id === id)!, view, theme, width);
  return { store, view, full, panel, row, resize: (h: number) => { height = h; } };
}

test("both trees show own and inherited prerequisites and actual blocked status", () => {
  const { store, full, panel, row } = setup();
  assert.match(row("T-2"), /blocked ←S:CP-1/);
  assert.match(row("CP-3"), /blocked ←\^S:CP-1/);
  for (const component of [full, panel]) assert.match(component.render(120).join("\n"), /blocked ←/);
  store.commit({ type: "checkpoint_completed", id: "CP-1", summary: "Verified" });
  assert.doesNotMatch(row("CP-3"), /blocked/);
  assert.match(row("CP-3"), /←\^S:CP-1/);
});

test("cross-page inherited details show kind, owner, target state and concrete reason", () => {
  const { full } = setup(); full.handleInput("\r");
  const text = full.render(140).join("\n");
  assert.match(text, /Requires inherited from T-2 strict CP-1 @ P-1: pending/);
  assert.match(text, /Blocked: T-2 requires strict CP-1: CP-1 is pending/);
});

test("ready soft prerequisites keep distinct markers and own detail labels", () => {
  const { store, view, full, row } = setup();
  store.commit({ type: "checkpoint_completed", id: "CP-1", summary: "Verified" });
  store.commit({ type: "ignore_changed", id: "CP-2", ignored: true, reason: "Optional" });
  store.commit({ type: "task_created", pageId: "P-2", title: "Soft", dependencies: [{ id: "T-1", kind: "soft" }], checkpoints: ["Document"] });
  view.selectedId = "T-3";
  assert.match(row("T-3"), /←s:T-1/);
  assert.doesNotMatch(row("T-3"), /blocked/);
  full.handleInput("\r");
  assert.match(full.render(140).join("\n"), /Requires own soft T-1 @ P-1: uncertainly done/);
});

test("details wrap and scroll so many prerequisites and blockers remain reachable", () => {
  const { store, full, view, resize } = setup();
  for (let i = 0; i < 9; i++) store.commit({ type: "checkpoint_added", taskId: "T-1", title: `长标题 🧪 source ${i}` });
  store.commit({ type: "dependencies_changed", id: "CP-3", dependencies: ["CP-2", "CP-4", "CP-5", "CP-6", "CP-7", "CP-8", "CP-9", "CP-10", "CP-11", "CP-12"].map((id) => ({ id, kind: "strict" })), reason: "Review" });
  full.handleInput("\r");
  resize(12);
  const collected: string[] = [];
  for (let i = 0; i < 100; i++) {
    collected.push(full.render(70).join("\n")); full.handleInput("\x1b[6~");
  }
  assert.match(collected.join("\n"), /strict CP-12 @ P-1/);
  assert.match(collected.join("\n"), /CP-12 is pending/);
  assert.match(collected[0], /PgUp\/PgDn scroll/);
  for (let i = 0; i < 100; i++) full.handleInput("\x1b[5~");
  assert.match(full.render(70).join("\n"), /Details CP-3/);
  view.selectedId = "T-2";
  assert.match(full.render(70).join("\n"), /Details T-2/);
  for (const height of [3, 5, 8, 12, 24]) for (const width of [1, 8, 20, 40, 100]) {
    resize(height);
    const lines = full.render(width);
    assert.ok(lines.length <= height);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
});

test("compact rows preserve blocked and dependency count before long titles", () => {
  const { store, row } = setup();
  store.commit({ type: "renamed", id: "CP-3", title: "Long title ".repeat(30) });
  const compact = row("CP-3", 35);
  assert.match(compact, /CP-3 blocked ←1/);
  for (const width of [0, 1, 8, 20, 35, 80, 140]) assert.equal(visibleWidth(row("CP-3", width)), width);
});

test("short searchable overlay can scroll to last blocker without losing selected row", () => {
  const { store, view, full, resize } = setup();
  for (let i = 0; i < 5; i++) store.commit({ type: "checkpoint_added", taskId: "T-1", title: `source ${i}` });
  store.commit({ type: "dependencies_changed", id: "CP-3", dependencies: ["CP-2", "CP-4", "CP-5", "CP-6", "CP-7", "CP-8"].map((id) => ({ id, kind: "strict" })), reason: "Review" });
  full.handleInput("/"); full.handleInput("Work"); full.handleInput("\r");
  full.handleInput("\r"); resize(8);
  const collected: string[] = [];
  for (let i = 0; i < 100; i++) {
    const lines = full.render(55);
    assert.equal(lines.length, 8);
    assert.ok(lines.some((line) => line.includes(">CP-3") || line.includes("CP-3 blocked")));
    assert.ok(lines.some((line) => line.includes("Search: Work")));
    collected.push(lines.join("\n")); full.handleInput("\x1b[6~");
  }
  assert.match(collected.join("\n"), /CP-8 is pending/);
  assert.equal(view.selectedId, "CP-3");
});

test("dirty and archived prerequisites remain explicit and ignored rows are not labeled blocked", () => {
  const { store, full, row } = setup();
  store.commit({ type: "checkpoint_split", id: "CP-1", parts: [{ title: "a" }, { title: "b" }] });
  assert.match(row("CP-3"), /blocked/);
  assert.match(row("CP-3"), /!dirty/);
  full.handleInput("\r");
  assert.match(full.render(180).join("\n"), /CP-1 @ P-1: archived/);
  assert.match(full.render(180).join("\n"), /replace its dependency edge/);
  store.commit({ type: "ignore_changed", id: "CP-3", ignored: true, reason: "Deferred" });
  assert.doesNotMatch(row("CP-3"), /blocked/);
  assert.match(row("CP-3"), /ignored/);
});
