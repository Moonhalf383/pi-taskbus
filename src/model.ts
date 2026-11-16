import { renderPrompt, validateConfig, type TaskbusConfig } from "./config.ts";

export interface Dependency { id: string; kind: "strict" | "soft" }
export interface NodeFields { ignored?: boolean; dependencies?: Dependency[]; dirtyReasons?: string[]; review?: string }
export interface Page { id: string; title: string }
export interface CheckpointSpec { title: string; dependencies?: Dependency[] }

export interface LeafTask extends NodeFields {
  kind: "leaf";
  id: string;
  title: string;
  parentId?: string;
  checkpointIds: string[];
}
export interface BranchTask extends NodeFields {
  kind: "branch";
  id: string;
  title: string;
  parentId?: string;
  childIds: string[];
}
export type Task = LeafTask | BranchTask;
export interface Checkpoint extends NodeFields {
  id: string;
  taskId: string;
  title: string;
  status: "pending" | "done" | "archived";
  effort: number;
  summary?: string;
  reason?: string;
  sourceId?: string;
  replacementIds?: string[];
  reminders: Record<string, number>;
}
export interface State {
  version: 1;
  revision: number;
  config: TaskbusConfig;
  roots: string[];
  pages: Page[];
  pageByTask: Record<string, string>;
  nextPage: number;
  tasks: Record<string, Task>;
  checkpoints: Record<string, Checkpoint>;
  nextTask: number;
  nextCheckpoint: number;
}
export interface Part { title: string; share?: number; dependencies?: Dependency[] }
export interface TaskGroup { title: string; checkpointIds: string[]; dependencies?: Dependency[] }
export type Event =
  | { type: "initialized"; config: TaskbusConfig }
  | { type: "task_created"; title: string; parentId?: string; pageId?: string; dependencies?: Dependency[]; checkpoints: (string | CheckpointSpec)[] }
  | { type: "checkpoint_added"; taskId: string; title: string; dependencies?: Dependency[] }
  | { type: "page_created"; title: string }
  | { type: "ignore_changed"; id: string; ignored: boolean; reason: string }
  | { type: "node_refreshed"; id: string; summary: string; dependencies?: Dependency[]; outcome?: "keep" | "reopen" }
  | { type: "dependencies_changed"; id: string; dependencies: Dependency[]; reason: string }
  | { type: "renamed"; id: string; title: string }
  | { type: "checkpoint_completed"; id: string; summary: string }
  | { type: "checkpoint_reopened"; id: string; reason: string }
  | { type: "checkpoint_split"; id: string; parts: Part[] }
  | { type: "task_split"; taskId: string; groups: TaskGroup[] }
  | { type: "work_recorded"; taskId: string; checkpointId: string; callId: string; tool: string; units: 0 | 1; isError: boolean; durationMs: number };
export interface Envelope {
  version: 1;
  semantics?: 2;
  revision: number;
  timestamp: string;
  event: Event;
  snapshot?: State;
}
export interface Metrics {
  completed: number;
  ignored: number;
  total: number;
  progress: number;
  confidence: number;
  effort: number;
  lowest: number;
  lowCount: number;
  unplanned: number;
}
export interface Transition { state: State; notices: string[]; ids: string[] }

