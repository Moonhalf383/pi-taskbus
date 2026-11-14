import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { percent, safeText } from "./view.ts";

type ManageArgs = { action?: string; id?: string; taskId?: string; checkpointId?: string; title?: string };
type Metrics = { completed: number; total: number; progress: number; confidence: number };
interface ResultDetails { ids?: string[]; notices?: string[]; metrics?: Metrics; tasks?: unknown[] }
const labels: Record<string, string> = {
  list: "Task tree", history: "Task history", tools: "Available tools", task_create: "Created task",
  checkpoint_add: "Added checkpoint", rename: "Renamed", complete: "Completed checkpoint",
  reopen: "Reopened checkpoint", checkpoint_split: "Split checkpoint", task_split: "Split task",
};

/** Compact result-first rendering follows the installed task-panel's summary style. */
export function createManageRenderers(): ToolRenderers {
  return {
    renderShell: "self",
    renderCall(_args, _theme, context) {
      const args = context.args as ManageArgs;
      // Show the action while running; the result replaces this heading once available.
      const component = new Container();
      context.state.manageHeading = component;
      component.addChild(new Text(`◌ ${labels[args.action ?? ""] ?? "Task management"}`, 0, 0));
      return component;
    },
    renderResult(result, options, theme, context) {
      (context.state.manageHeading as Container | undefined)?.clear();
      const args = context.args as ManageArgs;
      const details = result.details as ResultDetails | unknown[] | undefined;
      const packet = details && !Array.isArray(details) ? details : undefined;
      const target = args.checkpointId ?? args.taskId ?? args.id;
      const ids = packet?.ids?.join(", ");
      const count = Array.isArray(details) ? details.length : packet?.tasks?.length;
      let summary = `${labels[args.action ?? ""] ?? "Task management"}${target ? ` ${target}` : ""}`;
      if (ids) summary += ` → ${ids}`;
      if (args.title) summary += ` · ${safeText(args.title)}`;
      if (count !== undefined) summary += ` · ${count} items`;
      if (packet?.metrics) {
        const stat = packet.metrics;
        summary += ` · ${stat.completed}/${stat.total} ${percent(stat.progress)} · C:${percent(stat.confidence)}`;
      }
      const container = new Container();
      const failed = context.isError || result.isError;
      container.addChild(new Text(theme.fg(failed ? "error" : args.action === "complete" ? "success" : "accent", `${failed ? "✗" : args.action === "complete" ? "✓" : "●"} ${summary}`), 0, 0));
      for (const notice of packet?.notices ?? []) container.addChild(new Text(theme.fg("warning", safeText(notice)), 0, 0));
      const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
      if (failed || options.expanded) container.addChild(new Text(text, 0, 0));
      else if (["list", "history", "tools"].includes(args.action ?? "")) {
        const hint = context.keyHint("app.tools.expand", "show details");
        if (hint) container.addChild(new Text(theme.fg("dim", hint), 0, 0));
      }
      // Keep collapsed mutation summaries on one line, without raw JSON or large background boxes.
      const component: Component = {
        invalidate: () => container.invalidate(),
        render(width) { return container.render(width).map((line) => truncateToWidth(line, width)); },
      };
      return component;
    },
  };
}
