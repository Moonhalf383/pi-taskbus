import { test } from "node:test";
import assert from "node:assert/strict";
import { Attribution } from "../src/attribution.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { TaskStore } from "../src/model.ts";

function setup() {
  const store = new TaskStore(DEFAULT_CONFIG, () => {});
  store.commit({ type: "task_created", title: "A", checkpoints: ["a", "b"] });
  const guard = new Attribution(new Set(["task_manage"]));
  guard.begin("root", { taskId: "T-1", checkpointId: "CP-1" }, store.state);
  return { state: store.state, guard };
}

test("direct work requires a gateway; management is directly reachable", () => {
  const { state, guard } = setup();
  assert.match(guard.gate({ toolName: "read", toolCallId: "direct" }, state)!, /task_run/);
  assert.equal(guard.gate({ toolName: "task_manage", toolCallId: "manage" }, state), undefined);
  assert.match(guard.gate({ toolName: "task_manage", toolCallId: "nested", parentToolCallId: "root" }, state)!, /directly/);
  assert.match(guard.gate({ toolName: "bash", toolCallId: "unknown", parentToolCallId: "other" }, state)!, /no valid/);
});

test("successful and executed-error leaf tools each consume a unit", () => {
  const { state, guard } = setup();
  guard.gate({ toolName: "read", toolCallId: "r", parentToolCallId: "root" }, state);
  guard.executed("r");
  const record = guard.end("r", false, 12)!;
  assert.equal(record.units, 1);
  assert.equal(record.checkpointId, "CP-1");
  guard.gate({ toolName: "bash", toolCallId: "b", parentToolCallId: "root" }, state);
  assert.equal(guard.end("b", true, 5)!.units, 1);
  assert.equal(guard.finish("root").records.length, 2);
  assert.deepEqual(guard.activeTasks(), []);
});

test("blocked and pre-execution-aborted calls consume zero units", () => {
  const { state, guard } = setup();
  guard.gate({ toolName: "bash", toolCallId: "blocked", parentToolCallId: "root" }, state);
  assert.equal(guard.end("blocked", true), undefined);
  assert.deepEqual(guard.finish("root").records, []);
});

test("nested execution counts actual leaf tools and retains wrapper audit", () => {
  const { state, guard } = setup();
  guard.gate({ toolName: "codemode", toolCallId: "code", parentToolCallId: "root" }, state);
  guard.gate({ toolName: "read", toolCallId: "read", parentToolCallId: "code" }, state);
  guard.executed("read");
  assert.equal(guard.end("read", false, 3)!.units, 1);
  guard.executed("code");
  assert.equal(guard.end("code", false, 4)!.units, 0);
  const audit = guard.finish("root");
  assert.equal(audit.records.reduce((sum, item) => sum + item.units, 0), 1);
});

test("wrapper with only blocked children is itself the executed leaf", () => {
  const { state, guard } = setup();
  guard.gate({ toolName: "wrapper", toolCallId: "w", parentToolCallId: "root" }, state);
  guard.gate({ toolName: "read", toolCallId: "r", parentToolCallId: "w" }, state);
  guard.end("r", true);
  guard.executed("w");
  assert.equal(guard.end("w", false, 1)!.units, 1);
});

test("concurrent gateways isolate checkpoint bindings and notices", () => {
  const { state, guard } = setup();
  guard.begin("second", { taskId: "T-1", checkpointId: "CP-2" }, state);
  guard.gate({ toolName: "read", toolCallId: "first-read", parentToolCallId: "root" }, state);
  guard.gate({ toolName: "read", toolCallId: "second-read", parentToolCallId: "second" }, state);
  assert.equal(guard.end("second-read", false, 1)!.checkpointId, "CP-2");
  guard.notify("second-read", ["提醒 2"]);
  assert.equal(guard.end("first-read", false, 1)!.checkpointId, "CP-1");
  assert.deepEqual(guard.finish("root").notices, []);
  assert.deepEqual(guard.finish("second").notices, ["提醒 2"]);
});