export function initialState(config: TaskbusConfig): State {
  return { version: 1, revision: 0, config: validateConfig(config), roots: [], pages: [{ id: "P-1", title: "Default" }], pageByTask: {}, nextPage: 2, tasks: {}, checkpoints: {}, nextTask: 1, nextCheckpoint: 1 };
}
function text(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8000) throw new Error(`${label} must contain 1–8000 characters`);
  return value.trim();
}
export function getTask(state: State, id: string): Task {
  const task = state.tasks[id];
  if (!task) throw new Error(`Task ${id} was not found`);
  return task;
}
export function getLeaf(state: State, id: string): LeafTask {
  const task = getTask(state, id);
  if (task.kind !== "leaf") throw new Error(`${id} is a branch task; specify a leaf task`);
  return task;
}
export function getCheckpoint(state: State, id: string): Checkpoint {
  const checkpoint = state.checkpoints[id];
  if (!checkpoint) throw new Error(`Checkpoint ${id} was not found`);
  return checkpoint;
}
export function confidence(checkpoint: Checkpoint, config: TaskbusConfig): number {
  return config.decay ** checkpoint.effort;
}
export function validateTarget(state: State, taskId: string, checkpointId: string): void {
  const task = getLeaf(state, taskId);
  const checkpoint = getCheckpoint(state, checkpointId);
  if (checkpoint.taskId !== task.id || !task.checkpointIds.includes(checkpointId)) throw new Error(`${checkpointId} belongs to another task or has been archived`);
  if (checkpoint.status !== "pending") throw new Error(`${checkpointId} is ${checkpoint.status}; explicitly reopen it before continuing work`);
  const reasons = executionBlockers(state, checkpointId);
  if (reasons.length) throw new Error(reasons.join("; "));
}
function addCheckpoint(state: State, task: LeafTask, spec: string | CheckpointSpec, effort = 0, sourceId?: string): Checkpoint {
  const title = typeof spec === "string" ? spec : spec.title;
  const id = `CP-${state.nextCheckpoint++}`;
  const checkpoint: Checkpoint = { id, taskId: task.id, title: text(title, "Checkpoint title"), status: "pending", effort, reminders: {}, ...(typeof spec === "string" ? {} : { dependencies: structuredClone(spec.dependencies) }), ...(sourceId ? { sourceId } : {}) };
  state.checkpoints[id] = checkpoint;
  task.checkpointIds.push(id);
  return checkpoint;
}
function countNotice(state: State, task: LeafTask): string[] {
  const count = task.checkpointIds.length;
  return count > state.config.checkpointLimit
    ? [`${task.id} has ${count} active checkpoints, exceeding the limit of ${state.config.checkpointLimit}. Consider using task_split to group them into child tasks.`]
    : [];
}
function reminders(state: State, checkpoint: Checkpoint): string[] {
  if (checkpoint.status !== "pending") return [];
  const score = confidence(checkpoint, state.config);
  const matching = state.config.thresholds.filter((threshold) => score < threshold.below);
  const threshold = matching.at(-1);
  if (!threshold) return [];
  const last = checkpoint.reminders[threshold.id];
  if (last !== undefined && checkpoint.effort - last < state.config.reminderEvery) return [];
  for (const item of matching) checkpoint.reminders[item.id] = checkpoint.effort;
  return [renderPrompt(threshold.prompt, {
    taskId: checkpoint.taskId, checkpointId: checkpoint.id, title: checkpoint.title,
    confidence: `${(score * 100).toFixed(1)}%`, effort: String(Number(checkpoint.effort.toFixed(3))),
  })];
}

