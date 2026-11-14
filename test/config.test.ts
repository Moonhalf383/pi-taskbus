import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, confidenceColor, loadConfig, mergeConfig, renderPrompt } from "../src/config.ts";

test("global and trusted project config inherit scalars and replace thresholds", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskbus-config-"));
  try {
    const agent = join(dir, "agent"), cwd = join(dir, "project");
    mkdirSync(agent); mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(agent, "taskbus.json"), JSON.stringify({ decay: 0.9, reminderEvery: 7 }));
    writeFileSync(join(cwd, ".pi", "taskbus.json"), JSON.stringify({ decay: 0.85, thresholds: [{ id: "custom", below: 0.5, color: "warning", prompt: "拆分 {checkpointId}" }] }));
    const config = loadConfig(agent, cwd, ".pi", true);
    assert.equal(config.decay, 0.85);
    assert.equal(config.reminderEvery, 7);
    assert.equal(config.thresholds.length, 1);
    assert.equal(loadConfig(agent, cwd, ".pi", false).decay, 0.9);
    writeFileSync(join(cwd, ".pi", "taskbus.json"), "{");
    assert.throws(() => loadConfig(agent, cwd, ".pi", true), /taskbus.json/);
  } finally { rmSync(dir, { recursive: true }); }
});

test("configuration validates decay, thresholds and prompts", () => {
  for (const decay of [0, 1, -1, NaN, Infinity]) assert.throws(() => mergeConfig(DEFAULT_CONFIG, { decay }));
  assert.throws(() => mergeConfig(DEFAULT_CONFIG, { checkpointLimit: 0 }));
  assert.throws(() => mergeConfig(DEFAULT_CONFIG, { spellingMistake: 1 }));
  assert.throws(() => mergeConfig(DEFAULT_CONFIG, { thresholds: [DEFAULT_CONFIG.thresholds[0], DEFAULT_CONFIG.thresholds[0]] }));
  assert.equal(confidenceColor(0.8, DEFAULT_CONFIG), "success");
  assert.equal(confidenceColor(0.5, DEFAULT_CONFIG), "warning");
  assert.equal(confidenceColor(0.2, DEFAULT_CONFIG), "error");
  assert.equal(renderPrompt("{checkpointId} {confidence} {unknown}", { checkpointId: "CP-1", confidence: "50%" }), "CP-1 50% {unknown}");
});
