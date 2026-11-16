import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { TaskStore, assertUnlocked, confidence, metrics, validateTarget, type Envelope, type Event } from "../src/model.ts";

function setup() {
  const log: Envelope[] = [];
  const store = new TaskStore(DEFAULT_CONFIG, (entry) => log.push(structuredClone(entry)));
  store.commit({ type: "initialized", config: DEFAULT_CONFIG });
  store.commit({ type: "task_created", pageId: "P-1", title: "项目", checkpoints: ["验收 A", "验收 B"] });
  return { store, log };
}
function work(checkpointId = "CP-1", units: 0 | 1 = 1): Event {
  return { type: "work_recorded", taskId: "T-1", checkpointId, callId: "call", tool: "read", units, isError: false, durationMs: 1 };
}

test("counted work calls apply decay and preserve management accounting", () => {
  const { store } = setup();
  store.commit(work());
  assert.equal(confidence(store.state.checkpoints["CP-1"], store.state.config), 0.95);
  store.commit(work("CP-1", 0));
  store.commit({ type: "renamed", id: "CP-1", title: "改名" });
  assert.equal(store.state.checkpoints["CP-1"].effort, 1);
  assert.equal(metrics(store.state).confidence, (0.95 + 1) / 2);
});

test("multiple threshold prompts follow crossing and cooldown", () => {
  const { store } = setup();
  const notices: { call: number; text: string }[] = [];
  for (let call = 1; call <= 25; call++) {
    for (const text of store.commit(work()).notices) notices.push({ call, text });
  }
  assert.deepEqual(notices.map((item) => item.call), [10, 15, 20, 24]);
  assert.match(notices.at(-1)!.text, /Strongly consider splitting/);
});

test("completion freezes confidence and reopening continues historical effort", () => {
  const { store } = setup();
  for (let i = 0; i < 12; i++) store.commit(work());
  const score = confidence(store.state.checkpoints["CP-1"], store.state.config);
  store.commit({ type: "checkpoint_completed", id: "CP-1", summary: "测试通过" });
  assert.equal(metrics(store.state).progress, 0.5);
  assert.throws(() => store.commit(work()), /explicitly reopen/);
  assert.throws(() => store.commit({ type: "checkpoint_reopened", id: "CP-1", reason: " " }));
  assert.equal(store.state.checkpoints["CP-1"].status, "done");
  store.commit({ type: "checkpoint_reopened", id: "CP-1", reason: "需求改变" });
  assert.equal(confidence(store.state.checkpoints["CP-1"], store.state.config), score);
  store.commit(work());
  assert.ok(confidence(store.state.checkpoints["CP-1"], store.state.config) < score);
});

test("checkpoint split conserves effort and preserves archive and ordering", () => {
  const { store } = setup();
  for (let i = 0; i < 12; i++) store.commit(work());
  store.commit({ type: "checkpoint_split", id: "CP-1", parts: [{ title: "细化 A", share: 1 }, { title: "细化 B", share: 3 }] });
  const source = store.state.checkpoints["CP-1"];
  assert.equal(source.status, "archived");
  assert.deepEqual(source.replacementIds, ["CP-3", "CP-4"]);
  assert.equal(store.state.checkpoints["CP-3"].effort, 3);
  assert.equal(store.state.checkpoints["CP-4"].effort, 9);
  const task = store.state.tasks["T-1"];
  assert.equal(task.kind, "leaf");
  if (task.kind === "leaf") assert.deepEqual(task.checkpointIds, ["CP-3", "CP-4", "CP-2"]);
  assert.equal(metrics(store.state).effort, 12);
  assert.equal(metrics(store.state).total, 3);
  assert.throws(() => validateTarget(store.state, "T-1", "CP-1"));
  assert.throws(() => store.commit({ type: "checkpoint_split", id: "CP-2", parts: [{ title: "x", share: 1 }, { title: "y" }] }));
});