/** Transitions clone first, so validation failures leave the committed state intact. */
export function transition(previous: State, event: Event, legacy = false): Transition {
  const state = structuredClone(previous);
  const notices: string[] = [];
  const ids: string[] = [];
  switch (event.type) {
    case "initialized": {
      if (state.revision !== 0) throw new Error("Session is already initialized");
      state.config = validateConfig(event.config);
      break;
    }
    case "page_created": {
      const id = `P-${state.nextPage++}`;
      state.pages.push({ id, title: text(event.title, "Page title") });
      ids.push(id);
      break;
    }
    case "task_created": {
      let parent: BranchTask | undefined;
      if (event.parentId) {
        const node = getTask(state, event.parentId);
        if (node.kind !== "branch") throw new Error("Use task_split to migrate checkpoints when adding child tasks to a leaf task");
        parent = node;
      }
      const pageId = parent ? state.pageByTask[parent.id] : event.pageId ?? (legacy ? "P-1" : undefined);
      if (!pageId || !state.pages.some((page) => page.id === pageId)) throw new Error("Specify an existing pageId for a top-level task");
      if (parent && event.pageId && event.pageId !== pageId) throw new Error("Child tasks inherit their parent page");
      const id = `T-${state.nextTask++}`;
      const task: LeafTask = { kind: "leaf", id, title: text(event.title, "Task title"), checkpointIds: [], ...(parent ? { parentId: parent.id } : {}) };
      state.tasks[id] = task;
      state.pageByTask[id] = pageId;
      task.dependencies = structuredClone(event.dependencies);
      (parent ? parent.childIds : state.roots).push(id);
      ids.push(id);
      for (const title of event.checkpoints) ids.push(addCheckpoint(state, task, title).id);
      notices.push(...countNotice(state, task));
      break;
    }
    case "checkpoint_added": {
      const task = getLeaf(state, event.taskId);
      ids.push(addCheckpoint(state, task, { title: event.title, dependencies: event.dependencies }).id);
      notices.push(...countNotice(state, task));
      break;
    }
    case "renamed": {
      const page = state.pages.find((page) => page.id === event.id);
      if (page) { page.title = text(event.title, "Page title"); break; }
      const node = state.tasks[event.id] ?? getCheckpoint(state, event.id);
      if ("status" in node && node.status === "archived") throw new Error("Archived checkpoint titles are preserved in history");
      node.title = text(event.title, "Title");
      break;
    }
    case "checkpoint_completed": {
      const checkpoint = getCheckpoint(state, event.id);
      if (checkpoint.status !== "pending") throw new Error("Specify a pending checkpoint");
      if (!legacy) validateTarget(state, checkpoint.taskId, checkpoint.id);
      checkpoint.status = "done";
      checkpoint.summary = text(event.summary, "Completion summary");
      break;
    }
    case "checkpoint_reopened": {
      const checkpoint = getCheckpoint(state, event.id);
      if (checkpoint.status !== "done") throw new Error("Specify a completed checkpoint");
      checkpoint.status = "pending";
      checkpoint.reason = text(event.reason, "Reopen reason");
      break;
    }
    case "checkpoint_split": {
      const source = getCheckpoint(state, event.id);
      if (source.status !== "pending") throw new Error("Reopen a completed checkpoint before splitting it");
      const task = getLeaf(state, source.taskId);
      if (event.parts.length < 2) throw new Error("Provide at least two new checkpoints");
      const specified = event.parts.filter((part) => part.share !== undefined).length;
      if (specified !== 0 && specified !== event.parts.length) throw new Error("Specify all shares or omit all shares");
      const shares = event.parts.map((part) => part.share ?? 1);
      if (shares.some((share) => !Number.isFinite(share) || share <= 0)) throw new Error("Split shares must be positive numbers");
      const total = shares.reduce((sum, share) => sum + share, 0);
      if (!Number.isFinite(total)) throw new Error("The sum of split shares must be finite");
      const oldIndex = task.checkpointIds.indexOf(source.id);
      task.checkpointIds.splice(oldIndex, 1);
      source.status = "archived";
      source.replacementIds = [];
      let remaining = source.effort;
      for (const [index, part] of event.parts.entries()) {
        const effort = index === event.parts.length - 1 ? Math.max(0, remaining) : source.effort * (shares[index] / total);
        remaining -= effort;
        const child = addCheckpoint(state, task, { title: part.title, dependencies: part.dependencies ?? source.dependencies }, effort, source.id);
        child.ignored = source.ignored;
        child.dirtyReasons = structuredClone(source.dirtyReasons ?? []);
        source.replacementIds.push(child.id);
        ids.push(child.id);
        notices.push(...reminders(state, child));
      }
      task.checkpointIds.splice(-ids.length);
      task.checkpointIds.splice(oldIndex, 0, ...ids);
      notices.push(...countNotice(state, task));
      break;
    }
    case "task_split": {
      const source = getLeaf(state, event.taskId);
      if (event.groups.length < 2) throw new Error("Provide at least two child tasks");
      const assigned = event.groups.flatMap((group) => group.checkpointIds);
      if (assigned.length !== source.checkpointIds.length || new Set(assigned).size !== assigned.length || assigned.some((id) => !source.checkpointIds.includes(id))) {
        throw new Error("task_split must assign each active checkpoint to exactly one child task");
      }
      const branch: BranchTask = { ...source, kind: "branch", id: source.id, title: source.title, childIds: [], ...(source.parentId ? { parentId: source.parentId } : {}) };
      delete (branch as unknown as Record<string, unknown>).checkpointIds;
      state.tasks[source.id] = branch;
      for (const group of event.groups) {
        const id = `T-${state.nextTask++}`;
        const child: LeafTask = { kind: "leaf", id, title: text(group.title, "Child task title"), parentId: branch.id, dependencies: structuredClone(group.dependencies), checkpointIds: [...group.checkpointIds] };
        state.tasks[id] = child;
        state.pageByTask[id] = state.pageByTask[branch.id];
        branch.childIds.push(id);
        ids.push(id);
        for (const checkpointId of child.checkpointIds) state.checkpoints[checkpointId].taskId = id;
        if (group.dependencies?.length) markDirty(state, child.id, "Split group prerequisites require review");
        notices.push(...countNotice(state, child));
      }
      break;
    }
    case "ignore_changed": {
      const node = getNode(state, event.id);
      assertLive(state, event.id);
      if (Boolean(node.ignored) === event.ignored) { text(event.reason, "Ignore reason"); break; }
      node.ignored = event.ignored;
      node.review = text(event.reason, "Ignore reason");
      if (!event.ignored) for (const id of subtree(state, event.id)) markDirty(state, id, `Restored ${event.id}`);
      break;
    }
    case "dependencies_changed": {
      assertLive(state, event.id);
      const node = getNode(state, event.id);
      node.dependencies = structuredClone(event.dependencies);
      node.review = text(event.reason, "Dependency change reason");
      markDirty(state, event.id, "Dependencies changed; refresh required");
      break;
    }
    case "node_refreshed": {
      assertLive(state, event.id);
      const node = getNode(state, event.id);
      if (nodeState(state, event.id).certainty === "ignored") throw new Error("Restore ignored node before refresh");
      if (event.dependencies !== undefined) node.dependencies = structuredClone(event.dependencies);
      validateDependencies(state, event.id);
      for (const edge of node.dependencies ?? []) {
        const status = nodeState(state, edge.id);
        if (status.dirty || status.certainty === "ignored" || isArchived(state, edge.id)) throw new Error(`Refresh prerequisite ${edge.id} first or replace it`);
      }
      for (const parent of ancestors(state, event.id)) {
        if (getNode(state, parent).dirtyReasons?.length) throw new Error(`Refresh ancestor ${parent} first`);
        for (const edge of getNode(state, parent).dependencies ?? []) {
          const status = nodeState(state, edge.id);
          if (status.dirty || status.certainty === "ignored" || isArchived(state, edge.id)) throw new Error(`Refresh prerequisite ${edge.id} first or replace it`);
        }
      }
      const checkpoint = state.checkpoints[event.id];
      if (checkpoint?.status === "done" && !event.outcome) throw new Error("Refreshing a done checkpoint requires outcome keep or reopen");
      if (checkpoint && event.outcome === "reopen") checkpoint.status = "pending";
      node.review = text(event.summary, "Refresh summary");
      node.dirtyReasons = [];
      if (state.tasks[event.id] && JSON.stringify(getNode(previous, event.id).dependencies ?? []) !== JSON.stringify(node.dependencies ?? [])) {
        for (const child of children(state, event.id)) markDirty(state, child, `Ancestor ${event.id} prerequisites changed`);
      }
      break;
    }
    case "work_recorded": {
      if (!legacy) validateTarget(state, event.taskId, event.checkpointId);
      if (event.units !== 0 && event.units !== 1) throw new Error("Work units must be 0 or 1");
      const checkpoint = getCheckpoint(state, event.checkpointId);
      checkpoint.effort += event.units;
      if (event.units) notices.push(...reminders(state, checkpoint));
      break;
    }
  }
  if (!legacy) {
    const assignments = event.type === "task_created" || event.type === "checkpoint_added" || event.type === "checkpoint_split" || event.type === "task_split" ? ids : event.type === "dependencies_changed" || event.type === "node_refreshed" ? [event.id] : [];
    for (const id of assignments) {
      validateDependencies(state, id);
      for (const edge of getNode(state, id).dependencies ?? []) {
        const status = nodeState(state, edge.id);
        if (edge.kind === "strict" ? status.certainty !== "certain" : status.certainty === "ignored") throw new Error(`Invalid ${edge.kind} prerequisite ${edge.id}`);
      }
    }
    validateGraph(state);
    validateCertaintyInvariants(state);
    invalidateMutation(previous, state, event);
    propagateDirty(state);
  }
  state.revision++;
  return { state, notices, ids };
}

