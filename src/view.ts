import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable } from "@earendil-works/pi-tui";
import { confidenceColor } from "./config.ts";
import { ancestors, getNode, executionBlockers, confidence, metrics, nodeState, type State, type Envelope } from "./model.ts";

export interface TreeRow { id: string; parentId?: string; depth: number; kind: "task" | "checkpoint"; expandable: boolean }
export interface ViewState { collapsed: Set<string>; selectedId?: string; query: string; manualNavigation?: boolean; pageId?: string; pageViews?: Record<string, { collapsed: Set<string>; selectedId?: string; query: string; manualNavigation?: boolean }> }
export function newViewState(): ViewState { return { collapsed: new Set(), query: "" }; }

export function selectedPage(state: State, view: ViewState): string {
  if (!state.pages.some((page) => page.id === view.pageId)) view.pageId = state.pages[0].id;
  return view.pageId!;
}
export function switchPage(state: State, view: ViewState, delta: number): void {
  const current = selectedPage(state, view);
  view.pageViews ??= {};
  view.pageViews[current] = { collapsed: new Set(view.collapsed), selectedId: view.selectedId, query: view.query, manualNavigation: view.manualNavigation };
  const index = state.pages.findIndex((page) => page.id === current);
  view.pageId = state.pages[(index + delta + state.pages.length) % state.pages.length].id;
  const saved = view.pageViews[view.pageId];
  view.collapsed = new Set(saved?.collapsed ?? []);
  view.selectedId = saved?.selectedId;
  view.query = saved?.query ?? "";
  view.manualNavigation = saved?.manualNavigation ?? false;
}
function pageTitle(state: State, view: ViewState): string {
  const id = selectedPage(state, view), index = state.pages.findIndex((page) => page.id === id);
  return `${index + 1}/${state.pages.length} ${id} ${safeText(state.pages[index].title)}`;
}
function pageMetrics(state: State, view: ViewState) {
  const pageId = selectedPage(state, view);
  return metrics({ ...state, roots: state.roots.filter((id) => state.pageByTask[id] === pageId) });
}

export function treeRows(state: State, view: ViewState): TreeRow[] {
  const rows: TreeRow[] = [];
  const query = view.query.trim().toLocaleLowerCase();
  const included = new Set<string>();
  if (query) {
    for (const task of Object.values(state.tasks)) {
      if (`${task.id} ${task.title}`.toLocaleLowerCase().includes(query)) included.add(task.id);
    }
    for (const checkpoint of Object.values(state.checkpoints)) {
      if (checkpoint.status !== "archived" && `${checkpoint.id} ${checkpoint.title}`.toLocaleLowerCase().includes(query)) {
        included.add(checkpoint.id);
        included.add(checkpoint.taskId);
      }
    }
    for (const id of [...included]) {
      let parentId = state.tasks[id]?.parentId;
      while (parentId) { included.add(parentId); parentId = state.tasks[parentId]?.parentId; }
    }
  }
  const pageId = selectedPage(state, view);
  const stack = state.roots.filter((id) => state.pageByTask[id] === pageId).reverse().map((id) => ({ id, depth: 0 }));
  while (stack.length) {
    const { id, depth } = stack.pop()!;
    const task = state.tasks[id];
    if (query && !included.has(id)) continue;
    const children = task.kind === "branch" ? task.childIds : task.checkpointIds;
    rows.push({ id, parentId: task.parentId, depth, kind: "task", expandable: children.length > 0 });
    if (!query && view.collapsed.has(id)) continue;
    if (task.kind === "branch") stack.push(...[...task.childIds].reverse().map((child) => ({ id: child, depth: depth + 1 })));
    else for (const child of children) {
      if (!query || included.has(child) || `${task.id} ${task.title}`.toLocaleLowerCase().includes(query)) {
        rows.push({ id: child, parentId: id, depth: depth + 1, kind: "checkpoint", expandable: false });
      }
    }
  }
  return rows;
}
export function navigateTree(state: State, view: ViewState, action: "up" | "down" | "left" | "right"): void {
  const rows = treeRows(state, { ...view, query: "" });
  if (!rows.length) return;
  const index = Math.max(0, rows.findIndex((row) => row.id === view.selectedId));
  const current = rows[index];
  view.manualNavigation = true;
  if (action === "up") view.selectedId = rows[Math.max(0, index - 1)].id;
  else if (action === "down") view.selectedId = rows[Math.min(rows.length - 1, index + 1)].id;
  else if (action === "left") {
    if (current.expandable && !view.collapsed.has(current.id)) view.collapsed.add(current.id);
    else view.selectedId = current.parentId ?? current.id;
  } else if (current.expandable && view.collapsed.has(current.id)) view.collapsed.delete(current.id);
  else if (current.expandable) view.selectedId = rows[index + 1]?.id ?? current.id;
}

