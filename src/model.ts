import { renderPrompt, validateConfig, type TaskbusConfig } from "./config.ts";

export interface LeafTask {
  kind: "leaf";
  id: string;
  title: string;
  parentId?: string;
  checkpointIds: string[];
}
export interface BranchTask {
  kind: "branch";
  id: string;
  title: string;
  parentId?: string;
  childIds: string[];
}
export type Task = LeafTask | BranchTask;
export interface Checkpoint {
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
  tasks: Record<string, Task>;
  checkpoints: Record<string, Checkpoint>;
  nextTask: number;
  nextCheckpoint: number;
}
export interface Part { title: string; share?: number }
export interface TaskGroup { title: string; checkpointIds: string[] }
export type Event =
  | { type: "initialized"; config: TaskbusConfig }
  | { type: "task_created"; title: string; parentId?: string; checkpoints: string[] }
  | { type: "checkpoint_added"; taskId: string; title: string }
  | { type: "renamed"; id: string; title: string }
  | { type: "checkpoint_completed"; id: string; summary: string }
  | { type: "checkpoint_reopened"; id: string; reason: string }
  | { type: "checkpoint_split"; id: string; parts: Part[] }
  | { type: "task_split"; taskId: string; groups: TaskGroup[] }
  | { type: "work_recorded"; taskId: string; checkpointId: string; callId: string; tool: string; units: 0 | 1; isError: boolean; durationMs: number };
export interface Envelope {
  version: 1;
  revision: number;
  timestamp: string;
  event: Event;
  snapshot?: State;
}
export interface Metrics {
  completed: number;
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
  return { version: 1, revision: 0, config: validateConfig(config), roots: [], tasks: {}, checkpoints: {}, nextTask: 1, nextCheckpoint: 1 };
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
}
function addCheckpoint(state: State, task: LeafTask, title: string, effort = 0, sourceId?: string): Checkpoint {
  const id = `CP-${state.nextCheckpoint++}`;
  const checkpoint: Checkpoint = { id, taskId: task.id, title: text(title, "Checkpoint title"), status: "pending", effort, reminders: {}, ...(sourceId ? { sourceId } : {}) };
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
export function transition(previous: State, event: Event): Transition {
  const state = structuredClone(previous);
  const notices: string[] = [];
  const ids: string[] = [];
  switch (event.type) {
    case "initialized": {
      if (state.revision !== 0) throw new Error("Session is already initialized");
      state.config = validateConfig(event.config);
      break;
    }
    case "task_created": {
      let parent: BranchTask | undefined;
      if (event.parentId) {
        const node = getTask(state, event.parentId);
        if (node.kind !== "branch") throw new Error("Use task_split to migrate checkpoints when adding child tasks to a leaf task");
        parent = node;
      }
      const id = `T-${state.nextTask++}`;
      const task: LeafTask = { kind: "leaf", id, title: text(event.title, "Task title"), checkpointIds: [], ...(parent ? { parentId: parent.id } : {}) };
      state.tasks[id] = task;
      (parent ? parent.childIds : state.roots).push(id);
      ids.push(id);
      for (const title of event.checkpoints) ids.push(addCheckpoint(state, task, title).id);
      notices.push(...countNotice(state, task));
      break;
    }
    case "checkpoint_added": {
      const task = getLeaf(state, event.taskId);
      ids.push(addCheckpoint(state, task, event.title).id);
      notices.push(...countNotice(state, task));
      break;
    }
    case "renamed": {
      const node = state.tasks[event.id] ?? getCheckpoint(state, event.id);
      if ("status" in node && node.status === "archived") throw new Error("Archived checkpoint titles are preserved in history");
      node.title = text(event.title, "Title");
      break;
    }
    case "checkpoint_completed": {
      const checkpoint = getCheckpoint(state, event.id);
      if (checkpoint.status !== "pending") throw new Error("Specify a pending checkpoint");
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
        const child = addCheckpoint(state, task, part.title, effort, source.id);
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
      const branch: BranchTask = { kind: "branch", id: source.id, title: source.title, childIds: [], ...(source.parentId ? { parentId: source.parentId } : {}) };
      state.tasks[source.id] = branch;
      for (const group of event.groups) {
        const id = `T-${state.nextTask++}`;
        const child: LeafTask = { kind: "leaf", id, title: text(group.title, "Child task title"), parentId: branch.id, checkpointIds: [...group.checkpointIds] };
        state.tasks[id] = child;
        branch.childIds.push(id);
        ids.push(id);
        for (const checkpointId of child.checkpointIds) state.checkpoints[checkpointId].taskId = id;
        notices.push(...countNotice(state, child));
      }
      break;
    }
    case "work_recorded": {
      validateTarget(state, event.taskId, event.checkpointId);
      if (event.units !== 0 && event.units !== 1) throw new Error("Work units must be 0 or 1");
      const checkpoint = getCheckpoint(state, event.checkpointId);
      checkpoint.effort += event.units;
      if (event.units) notices.push(...reminders(state, checkpoint));
      break;
    }
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
  let completed = 0, effort = 0, weighted = 0, weights = 0, lowest = 1, lowCount = 0, unplanned = 0;
  for (const checkpoint of checkpoints) {
    const score = confidence(checkpoint, state.config);
    const weight = Math.max(1, checkpoint.effort);
    completed += Number(checkpoint.status === "done");
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
    else if (!task.checkpointIds.length) unplanned++;
  }
  return {
    completed, total: checkpoints.length, progress: checkpoints.length ? completed / checkpoints.length : 0,
    confidence: weights ? weighted / weights : 1, effort, lowest, lowCount, unplanned,
  };
}

export function affectedTasks(state: State, event: Event): string[] {
  switch (event.type) {
    case "task_created": return event.parentId ? [event.parentId] : [];
    case "checkpoint_added": case "task_split": return [event.taskId];
    case "renamed": return [state.tasks[event.id]?.id ?? getCheckpoint(state, event.id).taskId];
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
      version: 1, revision: result.state.revision, timestamp: new Date().toISOString(), event: structuredClone(event),
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
      if (!envelope || envelope.version !== 1 || envelope.revision !== store.state.revision + 1 || !envelope.event) {
        throw new Error("Invalid Taskbus session journal version or revision");
      }
      store.state = transition(store.state, envelope.event).state;
      store.history.push(structuredClone(envelope));
    }
    return store;
  }
}
