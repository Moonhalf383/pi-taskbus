import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { TaskStore, nodeState, executionBlockers, metrics, availableWork, assertMutationSafe, type Dependency, type Envelope } from "../src/model.ts";

function setup() { return new TaskStore(DEFAULT_CONFIG, () => {}); }
function create(s: TaskStore, title = "Task", dependencies: Dependency[] = [], checkpoints = ["one", "two"]) {
  return s.commit({ type: "task_created", pageId: "P-1", title, dependencies, checkpoints }).ids;
}
const ignore = (s: TaskStore, id: string, ignored = true) => s.commit({ type: "ignore_changed", id, ignored, reason: "Reviewed scope" });
const refresh = (s: TaskStore, id: string, outcome?: "keep" | "reopen", dependencies?: Dependency[]) => s.commit({ type: "node_refreshed", id, summary: "Reviewed evidence", outcome, dependencies });
const done = (s: TaskStore, id: string) => s.commit({ type: "checkpoint_completed", id, summary: "Verified" });

test("certainty and completion derive from ignore without losing original choices or evidence", () => {
  const s = setup(); create(s);
  done(s, "CP-1"); ignore(s, "CP-2");
  assert.equal(nodeState(s.state, "T-1").completion, "uncertainly done");
  assert.equal(metrics(s.state).progress, 1);
  assert.equal(metrics(s.state).completed, 1);
  assert.equal(metrics(s.state).ignored, 1);
  ignore(s, "T-1"); assert.equal(nodeState(s.state, "T-1").done, false);
  assert.equal(nodeState(s.state, "CP-1").certainty, "ignored");
  ignore(s, "T-1", false);
  assert.equal(s.state.checkpoints["CP-1"].status, "done");
  assert.equal(nodeState(s.state, "CP-2").certainty, "ignored");
  assert.equal(nodeState(s.state, "CP-1").dirty, true);
  assert.throws(() => refresh(s, "CP-1"), /ancestor/);
  refresh(s, "T-1");
  assert.throws(() => refresh(s, "CP-1"), /outcome/);
  refresh(s, "CP-1", "keep");
  ignore(s, "CP-2", false); refresh(s, "CP-2"); done(s, "CP-2");
  assert.equal(nodeState(s.state, "T-1").completion, "certainly done");
});

test("strict and soft prerequisite invariants reject ignore atomically", () => {
  const s = setup(); create(s); create(s, "strict", [{ id: "T-1", kind: "strict" }]);
  const previous = s.state;
  assert.throws(() => ignore(s, "CP-1"), /Strict prerequisite/);
  assert.equal(s.state, previous);
  s.commit({ type: "dependencies_changed", id: "T-2", dependencies: [{ id: "T-1", kind: "soft" }], reason: "Allow partial scope" });
  ignore(s, "CP-1"); assert.equal(nodeState(s.state, "T-1").certainty, "uncertain");
  assert.throws(() => ignore(s, "CP-2"), /Soft prerequisite/);
  done(s, "CP-2"); refresh(s, "T-2"); refresh(s, "CP-3"); refresh(s, "CP-4");
  assert.ok(availableWork(s.state).some((item) => item.taskId === "T-2"));
});

test("dependencies gate execution, inherit from ancestors, and reject containment cycles", () => {
  const s = setup(); create(s, "upstream"); create(s, "dependent", [{ id: "T-1", kind: "strict" }]);
  s.commit({ type: "task_split", taskId: "T-2", groups: [{ title: "a", checkpointIds: ["CP-3"] }, { title: "b", checkpointIds: ["CP-4"] }] });
  assert.ok(!availableWork(s.state).some((item) => item.taskId === "T-3"));
  done(s, "CP-1"); done(s, "CP-2");
  assert.ok(availableWork(s.state).some((item) => item.taskId === "T-3"));
  assert.throws(() => s.commit({ type: "dependencies_changed", id: "T-2", dependencies: [{ id: "CP-3", kind: "strict" }], reason: "Cycle" }), /cycle/);
  assert.throws(() => s.commit({ type: "dependencies_changed", id: "T-1", dependencies: [{ id: "T-3", kind: "strict" }], reason: "Cycle" }), /cycle/);
});

test("split keeps archived dependency edges, propagates dirty, and refresh repairs atomically", () => {
  const s = setup(); create(s); create(s, "dependent", [{ id: "CP-1", kind: "strict" }]);
  const split = s.commit({ type: "checkpoint_split", id: "CP-1", parts: [{ title: "first" }, { title: "second" }] });
  assert.equal(s.state.tasks["T-2"].dependencies![0].id, "CP-1");
  assert.equal(nodeState(s.state, "T-2").dirty, true);
  assert.throws(() => refresh(s, "T-2"), /Archived/);
  refresh(s, "T-2", undefined, split.ids.map((id) => ({ id, kind: "strict" })));
  assert.equal(nodeState(s.state, "T-2").directDirty, false);
  refresh(s, "CP-3"); refresh(s, "CP-4");
  assert.equal(nodeState(s.state, "T-2").dirty, false);
  assert.ok(!availableWork(s.state).some((item) => item.taskId === "T-2"));
  for (const id of split.ids) done(s, id);
  assert.ok(availableWork(s.state).some((item) => item.taskId === "T-2"));
});