export function percent(value: number): string { return `${Math.round(value * 100)}%`; }
/** Prevent task titles and user-configured text from introducing terminal control sequences. */
export function safeText(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

/** Pad every line so an overlay overwrites all of the underlying terminal cells. */
export function fitLine(text: string, width: number, fill = " "): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "…");
  return clipped + fill.repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function framedLines(content: string[], title: string, theme: Theme, width: number, height: number): string[] {
  width = Math.max(0, Math.floor(width));
  height = Math.max(0, Math.floor(height));
  if (!width || !height) return [];
  if (width < 4 || height < 3) return content.slice(0, height).map((line) => fitLine(line, width));
  const edgeWidth = width - 2;
  const top = theme.fg("borderMuted", `╭${fitLine(`─ ${title} `, edgeWidth, "─")}╮`);
  const bottom = theme.fg("borderMuted", `╰${"─".repeat(edgeWidth)}╯`);
  const body = content.slice(0, height - 2).map((line) =>
    theme.fg("borderMuted", "│") + " " + fitLine(line, width - 4) + " " + theme.fg("borderMuted", "│"));
  while (body.length < height - 2) body.push(theme.fg("borderMuted", "│") + " ".repeat(edgeWidth) + theme.fg("borderMuted", "│"));
  return [top, ...body, bottom];
}

export function overlayHeight(terminalRows: number): number {
  return Math.max(1, Math.min(Math.floor(terminalRows * 0.95), terminalRows - 2));
}

/** Reserve cyan for information and magenta for focus, independent of border/accent tokens. */
function roleColor(theme: Theme, role: "summary" | "focus", text: string): string {
  const light = theme.appearance === "light";
  const [r, g, b] = role === "summary"
    ? light ? [0, 105, 120] : [103, 232, 249]
    : light ? [150, 40, 160] : [240, 171, 252];
  return theme.style(text, { fg: { kind: "rgb", r, g, b } });
}

function summaryLine(stat: ReturnType<typeof metrics>, theme: Theme): string {
  return roleColor(theme, "summary", `${percent(stat.progress)} ${stat.completed}/${stat.total}${stat.ignored ? ` · Ignored ${stat.ignored}` : ""} · Confidence ${percent(stat.confidence)} · Low ${stat.lowCount}${stat.unplanned ? ` · Unplanned ${stat.unplanned}` : ""}`);
}

interface ViewDependency { ownerId: string; id: string; kind: "strict" | "soft" }
function viewDependencies(state: State, id: string): ViewDependency[] {
  return [id, ...ancestors(state, id)].flatMap((ownerId) =>
    (getNode(state, ownerId).dependencies ?? []).map((edge) => ({ ownerId, ...edge })));
}
function dependencyPresentation(state: State, id: string) {
  const semantic = nodeState(state, id);
  const edges = viewDependencies(state, id);
  const blockers = !semantic.done && semantic.certainty !== "ignored" ? executionBlockers(state, id) : [];
  const references = edges.slice(0, 2).map((edge) => `${edge.ownerId === id ? "" : "^"}${edge.kind === "strict" ? "S" : "s"}:${edge.id}`);
  return { edges, blockers, label: edges.length ? `←${references.join(",")}${edges.length > 2 ? ` +${edges.length - 2}` : ""}` : "" };
}