test("task split migrates each checkpoint once and preserves aggregate metrics", () => {
  const { store } = setup();
  for (let i = 0; i < 4; i++) store.commit(work());
  store.commit({ type: "checkpoint_completed", id: "CP-2", summary: "完成" });
  const before = metrics(store.state);
  assert.throws(() => store.commit({ type: "task_split", taskId: "T-1", groups: [{ title: "a", checkpointIds: ["CP-1"] }, { title: "b", checkpointIds: [] }] }), /exactly one/);
  store.commit({ type: "task_split", taskId: "T-1", groups: [{ title: "a", checkpointIds: ["CP-1"] }, { title: "b", checkpointIds: ["CP-2"] }] });
  assert.deepEqual(metrics(store.state, "T-1"), before);
  assert.equal("checkpointIds" in store.state.tasks["T-1"], false);
  assert.equal(store.state.checkpoints["CP-1"].taskId, "T-2");
  assert.throws(() => validateTarget(store.state, "T-1", "CP-1"), /branch task/);
  validateTarget(store.state, "T-2", "CP-1");
  store.commit({ type: "task_created", pageId: "P-1", title: "空任务", parentId: "T-1", checkpoints: [] });
  assert.equal(metrics(store.state).unplanned, 1);
});

test("ancestor progress aggregates descendant checkpoint counts", () => {
  const { store } = setup();
  for (let i = 0; i < 8; i++) store.commit({ type: "checkpoint_added", taskId: "T-1", title: `额外 ${i}` });
  store.commit({ type: "checkpoint_completed", id: "CP-1", summary: "完成" });
  store.commit({ type: "task_split", taskId: "T-1", groups: [
    { title: "one", checkpointIds: ["CP-1"] },
    { title: "nine", checkpointIds: Array.from({ length: 9 }, (_, i) => `CP-${i + 2}`) },
  ] });
  assert.equal(metrics(store.state, "T-1").progress, 0.1);
});

test("task confidence uses effort weights with a minimum weight of one", () => {
  const { store } = setup();
  for (let i = 0; i < 10; i++) store.commit(work());
  assert.equal(metrics(store.state).confidence, (10 * 0.95 ** 10 + 1) / 11);
});

test("running leaf locks itself and ancestors while unrelated tasks remain available", () => {
  const { store } = setup();
  store.commit({ type: "task_split", taskId: "T-1", groups: [{ title: "a", checkpointIds: ["CP-1"] }, { title: "b", checkpointIds: ["CP-2"] }] });
  assert.throws(() => assertUnlocked(store.state, ["T-1"], ["T-2"]), /active work/);
  assert.throws(() => assertUnlocked(store.state, ["T-2"], ["T-2"]));
  assertUnlocked(store.state, ["T-3"], ["T-2"]);
});

test("transition and persistence failures preserve committed state", () => {
  const { store } = setup();
  const before = structuredClone(store.state);
  assert.throws(() => store.commit({ type: "task_created", pageId: "P-1", title: "x", checkpoints: ["a", " "] }));
  assert.deepEqual(store.state, before);
  const failing = new TaskStore(DEFAULT_CONFIG, () => { throw new Error("disk full"); });
  assert.throws(() => failing.commit({ type: "initialized", config: DEFAULT_CONFIG }), /disk full/);
  assert.equal(failing.state.revision, 0);
});

test("branch-local replay restores configuration, audit and IDs", () => {
  const { store, log } = setup();
  const forkPoint = log.length;
  for (let i = 0; i < 55; i++) store.commit(work());
  assert.ok(log.some((entry) => entry.snapshot));
  const restored = TaskStore.restore(log, { ...DEFAULT_CONFIG, decay: 0.8 }, () => {});
  assert.deepEqual(restored.state, store.state);
  const fork = TaskStore.restore(log.slice(0, forkPoint), DEFAULT_CONFIG, () => {});
  assert.equal(fork.state.checkpoints["CP-1"].effort, 0);
  assert.equal(fork.state.config.decay, 0.95);
  assert.throws(() => TaskStore.restore([log[1]], DEFAULT_CONFIG, () => {}), /revision/);
});

test("checkpoint count suggestions are independent from confidence", () => {
  const { store } = setup();
  let notices: string[] = [];
  for (let i = 0; i < 7; i++) notices = store.commit({ type: "checkpoint_added", taskId: "T-1", title: `CP ${i}` }).notices;
  assert.match(notices[0], /exceeding the limit of 8/);
  assert.equal(metrics(store.state).confidence, 1);
});

test("empty leaf awaits checkpoint planning", () => {
  const { store } = setup();
  store.commit({ type: "task_created", pageId: "P-1", title: "待规划", checkpoints: [] });
  assert.equal(metrics(store.state, "T-2").progress, 0);
  assert.throws(() => validateTarget(store.state, "T-2", "CP-1"));
});