test("aggregate dirty invalidates task dependents while healthy sibling work remains available", () => {
  const s = setup(); create(s); create(s, "upstream", [], ["source"]);
  s.commit({ type: "dependencies_changed", id: "CP-1", dependencies: [{ id: "CP-3", kind: "strict" }], reason: "Add" });
  refresh(s, "CP-1"); done(s, "CP-3"); done(s, "CP-1"); done(s, "CP-2");
  create(s, "consumer", [{ id: "T-1", kind: "strict" }]);
  s.commit({ type: "checkpoint_reopened", id: "CP-3", reason: "Evidence changed" });
  assert.equal(nodeState(s.state, "T-1").dirty, true);
  assert.equal(nodeState(s.state, "T-3").directDirty, true);
  s.commit({ type: "checkpoint_reopened", id: "CP-2", reason: "More work" });
  assert.ok(availableWork(s.state).some((item) => item.checkpointId === "CP-2"));
  refresh(s, "CP-1", "keep"); // Clean but pending predecessors permit review, not execution.
  s.commit({ type: "dependencies_changed", id: "CP-3", dependencies: [], reason: "Review source" });
  assert.throws(() => refresh(s, "CP-1", "keep"), /Refresh prerequisite/);
  refresh(s, "CP-1", "reopen", []);
  assert.equal(nodeState(s.state, "T-1").dirty, false);
});

test("adding work invalidates completed task evidence and active downstream reservations", () => {
  const s = setup(); create(s); done(s, "CP-1"); done(s, "CP-2"); create(s, "consumer", [{ id: "T-1", kind: "strict" }]);
  const change = { type: "checkpoint_added" as const, taskId: "T-1", title: "new work" };
  assert.throws(() => assertMutationSafe(s.state, change, ["T-2"]), /active work/);
  s.commit(change);
  assert.equal(nodeState(s.state, "T-2").dirty, true);
  refresh(s, "T-2");
  assert.ok(!availableWork(s.state).some((item) => item.taskId === "T-2"));
});

test("pages and legacy journal migrate without changing IDs; empty leaves block completion", () => {
  const s = setup();
  assert.throws(() => s.commit({ type: "task_created", title: "missing page", checkpoints: [] }), /pageId/);
  create(s); const page = s.commit({ type: "page_created", title: "Other" }).ids[0];
  const created = s.commit({ type: "task_created", pageId: page, title: "cross-page", dependencies: [{ id: "T-1", kind: "strict" }], checkpoints: ["work"] });
  assert.equal(s.state.pageByTask[created.ids[0]], page);
  const restored = TaskStore.restore(s.history, DEFAULT_CONFIG, () => {});
  assert.deepEqual(restored.state, s.state);
  const legacy: Envelope = { version: 1, revision: 1, timestamp: "legacy", event: { type: "task_created", title: "Old", checkpoints: ["Old CP"] } };
  const migrated = TaskStore.restore([legacy], DEFAULT_CONFIG, () => {});
  assert.equal(migrated.state.pageByTask["T-1"], "P-1");
  s.commit({ type: "task_split", taskId: "T-1", groups: [{ title: "a", checkpointIds: ["CP-1", "CP-2"] }, { title: "empty", checkpointIds: [] }] });
  done(s, "CP-1"); done(s, "CP-2");
  assert.equal(nodeState(s.state, "T-1").done, false);
});

test("dirty assignment propagates transitively across pages and cannot be acknowledged via dirty ancestors", () => {
  const s = setup(); create(s);
  s.commit({ type: "dependencies_changed", id: "CP-1", dependencies: [], reason: "Review evidence" });
  const page = s.commit({ type: "page_created", title: "Cross page" }).ids[0];
  s.commit({ type: "task_created", title: "Consumer", pageId: page, dependencies: [{ id: "T-1", kind: "strict" }], checkpoints: ["dependent"] });
  create(s, "Third", [{ id: "T-2", kind: "strict" }]);
  assert.equal(nodeState(s.state, "T-2").dirty, true);
  assert.equal(nodeState(s.state, "T-3").dirty, true);
  assert.throws(() => refresh(s, "T-2"), /prerequisite/);
  assert.throws(() => refresh(s, "CP-3"), /ancestor/);
  refresh(s, "CP-1"); refresh(s, "T-2"); refresh(s, "CP-3"); refresh(s, "T-3"); refresh(s, "CP-4"); refresh(s, "CP-5");
  assert.equal(nodeState(s.state, "T-3").dirty, false);
});

