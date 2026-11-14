import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Event, TaskStore } from "./model.ts";

type WorkEvent = Extract<Event, { type: "work_recorded" }>;
interface PendingWork { baseRevision: number; event: WorkEvent }

/** A small write-ahead sidecar preserves accounting when the session append fails. */
export class WorkRecovery {
  private pending: PendingWork[] = [];
  constructor(private readonly path: string) {
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!Array.isArray(value) || value.some((item) => !item || !Number.isSafeInteger(item.baseRevision) || item.event?.type !== "work_recorded")) {
        throw new Error("Invalid work recovery journal format");
      }
      this.pending = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(this.pending), { mode: 0o600 });
    renameSync(temp, this.path);
  }
  record(store: TaskStore, event: WorkEvent): string[] {
    const last = this.pending.at(-1);
    this.pending.push({ baseRevision: last ? last.baseRevision + 1 : store.state.revision, event });
    this.save();
    return this.recover(store);
  }
  recover(store: TaskStore): string[] {
    const notices: string[] = [];
    while (this.pending.length) {
      const item = this.pending[0];
      const existing = store.history.find((entry) => entry.revision === item.baseRevision + 1);
      if (existing?.event.type === "work_recorded" && existing.event.callId === item.event.callId && existing.event.checkpointId === item.event.checkpointId) {
        this.pending.shift();
        this.save();
        continue;
      }
      if (store.state.revision !== item.baseRevision) {
        throw new Error(`Work accounting needs recovery (expected revision ${item.baseRevision}). Return to the original session branch and run /taskbus recover. Recovery file: ${this.path}`);
      }
      notices.push(...store.commit(item.event).notices);
      this.pending.shift();
      this.save();
    }
    try { unlinkSync(this.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return notices;
  }
}
