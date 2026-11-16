import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, TuiMainScreen, TuiAltScreen, stripTerminalSequences, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { TaskStore } from "../src/model.ts";
import { TaskPanelComponent, TaskTreeComponent, newViewState, overlayHeight } from "../src/view.ts";

class MemoryTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  output = "";
  resizeCallback = () => {};
  start(_input: (value: string) => void, resize: () => void) { this.resizeCallback = resize; }
  stop() {}
  async drainInput() {}
  write(value: string) { this.output += value; }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
}
const theme = { style: (text: string) => text, fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

for (const mode of ["regular", "fullscreen"]) {
  test(`${mode} host keeps recent tool card above inline panel and renders bordered overlay on resize`, async () => {
    const terminal = new MemoryTerminal();
    const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
    const store = new TaskStore(DEFAULT_CONFIG, () => {});
    store.commit({ type: "task_created", pageId: "P-1", title: "真实 TUI 验证", checkpoints: ["宽度及折叠", "最近调用可见"] });
    const view = newViewState();
    const panel = new TaskPanelComponent({ state: () => store.state, activeTasks: () => ["T-1"], failure: () => undefined }, view, theme, () => terminal.rows);
    tui.addChild(new Text("LATEST_TOOL_CARD: edit src/view.ts\n- old\n+ new", 0, 0));
    tui.addChild(panel);
    tui.addChild(new Text("EDITOR_PROMPT", 0, 0));
    tui.start();
    try {
      await delay(40);
      const output = stripTerminalSequences(terminal.output);
      assert.ok(output.indexOf("LATEST_TOOL_CARD") < output.indexOf("Taskbus"));
      assert.ok(output.indexOf("Taskbus") < output.indexOf("EDITOR_PROMPT"));
      if (tui instanceof TuiAltScreen) {
        const screen = tui.getScreenLines().map(stripTerminalSequences).join("\n");
        assert.match(screen, /LATEST_TOOL_CARD/);
        assert.match(screen, /EDITOR_PROMPT/);
      }
      const tree = new TaskTreeComponent({ state: () => store.state, history: () => store.history }, view, theme, () => tui.requestRender(), () => overlayHeight(terminal.rows), () => {});
      const overlay = tui.showOverlay(tree, { width: "95%", anchor: "center", margin: 1 });
      for (const [columns, rows] of [[80, 24], [32, 10], [100, 40]]) {
        terminal.columns = columns; terminal.rows = rows;
        terminal.resizeCallback();
        tree.handleInput("j");
        await delay(40);
        const lines = tree.render(Math.floor(columns * 0.95));
        assert.ok(lines.length <= rows - 2);
        for (const line of lines) assert.ok(visibleWidth(line) <= Math.floor(columns * 0.95));
        assert.match(stripTerminalSequences(lines.at(-1)!), /╰.*╯/);
      }
      overlay.hide();
      await delay(40);
      assert.equal(tui.hasOverlay(), false);
    } finally { tui.stop(); }
  });
}