export function checkpointIds(state: State, taskId?: string): string[] {
  const roots = taskId ? [taskId] : state.roots;
  const ids: string[] = [];
  const stack = [...roots].reverse();
  while (stack.length) {
    const task = getTask(state, stack.pop()!);
    if (task.kind === "leaf") ids.push(...task.checkpointIds);
    else stack.push(...[...task.childIds].reverse());
  }
  return ids;
}
export function metrics(state: State, taskId?: string): Metrics {
  const checkpoints = checkpointIds(state, taskId).map((id) => state.checkpoints[id]);
  let completed = 0, ignored = 0, effort = 0, weighted = 0, weights = 0, lowest = 1, lowCount = 0, unplanned = 0;
  for (const checkpoint of checkpoints) {
    const score = confidence(checkpoint, state.config);
    const weight = Math.max(1, checkpoint.effort);
    const status = nodeState(state, checkpoint.id);
    ignored += Number(status.certainty === "ignored");
    completed += Number(status.certainty !== "ignored" && checkpoint.status === "done");
    effort += checkpoint.effort;
    weighted += score * weight;
    weights += weight;
    lowest = Math.min(lowest, score);
    if (state.config.thresholds.some((threshold) => score < threshold.below)) lowCount++;
  }
  const stack = taskId ? [taskId] : [...state.roots];
  while (stack.length) {
    const task = getTask(state, stack.pop()!);
    if (task.kind === "branch") stack.push(...task.childIds);
    else if (!task.checkpointIds.length && nodeState(state, task.id).certainty !== "ignored") unplanned++;
  }
  return {
    completed, ignored, total: checkpoints.length, progress: checkpoints.length ? (completed + ignored) / checkpoints.length : 0,
    confidence: weights ? weighted / weights : 1, effort, lowest, lowCount, unplanned,
  };
}

