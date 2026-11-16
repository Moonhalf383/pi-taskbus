import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { TaskStore } from "../src/model.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { TaskPanelComponent, TaskTreeComponent, newViewState, switchPage, treeRows } from "../src/view.ts";
const theme = { fg: (_role: string, text: string) => text, bg: (_role: string, text: string) => text, style: (text: string) => text, bold: (text: string) => text } as unknown as Theme;
function setup() {
  const store = new TaskStore(DEFAULT_CONFIG, () => {});
  store.commit({ type: "task_created", pageId: "P-1", title: "First", checkpoints: ["First checkpoint"] });
  store.commit({ type: "page_created", title: "Second page" });
  store.commit({ type: "task_created", pageId: "P-2", title: "Second", checkpoints: ["Second checkpoint"] });
  const view = newViewState();
  const full = new TaskTreeComponent({ state: () => store.state, history: () => store.history }, view, theme, () => {}, () => 24, () => {});
  const panel = new TaskPanelComponent({ state: () => store.state, activeTasks: () => ["T-2"], failure: () => undefined }, view, theme, () => 30);
  return { store, view, full, panel };
}

test("pages isolate rows and preserve independent selection, folds and searches", () => {
  const { store, view } = setup();
  assert.deepEqual(treeRows(store.state, view).map((row) => row.id), ["T-1", "CP-1"]);
  view.selectedId = "CP-1"; view.collapsed.add("T-1"); view.query = "First";
  switchPage(store.state, view, 1);
  assert.equal(view.pageId, "P-2"); assert.equal(view.query, ""); assert.equal(view.collapsed.size, 0);
  view.selectedId = "CP-2"; view.query = "Second";
  switchPage(store.state, view, 1);
  assert.equal(view.pageId, "P-1"); assert.equal(view.selectedId, "CP-1"); assert.equal(view.query, "First"); assert.ok(view.collapsed.has("T-1"));
  switchPage(store.state, view, -1);
  assert.equal(view.pageId, "P-2"); assert.equal(view.selectedId, "CP-2"); assert.equal(view.query, "Second");
});

test("full tree Shift+h/l and Kitty encoding switch pages without following running work", () => {
  const { full, panel, view } = setup();
  assert.match(panel.render(120).join("\n"), /P-1 Default/);
  assert.doesNotMatch(panel.render(120).join("\n"), /Second checkpoint/);
  full.handleInput("L"); assert.equal(view.pageId, "P-2");
  assert.match(full.render(120).join("\n"), /Second checkpoint/);
  full.handleInput("\x1b[104;2u"); assert.equal(view.pageId, "P-1");
  full.handleInput("\x1b[108;2u"); assert.equal(view.pageId, "P-2");
});

test("dirty and ignored retain visible identities, counts and page layout across narrow widths", () => {
  const { store, view, panel, full } = setup();
  store.commit({ type: "ignore_changed", id: "CP-1", ignored: true, reason: "Deferred" });
  assert.match(panel.render(120).join("\n"), /ignored/);
  assert.match(panel.render(120).join("\n"), /Ignored 1/);
  store.commit({ type: "ignore_changed", id: "CP-1", ignored: false, reason: "Restore" });
  view.selectedId = "CP-1";
  assert.match(full.render(120).join("\n"), /!dirty/);
  for (const component of [full, panel]) for (const width of [1, 8, 20, 80, 140]) {
    for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
  }
  assert.doesNotMatch(full.render(140).map(stripTerminalSequences).join("\n"), /\p{Script=Han}/u);
});

test("page switching during search preserves each query and folding stays page-local", () => {
  const { store, view, full } = setup();
  full.render(120); full.handleInput("/"); full.handleInput("First");
  full.handleInput("L");
  assert.equal(view.pageId, "P-2"); assert.equal(view.query, "");
  full.handleInput("z");
  assert.ok(view.collapsed.has("T-2")); assert.equal(view.collapsed.has("T-1"), false);
  assert.equal(view.selectedId, "T-2");
  full.handleInput("H");
  assert.equal(view.pageId, "P-1"); assert.equal(view.query, "First");
  assert.equal(treeRows(store.state, view).length, 2);
});