export function rowLine(state: State, row: TreeRow, view: ViewState, theme: Theme, width: number): string {
  const checkpoint = row.kind === "checkpoint" ? state.checkpoints[row.id] : undefined;
  const task = row.kind === "task" ? state.tasks[row.id] : undefined;
  const stat = task ? metrics(state, task.id) : undefined;
  const score = checkpoint ? confidence(checkpoint, state.config) : stat!.confidence;
  const selected = row.id === view.selectedId;
  const semantic = nodeState(state, row.id);
  const done = semantic.done;
  const dependency = dependencyPresentation(state, row.id);
  const dependencyText = `${dependency.blockers.length ? theme.fg("warning", "blocked ") : ""}${dependency.label ? theme.fg("muted", dependency.label) + " " : ""}`;
  const statusColor = semantic.certainty === "ignored" ? "muted" : semantic.dirty ? "warning" : done ? "success" : "warning";
  const status = semantic.certainty === "ignored" ? "⊘" : semantic.dirty ? "!" : checkpoint ? (done ? "✓" : "○") : row.expandable ? (view.query || !view.collapsed.has(row.id) ? "▾" : "▸") : "·";
  const marker = selected ? roleColor(theme, "focus", ">") : theme.fg("dim", " ");
  const indent = "  ".repeat(Math.min(row.depth, Math.max(0, Math.floor(width / 6))));
  const titleColor = "text";
  const title = `${marker} ${indent}${theme.fg(statusColor, status)} ${(selected ? roleColor(theme, "focus", row.id) : theme.fg("muted", row.id))} ${dependencyText}${theme.fg(titleColor, safeText((checkpoint ?? task)!.title))}`;
  const scoreText = theme.fg(confidenceColor(score, state.config), `C:${percent(score)}`);
  const identity = `${semantic.certainty === "ignored" ? "ignored" : semantic.completion === "uncertainly done" ? "uncertainly done" : done ? "done" : "pending"}${semantic.dirty ? " !dirty" : ""}`;
  const statusText = checkpoint
    ? theme.fg(statusColor, identity)
    : theme.fg(statusColor, `${percent(stat!.progress)} ${stat!.completed}/${stat!.total}${stat!.ignored ? ` +${stat!.ignored} ignored` : ""}${semantic.certainty === "ignored" ? " ignored" : done ? ` ${semantic.completion}` : semantic.certainty === "uncertain" ? " uncertain" : ""}${semantic.dirty ? " !dirty" : ""}`)
      + (stat!.unplanned ? theme.fg("muted", " unplanned") : "");
  const suffix = ` ${statusText}  ${scoreText}`;
  const suffixWidth = visibleWidth(suffix);
  const minimumTitleWidth = visibleWidth(`${marker} ${indent}${status} ${row.id} ${dependency.blockers.length ? "blocked " : ""}${dependency.label} `) + 4;
  const content = width >= suffixWidth + Math.max(12, minimumTitleWidth)
    ? fitLine(title, Math.max(1, width - suffixWidth)) + suffix
    : fitLine(`${marker}${(selected ? roleColor(theme, "focus", row.id) : theme.fg("muted", row.id))} ${dependency.blockers.length ? theme.fg("warning", "blocked ") : ""}${dependency.edges.length ? theme.fg("muted", `←${dependency.edges.length} `) : ""}${theme.fg(statusColor, `${semantic.certainty === "ignored" ? "⊘ " : semantic.dirty ? "! " : ""}${task ? `${percent(stat!.progress)} ` : status + " "}`)}${scoreText} ${theme.fg(titleColor, safeText((checkpoint ?? task)!.title))}`, width);
  return selected ? theme.bg("selectedBg", theme.bold(content)) : content;
}

