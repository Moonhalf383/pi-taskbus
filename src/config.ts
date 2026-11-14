import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ConfidenceThreshold {
  id: string;
  below: number;
  color: "warning" | "error";
  prompt: string;
}
export interface TaskbusConfig {
  decay: number;
  checkpointLimit: number;
  reminderEvery: number;
  thresholds: ConfidenceThreshold[];
}

export const DEFAULT_CONFIG: TaskbusConfig = {
  decay: 0.95,
  checkpointLimit: 8,
  reminderEvery: 5,
  thresholds: [
    {
      id: "review",
      below: 0.6,
      color: "warning",
      prompt: "{checkpointId} ({title}) has granularity confidence {confidence} after {effort} work calls. Check for hidden work and consider splitting this checkpoint.",
    },
    {
      id: "split",
      below: 0.3,
      color: "error",
      prompt: "Strongly consider splitting {checkpointId} ({title}): granularity confidence is {confidence} after {effort} work calls. Identify hidden work and refine tracking with task_manage checkpoint_split.",
    },
  ],
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function validateConfig(value: unknown): TaskbusConfig {
  if (!object(value)) throw new Error("Taskbus configuration must be an object");
  const keys = ["decay", "checkpointLimit", "reminderEvery", "thresholds"];
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown configuration option: ${key}`);
  if (typeof value.decay !== "number" || !Number.isFinite(value.decay) || value.decay <= 0 || value.decay >= 1) {
    throw new Error("decay must be greater than 0 and less than 1");
  }
  for (const key of ["checkpointLimit", "reminderEvery"] as const) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 1) throw new Error(`${key} must be a positive integer`);
  }
  if (!Array.isArray(value.thresholds)) throw new Error("thresholds must be an array");
  const ids = new Set<string>();
  const cutoffs = new Set<number>();
  for (const threshold of value.thresholds) {
    if (!object(threshold) || typeof threshold.id !== "string" || !/^[a-zA-Z][\w-]*$/.test(threshold.id)) {
      throw new Error("Threshold id must be a unique identifier starting with a letter");
    }
    if (ids.has(threshold.id)) throw new Error(`Duplicate threshold id: ${threshold.id}`);
    ids.add(threshold.id);
    if (typeof threshold.below !== "number" || !Number.isFinite(threshold.below) || threshold.below <= 0 || threshold.below >= 1 || cutoffs.has(threshold.below)) {
      throw new Error("Threshold below values must be unique and between 0 and 1");
    }
    cutoffs.add(threshold.below);
    if (threshold.color !== "warning" && threshold.color !== "error") throw new Error("Threshold color must be warning or error");
    if (typeof threshold.prompt !== "string" || !threshold.prompt.trim()) throw new Error("Threshold prompt must contain text");
  }
  const config = structuredClone(value) as unknown as TaskbusConfig;
  config.thresholds.sort((a, b) => b.below - a.below);
  return config;
}

export function mergeConfig(base: TaskbusConfig, override: unknown): TaskbusConfig {
  if (!object(override)) throw new Error("Taskbus configuration must be an object");
  return validateConfig({ ...base, ...override });
}

/** Project thresholds replace the array; scalar options inherit. */
export function loadConfig(agentDir: string, cwd: string, configDir: string, trusted: boolean): TaskbusConfig {
  let config = structuredClone(DEFAULT_CONFIG);
  const paths = [join(agentDir, "taskbus.json")];
  if (trusted) paths.push(join(cwd, configDir, "taskbus.json"));
  for (const path of paths) {
    let text: string;
    try { text = readFileSync(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try { config = mergeConfig(config, JSON.parse(text)); }
    catch (error) { throw new Error(`${path}: ${(error as Error).message}`); }
  }
  return config;
}

export function confidenceColor(value: number, config: TaskbusConfig): "success" | "warning" | "error" {
  let color: "success" | "warning" | "error" = "success";
  for (const threshold of config.thresholds) if (value < threshold.below) color = threshold.color;
  return color;
}

export function renderPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}
