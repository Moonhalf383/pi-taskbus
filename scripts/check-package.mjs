import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(join(tmpdir(), "taskbus-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(args, cwd) {
  return execFileSync(npm, args, {
    cwd, encoding: "utf8", timeout: 120_000,
    // npm publish --dry-run exports its flag to lifecycle children; this check needs a real local tarball.
    env: { ...process.env, npm_config_dry_run: "false", npm_config_audit: "false", npm_config_fund: "false" },
  });
}

try {
  const [packed] = JSON.parse(run(["pack", "--json", "--pack-destination", temp], root));
  const files = packed.files.map((file) => file.path);
  for (const path of ["package.json", "README.md", "LICENSE", "CHANGELOG.md", "taskbus.example.json", "src/index.ts"]) {
    assert.ok(files.includes(path), `Missing published file: ${path}`);
  }
  assert.ok(files.every((path) => path.startsWith("src/") || ["package.json", "README.md", "LICENSE", "CHANGELOG.md", "taskbus.example.json"].includes(path)), "Unexpected file in tarball");

  writeFileSync(join(temp, "package.json"), JSON.stringify({ name: "taskbus-package-smoke", private: true }));
  run(["install", "--ignore-scripts", "--legacy-peer-deps", "--package-lock=false", join(temp, packed.filename)], temp);
  const installed = join(temp, "node_modules", "pi-taskbus");
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(manifest.name, "pi-taskbus");
  assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.ok(readFileSync(join(installed, "CHANGELOG.md"), "utf8").includes(`## [${manifest.version}]`));
  for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
    assert.equal(manifest.peerDependencies[name], "*");
    assert.equal(manifest.dependencies?.[name], undefined);
  }

  const loader = new DefaultResourceLoader({
    cwd: temp, agentDir: join(temp, "agent"), settingsManager: SettingsManager.inMemory({}),
    additionalExtensionPaths: [installed], noExtensions: true, disabledBuiltinExtensions: ["mcp"],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  const extension = result.extensions.find((item) => item.tools.has("task_manage") && item.tools.has("task_run"));
  assert.ok(extension, "Installed package did not register its task tools");
  assert.ok(extension.commands.has("taskbus"));
  console.log(`Package smoke check passed: ${manifest.name}@${manifest.version}, ${files.length} published files, installed extension loaded through Pi.`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