export interface TreeSource { state(): State; history(): Envelope[] }

export class TaskPanelComponent implements Component {
  constructor(
    private readonly source: { state(): State | undefined; activeTasks(): string[]; failure(): string | undefined },
    private readonly view: ViewState,
    private readonly theme: Theme,
    private readonly terminalHeight: () => number,
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    // Leave room for the conversation and editor, including other installed widgets.
    const height = Math.max(3, Math.min(9, Math.floor(this.terminalHeight() / 3)));
    const innerWidth = Math.max(0, width - 4);
    const state = this.source.state();
    const failure = this.source.failure();
    if (!state || failure) return framedLines([
      this.theme.fg("error", safeText(failure ?? "Waiting for session initialization")),
      this.theme.fg("muted", "/taskbus inspect · /taskbus recover retry"),
    ], "Taskbus · Tracking error", this.theme, width, height);
    selectedPage(state, this.view);
    const stat = pageMetrics(state, this.view);
    // Search in the full window should not hide unrelated work in the resident panel.
    const panelView = { ...this.view, query: "" };
    const rows = treeRows(state, panelView);
    const active = this.source.activeTasks();
    const focusId = this.view.manualNavigation ? this.view.selectedId : active[0] ?? this.view.selectedId;
    const focus = Math.max(0, rows.findIndex((row) => row.id === focusId));
    const capacity = Math.max(1, height - 4);
    let start = Math.max(0, focus - Math.floor(capacity / 2));
    start = Math.min(start, Math.max(0, rows.length - capacity));
    const lines = [summaryLine(stat, this.theme)];
    if (height <= 4) {
      const row = rows[focus];
      return framedLines([row ? rowLine(state, row, panelView, this.theme, innerWidth) : lines[0], this.theme.fg("muted", "/taskbus open full tree")], `Taskbus · Task tree · ${pageTitle(state, this.view)}`, this.theme, width, height);
    }
    if (!rows.length) lines.push(this.theme.fg("muted", "No tasks yet. Use task_manage to create tasks and checkpoints."));
    else for (const row of rows.slice(start, start + capacity)) {
      const rendered = rowLine(state, row, panelView, this.theme, Math.max(0, innerWidth - 2));
      lines.push(`${active.includes(row.id) ? roleColor(this.theme, "summary", "● ") : "  "}${rendered}`);
    }
    const hidden = Math.max(0, rows.length - capacity);
    while (lines.length < height - 3) lines.push("");
    lines.push(this.theme.fg("dim", `${hidden ? `${hidden} more nodes · ` : ""}Alt+j/k move · Alt+h/l fold · Alt+Shift+h/l pages · /taskbus`));
    return framedLines(lines, `Taskbus · Task tree · ${pageTitle(state, this.view)}`, this.theme, width, height);
  }
}