test("certainly done strict prerequisites and uncertainly done soft prerequisites gate checkpoints", () => {
  const s = setup(); create(s); done(s, "CP-1"); ignore(s, "CP-2");
  assert.throws(() => create(s, "bad", [{ id: "T-1", kind: "strict" }]), /strict prerequisite/);
  const ids = create(s, "allowed", [{ id: "T-1", kind: "soft" }]);
  assert.ok(availableWork(s.state).some((item) => item.taskId === ids[0]));
  assert.throws(() => ignore(s, "T-1"), /Soft prerequisite/);
  assert.throws(() => s.commit({ type: "dependencies_changed", id: ids[0], dependencies: [{ id: "T-1", kind: "soft" }, { id: "T-1", kind: "strict" }], reason: "duplicate" }), /Duplicate/);
});

test("split preserves incoming prerequisites and downstream done requires explicit keep or reopen", () => {
  const s = setup(); create(s, "Source", [], ["source"]); done(s, "CP-1");
  const ids = s.commit({ type: "task_created", pageId: "P-1", title: "Consumer", checkpoints: [{ title: "work", dependencies: [{ id: "CP-1", kind: "strict" }] }] }).ids;
  done(s, ids[1]); s.commit({ type: "checkpoint_reopened", id: "CP-1", reason: "new evidence" });
  assert.equal(nodeState(s.state, ids[1]).dirty, true);
  assert.throws(() => refresh(s, ids[1]), /outcome/);
  refresh(s, ids[1], "reopen");
  const replacements = s.commit({ type: "checkpoint_split", id: ids[1], parts: [{ title: "a" }, { title: "b" }] }).ids;
  for (const id of replacements) assert.deepEqual(s.state.checkpoints[id].dependencies, [{ id: "CP-1", kind: "strict" }]);
  assert.throws(() => s.commit({ type: "task_created", pageId: "P-1", title: "archived", dependencies: [{ id: ids[1], kind: "strict" }], checkpoints: [] }), /Archived/);
  assert.equal(s.state.checkpoints[ids[1]].summary, "Verified");
});

test("unrelated mutations remain allowed while active prerequisite mutations are rejected", () => {
  const s = setup(); create(s); done(s, "CP-1"); done(s, "CP-2"); create(s, "Consumer", [{ id: "T-1", kind: "strict" }]);
  assert.doesNotThrow(() => assertMutationSafe(s.state, { type: "page_created", title: "New" }, ["T-2"]));
  assert.doesNotThrow(() => assertMutationSafe(s.state, { type: "task_created", pageId: "P-1", title: "Independent", checkpoints: ["work"] }, ["T-2"]));
  assert.throws(() => assertMutationSafe(s.state, { type: "checkpoint_reopened", id: "CP-1", reason: "change" }, ["T-2"]), /active work/);
});

test("splitting cannot launder ignored or dirty checkpoint identity", () => {
  const s = setup(); create(s);
  ignore(s, "CP-1");
  const ignoredParts = s.commit({ type: "checkpoint_split", id: "CP-1", parts: [{ title: "a" }, { title: "b" }] }).ids;
  for (const id of ignoredParts) assert.equal(nodeState(s.state, id).certainty, "ignored");
  s.commit({ type: "dependencies_changed", id: "CP-2", dependencies: [], reason: "Needs review" });
  const dirtyParts = s.commit({ type: "checkpoint_split", id: "CP-2", parts: [{ title: "a" }, { title: "b" }] }).ids;
  for (const id of dirtyParts) assert.equal(nodeState(s.state, id).dirty, true);
});

test("active siblings allow unrelated aggregate dirty repair", () => {
  const s = setup(); create(s);
  s.commit({ type: "task_split", taskId: "T-1", groups: [{ title: "Active", checkpointIds: ["CP-1"] }, { title: "Repair", checkpointIds: ["CP-2"] }] });
  s.commit({ type: "dependencies_changed", id: "CP-2", dependencies: [], reason: "Review" });
  assert.equal(nodeState(s.state, "T-1").dirty, true);
  assert.doesNotThrow(() => assertMutationSafe(s.state, { type: "node_refreshed", id: "CP-2", summary: "Reviewed" }, ["T-2"]));
});