export function affectedTasks(state: State, event: Event): string[] {
  switch (event.type) {
    case "task_created": return event.parentId ? [event.parentId] : [];
    case "checkpoint_added": case "task_split": return [event.taskId];
    case "ignore_changed": case "node_refreshed": case "dependencies_changed":
      return [state.tasks[event.id]?.id ?? getCheckpoint(state, event.id).taskId];
    case "renamed": return state.pages.some((page) => page.id === event.id) ? [] : [state.tasks[event.id]?.id ?? getCheckpoint(state, event.id).taskId];
    case "checkpoint_completed": case "checkpoint_reopened": case "checkpoint_split": return [getCheckpoint(state, event.id).taskId];
    default: return [];
  }
}

/** A lock on a working leaf also protects mutations of its ancestors. */
export function assertUnlocked(state: State, targets: string[], active: Iterable<string>): void {
  const targetSet = new Set(targets);
  for (const taskId of active) {
    let task: Task | undefined = state.tasks[taskId];
    while (task) {
      if (targetSet.has(task.id)) throw new Error(`${task.id} has active work in its subtree; wait for it to finish before making changes`);
      task = task.parentId ? state.tasks[task.parentId] : undefined;
    }
  }
}

export class TaskStore {
  state: State;
  history: Envelope[] = [];
  constructor(config: TaskbusConfig, private readonly persist: (entry: Envelope) => void) {
    this.state = initialState(config);
  }
  commit(event: Event): Transition {
    const result = transition(this.state, event);
    const envelope: Envelope = {
      version: 1, semantics: 2, revision: result.state.revision, timestamp: new Date().toISOString(), event: structuredClone(event),
      ...(result.state.revision % 50 === 0 ? { snapshot: structuredClone(result.state) } : {}),
    };
    // Persist before publishing the new state; a persistence error aborts the transition.
    this.persist(envelope);
    this.state = result.state;
    this.history.push(envelope);
    return result;
  }
  static restore(entries: unknown[], fallback: TaskbusConfig, persist: (entry: Envelope) => void): TaskStore {
    const store = new TaskStore(fallback, persist);
    for (const raw of entries) {
      const envelope = raw as Envelope;
      if (!envelope || envelope.version !== 1 || (envelope.semantics !== undefined && envelope.semantics !== 2) || envelope.revision !== store.state.revision + 1 || !envelope.event) {
        throw new Error("Invalid Taskbus session journal version or revision");
      }
      store.state = transition(store.state, envelope.event, envelope.semantics !== 2).state;
      store.history.push(structuredClone(envelope));
    }
    return store;
  }
}

