import { validateTarget, type State } from "./model.ts";

export interface Binding { taskId: string; checkpointId: string }
export interface CallEvent { toolCallId: string; toolName: string; parentToolCallId?: string }
export interface CallRecord extends Binding {
  callId: string;
  parentCallId: string;
  tool: string;
  units: 0 | 1;
  isError: boolean;
  durationMs: number;
}
interface RunningCall extends Binding {
  rootId: string;
  parentId: string;
  tool: string;
  ran: boolean;
  descendantRan: boolean;
}
interface RootCall extends Binding { records: CallRecord[]; notices: string[] }

/** Per-call ancestry provides isolation for concurrent gateways and nested tools. */
export class Attribution {
  private readonly roots = new Map<string, RootCall>();
  private readonly calls = new Map<string, RunningCall>();
  constructor(private readonly management: ReadonlySet<string>) {}

  begin(id: string, binding: Binding, state: State): void {
    validateTarget(state, binding.taskId, binding.checkpointId);
    if (this.roots.has(id)) throw new Error("Duplicate task_run call ID");
    this.roots.set(id, { ...binding, records: [], notices: [] });
  }
  activeTasks(): string[] { return [...this.roots.values()].map((root) => root.taskId); }
  gate(event: CallEvent, state: State): string | undefined {
    if (this.management.has(event.toolName) || event.toolName === "task_run") {
      if (event.parentToolCallId) return "Call task management tools and task_run directly; nested work tools may only execute attributed work";
      return;
    }
    const parentId = event.parentToolCallId;
    if (!parentId) return "Create a leaf task and checkpoint, then execute work through task_run({taskId, checkpointId, tool, args})";
    const parent = this.calls.get(parentId);
    const rootId = parent?.rootId ?? parentId;
    const root = this.roots.get(rootId);
    if (!root) return "This call has no valid task_run attribution";
    validateTarget(state, root.taskId, root.checkpointId);
    this.calls.set(event.toolCallId, {
      taskId: root.taskId, checkpointId: root.checkpointId, rootId, parentId,
      tool: event.toolName, ran: false, descendantRan: false,
    });
  }
  executed(callId: string): void {
    const call = this.calls.get(callId);
    if (!call) return;
    call.ran = true;
    let parentId = call.parentId;
    while (this.calls.has(parentId)) {
      const parent = this.calls.get(parentId)!;
      parent.descendantRan = true;
      parentId = parent.parentId;
    }
  }
  end(callId: string, isError: boolean, durationMs?: number): CallRecord | undefined {
    const call = this.calls.get(callId);
    if (!call) return;
    this.calls.delete(callId);
    // tool_result proves execution; durationMs also covers execution whose result hook failed.
    if (!call.ran && durationMs === undefined) return;
    this.executedAncestors(call.parentId);
    const record: CallRecord = {
      taskId: call.taskId, checkpointId: call.checkpointId, callId, parentCallId: call.parentId,
      tool: call.tool, units: call.descendantRan ? 0 : 1, isError, durationMs: durationMs ?? 0,
    };
    this.roots.get(call.rootId)?.records.push(record);
    return record;
  }
  private executedAncestors(parentId: string): void {
    while (this.calls.has(parentId)) {
      const parent = this.calls.get(parentId)!;
      parent.descendantRan = true;
      parentId = parent.parentId;
    }
  }
  notify(callId: string, notices: string[]): void {
    // end() has removed the call, so find its gateway by the retained audit record.
    for (const root of this.roots.values()) {
      if (root.records.some((record) => record.callId === callId)) {
        root.notices.push(...notices);
        break;
      }
    }
  }
  finish(id: string): { records: CallRecord[]; notices: string[] } {
    const root = this.roots.get(id);
    this.roots.delete(id);
    for (const [callId, call] of this.calls) if (call.rootId === id) this.calls.delete(callId);
    return { records: root?.records ?? [], notices: root?.notices ?? [] };
  }
  clear(): void { this.roots.clear(); this.calls.clear(); }
}