test("dirty task refresh cannot bulk-confirm completed descendant evidence", () => {
  const s = setup(); create(s, "Source", [], ["source"]); done(s, "CP-1");
  create(s, "Consumer", [{ id: "CP-1", kind: "strict" }], ["result"]); done(s, "CP-2");
  create(s, "Final", [{ id: "T-2", kind: "strict" }], ["finish"]);
  s.commit({ type: "checkpoint_reopened", id: "CP-1", reason: "Changed" });
  refresh(s, "T-2");
  assert.equal(nodeState(s.state, "T-2").directDirty, false);
  assert.equal(nodeState(s.state, "CP-2").dirty, true);
  assert.equal(nodeState(s.state, "T-2").dirty, true);
  assert.throws(() => refresh(s, "T-3"), /prerequisite/);
  assert.throws(() => refresh(s, "CP-2"), /outcome/);
  refresh(s, "CP-2", "keep"); refresh(s, "T-3"); refresh(s, "CP-3");
  done(s, "CP-1");
  assert.ok(availableWork(s.state).some((item) => item.taskId === "T-3"));
});

test("new dependency arrays are isolated from caller mutations and retained archived edges cannot be copied", () => {
  const s = setup(); create(s);
  const dependencies: Dependency[] = [{ id: "CP-1", kind: "strict" }];
  create(s, "Consumer", dependencies);
  dependencies[0].id = "unknown";
  assert.equal(s.state.tasks["T-2"].dependencies![0].id, "CP-1");
  s.commit({ type: "checkpoint_split", id: "CP-1", parts: [{ title: "a" }, { title: "b" }] });
  const before = s.state;
  assert.throws(() => s.commit({ type: "task_created", pageId: "P-1", title: "Copy", checkpoints: [{ title: "bad", dependencies: [{ id: "CP-1", kind: "strict" }] }] }), /Archived/);
  assert.equal(s.state, before);
});

test("ignored dirty descendants can be explicitly set aside without trapping parent refresh", () => {
  const s = setup(); create(s);
  s.commit({ type: "dependencies_changed", id: "CP-1", dependencies: [], reason: "Review" });
  ignore(s, "CP-1"); done(s, "CP-2");
  assert.equal(nodeState(s.state, "T-1").completion, "uncertainly done");
  assert.equal(nodeState(s.state, "T-1").dirty, false);
  create(s, "Soft consumer", [{ id: "T-1", kind: "soft" }]);
  assert.ok(availableWork(s.state).some((item) => item.taskId === "T-2"));
});

test("keep acknowledgment with pending upstream cannot prematurely unblock downstream evidence", () => {
  const s = setup(); create(s, "Source", [], ["source"]); done(s, "CP-1");
  create(s, "Middle", [], ["result"]);
  s.commit({ type: "dependencies_changed", id: "CP-2", dependencies: [{ id: "CP-1", kind: "strict" }], reason: "Link" });
  refresh(s, "CP-2"); done(s, "CP-2"); create(s, "Final", [{ id: "T-2", kind: "strict" }]);
  s.commit({ type: "checkpoint_reopened", id: "CP-1", reason: "New evidence" });
  refresh(s, "CP-2", "keep"); refresh(s, "T-3"); refresh(s, "CP-3"); refresh(s, "CP-4");
  assert.ok(!availableWork(s.state).some((item) => item.taskId === "T-3"));
  done(s, "CP-1");
  assert.ok(availableWork(s.state).some((item) => item.taskId === "T-3"));
});

test("task refresh with changed prerequisites still reviews each completed descendant", () => {
  const s = setup(); create(s, "Source", [], ["source"]); done(s, "CP-1");
  create(s, "Consumer", [], ["result"]); done(s, "CP-2");
  refresh(s, "T-2", undefined, [{ id: "CP-1", kind: "strict" }]);
  assert.equal(nodeState(s.state, "T-2").directDirty, false);
  assert.equal(nodeState(s.state, "CP-2").dirty, true);
  assert.throws(() => refresh(s, "CP-2"), /outcome/);
  refresh(s, "CP-2", "keep");
  assert.equal(nodeState(s.state, "T-2").dirty, false);
});


test("layered diamond prerequisites are checked once per node rather than once per path", () => {
  const s = setup(); create(s, "Diamond", [], Array.from({ length: 42 }, (_, i) => `step ${i}`));
  let visits = 0;
  for (let i = 1; i <= 42; i++) {
    const cp = s.state.checkpoints[`CP-${i}`];
    if (i < 42) cp.status = "done";
    const deps: Dependency[] = i > 2 ? [{ id: `CP-${i - 1}`, kind: "strict" }, { id: `CP-${i - 2}`, kind: "strict" }] : [];
    Object.defineProperty(cp, "dependencies", { get() { visits++; return deps; }, configurable: true });
  }
  assert.deepEqual(executionBlockers(s.state, "CP-42"), []);
  assert.ok(visits < 200, `Expected bounded graph traversal, got ${visits} dependency reads`);
  s.state.checkpoints["CP-1"].status = "pending";
  assert.match(executionBlockers(s.state, "CP-42").join(" "), /CP-1 is pending/);
});