export type Certainty = "certain" | "uncertain" | "ignored";
export interface NodeStatus {
  certainty: Certainty;
  done: boolean;
  dirty: boolean;
  directDirty: boolean;
  completion: "pending" | "certainly done" | "uncertainly done" | "ignored" | "archived";
}
export function getNode(state: State, id: string): Task | Checkpoint {
  return state.tasks[id] ?? getCheckpoint(state, id);
}
export function isArchived(state: State, id: string): boolean { return state.checkpoints[id]?.status === "archived"; }
function assertLive(state: State, id: string): void {
  getNode(state, id);
  if (isArchived(state, id)) throw new Error(`Archived checkpoint ${id} is historical; use its replacements`);
}
export function children(state: State, id: string): string[] {
  const task = state.tasks[id];
  return task ? task.kind === "branch" ? task.childIds : task.checkpointIds : [];
}
export function ancestors(state: State, id: string): string[] {
  const result: string[] = [];
  let parent: string | undefined = state.tasks[id]?.parentId ?? state.checkpoints[id]?.taskId;
  while (parent) { result.push(parent); parent = state.tasks[parent]?.parentId; }
  return result;
}
export function subtree(state: State, id: string): string[] {
  const result: string[] = [], stack = [id];
  while (stack.length) { const next = stack.pop()!; result.push(next); stack.push(...children(state, next)); }
  return result;
}
export function nodeState(state: State, id: string): NodeStatus {
  const cache = new Map<string, NodeStatus>();
  function derive(id: string): NodeStatus {
    const found = cache.get(id);
    if (found) return found;
    const node = getNode(state, id);
    const inheritedIgnore = [id, ...ancestors(state, id)].some((key) => getNode(state, key).ignored);
    const directDirty = Boolean(node.dirtyReasons?.length);
    const childStates = children(state, id).map(derive);
    const certainty: Certainty = inheritedIgnore || (childStates.length > 0 && childStates.every((child) => child.certainty === "ignored")) ? "ignored"
      : childStates.some((child) => child.certainty !== "certain") ? "uncertain" : "certain";
    const checkpoint = state.checkpoints[id];
    const done = certainty !== "ignored" && !isArchived(state, id) && (checkpoint ? checkpoint.status === "done"
      : childStates.length > 0 && childStates.every((child) => child.done || child.certainty === "ignored"));
    const dirty = directDirty || childStates.some((child) => child.dirty && child.certainty !== "ignored") || ancestors(state, id).some((parent) => Boolean(getNode(state, parent).dirtyReasons?.length));
    const result: NodeStatus = { certainty, done, dirty, directDirty,
      completion: isArchived(state, id) ? "archived" : certainty === "ignored" ? "ignored" : done ? certainty === "certain" ? "certainly done" : "uncertainly done" : "pending" };
    cache.set(id, result);
    return result;
  }
  return derive(id);
}
function markDirty(state: State, id: string, reason: string): boolean {
  let changed = false;
  // Direct invalidation of a task also invalidates each existing descendant's evidence.
  // Each must be reviewed independently; refreshing the parent cannot launder done children.
  for (const key of subtree(state, id)) {
    const node = getNode(state, key);
    changed ||= !node.dirtyReasons?.length;
    node.dirtyReasons ??= [];
    if (!node.dirtyReasons.includes(reason)) node.dirtyReasons.push(reason);
  }
  return changed;
}