export class TaskTreeComponent implements Component, Focusable {
  focused = false;
  private offset = 0;
  private searching = false;
  private details = false;
  private detailOffset = 0;
  private detailId?: string;
  private readonly input = new Input();
  constructor(
    private readonly source: TreeSource,
    private readonly view: ViewState,
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly height: () => number,
    private readonly done: () => void,
  ) {
    this.input.setValue(view.query);
  }
  invalidate(): void { this.input.invalidate(); }
  handleInput(data: string): void {
    if (matchesKey(data, "shift+h") || matchesKey(data, "shift+l")) {
      switchPage(this.source.state(), this.view, matchesKey(data, "shift+h") ? -1 : 1);
      this.searching = false; this.offset = 0; this.input.setValue(this.view.query); this.requestRender(); return;
    }
    if (this.searching) {
      if (matchesKey(data, "escape") || matchesKey(data, "return")) { this.searching = false; this.requestRender(); }
      else {
        this.input.handleInput(data);
        this.view.query = this.input.getValue();
        this.offset = 0;
        this.requestRender();
      }
      return;
    }
    if (this.details && (matchesKey(data, "pageUp") || matchesKey(data, "pageDown"))) {
      this.detailOffset = Math.max(0, this.detailOffset + (matchesKey(data, "pageUp") ? -1 : 1));
      this.requestRender(); return;
    }
    const pressed = (key: string) => matchesKey(data, key as Parameters<typeof matchesKey>[1]);
    if (matchesKey(data, "escape") || pressed("q")) { this.done(); return; }
    if (pressed("/")) { this.searching = true; this.requestRender(); return; }
    if (pressed("c")) { this.view.query = ""; this.input.setValue(""); }
    const state = this.source.state();
    const rows = treeRows(state, this.view);
    const index = Math.max(0, rows.findIndex((row) => row.id === this.view.selectedId));
    const current = rows[index];
    if (pressed("j") || matchesKey(data, "down")) this.view.selectedId = rows[Math.min(rows.length - 1, index + 1)]?.id;
    else if (pressed("k") || matchesKey(data, "up")) this.view.selectedId = rows[Math.max(0, index - 1)]?.id;
    else if (pressed("h") || matchesKey(data, "left")) {
      if (current?.expandable && !this.view.collapsed.has(current.id)) this.view.collapsed.add(current.id);
      else if (current?.parentId) this.view.selectedId = current.parentId;
    } else if (pressed("l") || matchesKey(data, "right")) {
      if (current?.expandable && this.view.collapsed.has(current.id)) this.view.collapsed.delete(current.id);
      else if (current?.expandable) this.view.selectedId = rows[index + 1]?.id;
    } else if (pressed("o")) this.view.collapsed.clear();
    else if (pressed("z")) { for (const row of rows) if (row.kind === "task") this.view.collapsed.add(row.id); this.view.selectedId = rows[0]?.id; }
    else if (matchesKey(data, "return")) { this.details = !this.details; this.detailOffset = 0; }
    else if (data === "g" || pressed("g")) this.view.selectedId = rows[0]?.id;
    else if (data === "G" || pressed("shift+g")) this.view.selectedId = rows.at(-1)?.id;
    this.requestRender();
  }
  render(width: number): string[] {
    const state = this.source.state();
    const rows = treeRows(state, this.view);
    if (!rows.some((row) => row.id === this.view.selectedId)) this.view.selectedId = rows[0]?.id;
    const currentIndex = Math.max(0, rows.findIndex((row) => row.id === this.view.selectedId));
    const total = pageMetrics(state, this.view);
    const detailLines: string[] = [];
    if (this.detailId !== this.view.selectedId) { this.detailOffset = 0; this.detailId = this.view.selectedId; }
    if (this.details && this.view.selectedId) {
      const id = this.view.selectedId;
      const checkpoint = state.checkpoints[id];
      const semantic = nodeState(state, id);
      detailLines.push(`Details ${id} ${safeText((checkpoint ?? state.tasks[id]).title)}`);
      const dependency = dependencyPresentation(state, id);
      for (const edge of dependency.edges) {
        const target = getNode(state, edge.id), status = nodeState(state, edge.id);
        const taskId = state.checkpoints[edge.id]?.taskId ?? edge.id;
        detailLines.push(`Requires ${edge.ownerId === id ? "own" : `inherited from ${edge.ownerId}`} ${edge.kind} ${edge.id} @ ${state.pageByTask[taskId]}: ${status.completion}${status.dirty ? ", dirty" : ""} · ${safeText(target.title)}`);
      }
      for (const blocker of dependency.blockers) detailLines.push(`Blocked: ${safeText(blocker)}`);
      if (checkpoint) {
        detailLines.push(`Status ${checkpoint.status} · Effort ${Number(checkpoint.effort.toFixed(3))} · Confidence ${percent(confidence(checkpoint, state.config))}${checkpoint.sourceId ? ` · Split from ${checkpoint.sourceId}` : ""}${semantic.dirty ? " · !dirty" : ""}${semantic.certainty === "ignored" ? " · ignored" : ""}`);
        if (checkpoint.summary) detailLines.push(`Result: ${safeText(checkpoint.summary)}`);
        if (checkpoint.reason) detailLines.push(`Reopened: ${safeText(checkpoint.reason)}`);
      } else {
        const stat = metrics(state, id);
        detailLines.push(`${semantic.completion} · ${semantic.certainty}${semantic.dirty ? " · !dirty" : ""} · Lowest confidence ${percent(stat.lowest)} · Low ${stat.lowCount} · Unplanned leaves ${stat.unplanned}`);
      }
      for (const entry of this.source.history().filter((entry) => JSON.stringify(entry.event).includes(`"${id}"`)).slice(-4)) {
        detailLines.push(`${entry.timestamp.slice(11, 19)} ${safeText(JSON.stringify(entry.event))}`);
      }
    }
    const height = Math.max(1, Math.floor(this.height()));
    const innerWidth = Math.max(0, width - 4);
    const bodyHeight = Math.max(0, height - 2);
    const showSearch = (this.searching || Boolean(this.view.query)) && bodyHeight >= 4;
    const wrappedDetails = detailLines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, innerWidth)));
    const detailBudget = Math.min(wrappedDetails.length, Math.max(0, bodyHeight - 3 - Number(showSearch)), Math.floor(bodyHeight / 2));
    const scrollingDetails = wrappedDetails.length > detailBudget && detailBudget >= 2;
    const detailCapacity = Math.max(0, detailBudget - Number(scrollingDetails));
    this.detailOffset = Math.min(this.detailOffset, Math.max(0, wrappedDetails.length - detailCapacity));
    const capacity = Math.max(1, bodyHeight - 2 - Number(showSearch) - detailBudget);
    if (currentIndex < this.offset) this.offset = currentIndex;
    if (currentIndex >= this.offset + capacity) this.offset = currentIndex - capacity + 1;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, rows.length - capacity)));
    const summary = summaryLine(total, this.theme);
    if (height < 5) return framedLines([rows[currentIndex] ? rowLine(state, rows[currentIndex], this.view, this.theme, innerWidth) : summary], "Taskbus", this.theme, width, height);
    const lines = [summary];
    this.input.focused = this.focused && this.searching;
    if (showSearch) {
      if (this.searching) lines.push(...this.input.render(Math.max(1, innerWidth)));
      else lines.push(this.theme.fg("muted", `Search: ${safeText(this.view.query)} (c clear)`));
    }
    if (!rows.length) lines.push(this.theme.fg("muted", "No matching nodes. Use task_manage to create tasks and checkpoints."));
    else for (const row of rows.slice(this.offset, this.offset + capacity)) lines.push(rowLine(state, row, this.view, this.theme, innerWidth));
    for (const line of wrappedDetails.slice(this.detailOffset, this.detailOffset + detailCapacity)) lines.push(this.theme.fg(line.startsWith("Blocked:") ? "warning" : "muted", line));
    if (scrollingDetails) lines.push(this.theme.fg("dim", `Details ${this.detailOffset + 1}-${this.detailOffset + detailCapacity}/${wrappedDetails.length} · PgUp/PgDn scroll`));
    while (lines.length < bodyHeight - 1) lines.push("");
    lines.push(this.theme.fg("dim", `${rows.length ? currentIndex + 1 : 0}/${rows.length}  jk move · hl fold · Shift+h/l pages · / search · Enter details · o expand all · z fold all · Esc close`));
    return framedLines(lines, `Taskbus · Task manager · ${pageTitle(state, this.view)}`, this.theme, width, height);
  }
}
