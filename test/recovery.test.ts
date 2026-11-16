import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { TaskStore, type Envelope, type Event } from "../src/model.ts";
import { WorkRecovery } from "../src/recovery.ts";

const work = (callId: string): Extract<Event, { type: "work_recorded" }> => ({ type: "work_recorded", taskId: "T-1", checkpointId: "CP-1", callId, tool: "read", units: 1, isError: false, durationMs: 2 });

test("write-ahead accounting survives session persistence failure and reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskbus-recovery-"));
  try {
    const path = join(dir, "pending.json");
    const log: Envelope[] = [];
    let fail = false;
    const persist = (entry: Envelope) => { if (fail) throw new Error("session append failed"); log.push(structuredClone(entry)); };
    const store = new TaskStore(DEFAULT_CONFIG, persist);
    store.commit({ type: "initialized", config: DEFAULT_CONFIG });
    store.commit({ type: "task_created", pageId: "P-1", title: "任务", checkpoints: ["验收"] });
    fail = true;
    const journal = new WorkRecovery(path);
    assert.throws(() => journal.record(store, work("first")), /session append failed/);
    assert.throws(() => journal.record(store, work("second")), /session append failed/);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).length, 2);
    assert.equal(store.state.checkpoints["CP-1"].effort, 0);
    fail = false;
    const resumed = TaskStore.restore(log, DEFAULT_CONFIG, persist);
    new WorkRecovery(path).recover(resumed);
    assert.equal(resumed.state.checkpoints["CP-1"].effort, 2);
    assert.throws(() => readFileSync(path), /ENOENT/);
  } finally { rmSync(dir, { recursive: true }); }
});

test("recovery deduplicates an event already appended before cleanup failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskbus-recovery-"));
  try {
    const path = join(dir, "pending.json");
    const store = new TaskStore(DEFAULT_CONFIG, () => {});
    store.commit({ type: "task_created", pageId: "P-1", title: "任务", checkpoints: ["验收"] });
    const revision = store.state.revision;
    store.commit(work("existing"));
    // Reproduce a crash after append and before clearing the sidecar.
    writeFileSync(path, JSON.stringify([{ baseRevision: revision, event: work("existing") }]));
    new WorkRecovery(path).recover(store);
    assert.equal(store.state.checkpoints["CP-1"].effort, 1);
  } finally { rmSync(dir, { recursive: true }); }
});

test("recovery detects a conflicting branch revision", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskbus-recovery-"));
  try {
    const path = join(dir, "pending.json");
    const store = new TaskStore(DEFAULT_CONFIG, () => {});
    store.commit({ type: "task_created", pageId: "P-1", title: "任务", checkpoints: ["验收"] });
    writeFileSync(path, JSON.stringify([{ baseRevision: 9, event: work("old-branch") }]));
    assert.throws(() => new WorkRecovery(path).recover(store), /original session branch/);
    assert.equal(store.state.checkpoints["CP-1"].effort, 0);
  } finally { rmSync(dir, { recursive: true }); }
});

test("paged dependent work recovers with new journal semantics and preserved dirty state", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskbus-paged-recovery-"));
  try {
    const path = join(dir, "pending.json"), entries: Envelope[] = [];
    let fail = false;
    const persist = (entry: Envelope) => { if (fail) throw new Error("append failed"); entries.push(structuredClone(entry)); };
    const store = new TaskStore(DEFAULT_CONFIG, persist);
    store.commit({ type: "task_created", pageId: "P-1", title: "Source", checkpoints: ["source"] });
    store.commit({ type: "checkpoint_completed", id: "CP-1", summary: "Verified" });
    store.commit({ type: "page_created", title: "Consumer page" });
    store.commit({ type: "task_created", pageId: "P-2", title: "Consumer", dependencies: [{ id: "CP-1", kind: "strict" }], checkpoints: ["consume"] });
    const record = { ...work("dependent"), taskId: "T-2", checkpointId: "CP-2" };
    fail = true;
    assert.throws(() => new WorkRecovery(path).record(store, record), /append failed/);
    fail = false;
    const resumed = TaskStore.restore(entries, DEFAULT_CONFIG, persist);
    new WorkRecovery(path).recover(resumed);
    assert.equal(resumed.state.checkpoints["CP-2"].effort, 1);
    assert.equal(resumed.state.pageByTask["T-2"], "P-2");
    resumed.commit({ type: "checkpoint_reopened", id: "CP-1", reason: "Evidence changed" });
    const replayed = TaskStore.restore(entries, DEFAULT_CONFIG, () => {});
    assert.deepEqual(replayed.state, resumed.state);
    assert.ok(replayed.state.checkpoints["CP-2"].dirtyReasons?.length);
    assert.ok(entries.every((entry) => entry.semantics === 2));
  } finally { rmSync(dir, { recursive: true }); }
});