function validateDependencies(state: State, id: string): void {
  const seen = new Set<string>();
  for (const edge of getNode(state, id).dependencies ?? []) {
    assertLive(state, edge.id);
    if (edge.kind !== "strict" && edge.kind !== "soft") throw new Error("Dependency kind must be strict or soft");
    if (seen.has(edge.id)) throw new Error(`Duplicate prerequisite ${edge.id}`);
    seen.add(edge.id);
  }
}
function validateCertaintyInvariants(state: State): void {
  for (const id of [...Object.keys(state.tasks), ...Object.keys(state.checkpoints)]) {
    if (isArchived(state, id)) continue;
    for (const edge of getNode(state, id).dependencies ?? []) {
      // A split deliberately retains the old edge for explicit repair.
      if (isArchived(state, edge.id)) continue;
      const status = nodeState(state, edge.id);
      if (edge.kind === "strict" && status.certainty !== "certain") throw new Error(`Strict prerequisite ${edge.id} must remain certain (required by ${id})`);
      if (edge.kind === "soft" && status.certainty === "ignored") throw new Error(`Soft prerequisite ${edge.id} must remain nonignored (required by ${id})`);
    }
  }
}
function validateGraph(state: State): void {
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string): void {
    if (isArchived(state, id)) return; // Historical edges are repair blockers, not executable waits.
    if (visiting.has(id)) throw new Error(`Dependency cycle involving ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    // A task's completion waits for its children. A descendant's execution waits for all ancestor prerequisites.
    const deps = [id, ...ancestors(state, id)].flatMap((key) => (getNode(state, key).dependencies ?? []).map((edge) => edge.id));
    for (const target of [...children(state, id), ...deps]) { getNode(state, target); visit(target); }
    visiting.delete(id); visited.add(id);
  }
  for (const id of [...Object.keys(state.tasks), ...Object.keys(state.checkpoints)]) if (!isArchived(state, id)) visit(id);
}
function propagateDirty(state: State): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...Object.keys(state.tasks), ...Object.keys(state.checkpoints)]) {
      if (isArchived(state, id)) continue;
      for (const edge of getNode(state, id).dependencies ?? []) {
        if (isArchived(state, edge.id) || nodeState(state, edge.id).dirty) changed = markDirty(state, id, `Prerequisite ${edge.id} requires review`) || changed;
      }
    }
  }
}
function invalidateMutation(before: State, state: State, event: Event): void {
  const changed = new Set<string>();
  const add = (id: string) => { changed.add(id); for (const parent of ancestors(state, id)) changed.add(parent); };
  switch (event.type) {
    case "ignore_changed": if (Boolean(getNode(before, event.id).ignored) !== event.ignored) for (const id of subtree(state, event.id)) add(id); break;
    case "checkpoint_split": case "checkpoint_reopened": case "dependencies_changed": add(event.id); break;
    case "task_split": case "checkpoint_added": add(event.taskId); break;
    case "task_created": if (event.parentId) add(event.parentId); break;
    case "node_refreshed": {
      const old = getNode(before, event.id), next = getNode(state, event.id);
      if (JSON.stringify(old.dependencies ?? []) !== JSON.stringify(next.dependencies ?? []) || (event.outcome === "reopen" && before.checkpoints[event.id]?.status === "done")) add(event.id);
      break;
    }
  }
  if (!changed.size) return;
  for (const id of [...Object.keys(before.tasks), ...Object.keys(before.checkpoints)]) {
    if (isArchived(state, id)) continue;
    for (const edge of getNode(state, id).dependencies ?? []) if (changed.has(edge.id)) markDirty(state, id, `Prerequisite ${edge.id} changed (${event.type})`);
  }
}
function prerequisiteIssues(state: State, id: string, seen = new Set<string>(), memo = new Map<string, string[]>()): string[] {
  const cached = memo.get(id);
  if (cached) return cached;
  if (seen.has(id)) return [`Dependency cycle at ${id}`];
  const status = nodeState(state, id), issues: string[] = [];
  if (isArchived(state, id)) return [`${id} is archived; replace its dependency edge`];
  if (status.certainty === "ignored") return [`${id} is ignored`];
  if (status.dirty) issues.push(`${id} is dirty; refresh required`);
  if (!status.done) issues.push(`${id} is ${status.completion}`);
  const next = new Set(seen).add(id);
  // Completion bits retained by refresh do not bypass pending evidence further upstream.
  for (const key of subtree(state, id)) {
    if (nodeState(state, key).certainty === "ignored") continue;
    for (const owner of [key, ...ancestors(state, key)]) for (const edge of getNode(state, owner).dependencies ?? []) {
      if (edge.kind === "strict" && nodeState(state, edge.id).certainty !== "certain") issues.push(`${edge.id} must be certain`);
      issues.push(...prerequisiteIssues(state, edge.id, next, memo));
    }
  }
  const result = [...new Set(issues)];
  memo.set(id, result);
  return result;
}
export function executionBlockers(state: State, id: string): string[] {
  const reasons: string[] = [];
  const memo = new Map<string, string[]>();
  const status = nodeState(state, id);
  if (isArchived(state, id)) reasons.push(`${id} is archived`);
  if (status.certainty === "ignored") reasons.push(`${id} is ignored`);
  if (state.checkpoints[id]?.status === "done") reasons.push(`${id} is done; reopen before work`);
  for (const key of [id, ...ancestors(state, id)]) {
    if (getNode(state, key).dirtyReasons?.length) reasons.push(`${key} is dirty; refresh required`);
    for (const edge of getNode(state, key).dependencies ?? []) {
      const prerequisite = nodeState(state, edge.id);
      const issues = [...prerequisiteIssues(state, edge.id, new Set(), memo)];
      if (edge.kind === "strict" && prerequisite.certainty !== "certain") issues.push(`${edge.id} must be certain`);
      if (issues.length) {
        reasons.push(`${key} requires ${edge.kind} ${edge.id}: ${issues.join(", ")}`);
      }
    }
  }
  return [...new Set(reasons)];
}
export interface AvailableItem { taskId: string; checkpointId?: string; title: string; pageId: string; available: boolean; blockers: string[]; taskStatus: NodeStatus; checkpointStatus?: NodeStatus; summary?: string; taskTitle?: string; dependencies?: Dependency[]; inheritedDependencies?: { ownerId: string; id: string; kind: "strict" | "soft" }[]; dirtyReasons?: string[]; effort?: number }
export function availableWork(state: State, options: { pageId?: string; taskId?: string; includeBlocked?: boolean } = {}, active: Iterable<string> = []) {
  if (options.taskId) getTask(state, options.taskId);
  if (options.pageId && !state.pages.some((page) => page.id === options.pageId)) throw new Error("Unknown pageId");
  const running = new Set(active);
  const ids = options.taskId ? subtree(state, options.taskId) : Object.keys(state.tasks);
  return ids.filter((id) => state.tasks[id]?.kind === "leaf" && (!options.pageId || state.pageByTask[id] === options.pageId)).flatMap<AvailableItem>((taskId) => {
    const task = getLeaf(state, taskId);
    if (!task.checkpointIds.length) return options.includeBlocked ? [{ taskId, checkpointId: undefined, title: task.title, pageId: state.pageByTask[taskId], available: false, blockers: ["Unplanned task; add checkpoints"], taskStatus: nodeState(state, taskId), checkpointStatus: undefined, summary: undefined as string | undefined }] : [];
    return task.checkpointIds.map((checkpointId) => {
      const checkpoint = getCheckpoint(state, checkpointId);
      const blockers = executionBlockers(state, checkpointId);
      if (running.has(taskId)) blockers.push(`${taskId} has active work`);
      return { taskId, checkpointId, title: checkpoint.title, pageId: state.pageByTask[taskId], available: blockers.length === 0, blockers, taskStatus: nodeState(state, taskId), checkpointStatus: nodeState(state, checkpointId), summary: checkpoint.summary, taskTitle: task.title, dependencies: checkpoint.dependencies ?? [], inheritedDependencies: [taskId, ...ancestors(state, taskId)].flatMap((ownerId) => (getNode(state, ownerId).dependencies ?? []).map((edge) => ({ ownerId, ...edge }))), dirtyReasons: checkpoint.dirtyReasons ?? [], effort: checkpoint.effort };
    }).filter((item) => options.includeBlocked || item.available);
  });
}

/** Reject mutations touching the target or any evidence reserved by an active leaf. */
export function assertMutationSafe(state: State, event: Event, active: Iterable<string>): void {
  const tasks = [...active];
  assertUnlocked(state, affectedTasks(state, event), tasks);
  if (!tasks.length || event.type === "work_recorded") return;
  const next = transition(state, event).state;
  function evidence(s: State, taskId: string): string {
    const evidence = new Set<string>(), gates = new Set<string>();
    function capture(id: string): void {
      if (evidence.has(id)) return;
      evidence.add(id);
      for (const child of children(s, id)) capture(child);
      for (const key of [id, ...ancestors(s, id)]) {
        gates.add(key);
        for (const edge of getNode(s, key).dependencies ?? []) capture(edge.id);
      }
    }
    for (const id of subtree(s, taskId)) capture(id);
    // Ancestor aggregate state and unrelated siblings do not affect this run's execution gates.
    return JSON.stringify({
      evidence: [...evidence].sort().map((id) => [id, getNode(s, id), nodeState(s, id)]),
      gates: [...gates].sort().map((id) => {
        const node = getNode(s, id);
        return [id, node.ignored ?? false, node.dependencies ?? [], node.dirtyReasons ?? []];
      }),
    });
  }
  for (const task of tasks) if (evidence(state, task) !== evidence(next, task)) throw new Error(`${task} has active work using affected prerequisite evidence`);
}
