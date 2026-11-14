import {
  createBashToolDefinition, createEditToolDefinition, createFindToolDefinition,
  createGrepToolDefinition, createLsToolDefinition, createPowerShellToolDefinition,
  createReadToolDefinition, createWriteToolDefinition,
  type ToolRenderers, type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { safeText } from "./view.ts";

type RenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type RenderTheme = Parameters<NonNullable<ToolRenderers["renderCall"]>>[1];
interface DelegateState {
  tool: string;
  state: Record<string, unknown>;
  call?: Component;
  result?: Component;
  card?: Box;
  notices?: Component;
}
interface RunArgs { taskId?: string; checkpointId?: string; tool?: string; args?: Record<string, unknown> }

/** Host-provided factories expose the same renderers used by native built-in tool rows. */
export function createRunRenderers(): ToolRenderers {
  const cache = new Map<string, Map<string, ToolRenderers>>();
  function resolve(name: string, cwd: string): ToolRenderers | undefined {
    let renderers = cache.get(cwd);
    if (!renderers) {
      renderers = new Map([
        createReadToolDefinition(cwd), createBashToolDefinition(cwd), createEditToolDefinition(cwd),
        createWriteToolDefinition(cwd), createGrepToolDefinition(cwd), createFindToolDefinition(cwd),
        createLsToolDefinition(cwd), createPowerShellToolDefinition(cwd),
      ].map((definition) => [definition.name, definition as ToolRenderers]));
      cache.set(cwd, renderers);
    }
    return renderers.get(name);
  }
  function delegate(context: RenderContext, args: RunArgs, slot: "call" | "result"): RenderContext {
    let child = context.state.taskbusDelegate as DelegateState | undefined;
    if (!child || child.tool !== args.tool) {
      child = { tool: args.tool ?? "", state: {} };
      context.state.taskbusDelegate = child;
    }
    return { ...context, args: args.args ?? {}, state: child.state, lastComponent: child[slot] };
  }
  function card(theme: RenderTheme, context: RenderContext): Box {
    const state = context.state.taskbusDelegate as DelegateState;
    const bg = (line: string) => theme.bg(context.isError ? "toolErrorBg" : context.isPartial || !context.executionStarted || context.durationMs === undefined ? "toolPendingBg" : "toolSuccessBg", line);
    const box = state.card ??= new Box(context.outputPad, 1, bg);
    box.setPaddingX(context.outputPad);
    box.setBgFn(bg);
    box.clear();
    if (state.call) box.addChild(state.call);
    if (state.result) box.addChild(state.result);
    if (state.notices) box.addChild(state.notices);
    return box;
  }
  return {
    renderShell: "self",
    renderCall(raw, theme, context) {
      const args = raw as RunArgs;
      const renderers = resolve(args.tool ?? "", context.cwd);
      const childContext = delegate(context, args, "call");
      const child = renderers?.renderCall?.(args.args ?? {}, theme, childContext)
        ?? new Text(theme.fg("toolTitle", `${safeText(args.tool ?? "work tool")} ${safeText(String(args.args?.path ?? args.args?.command ?? ""))}`), 0, 0);
      (context.state.taskbusDelegate as DelegateState).call = child;
      const container = new Container();
      container.addChild(new Text(theme.fg("muted", `Taskbus ${safeText(args.taskId ?? "")}/${safeText(args.checkpointId ?? "")}`), context.outputPad, 0));
      container.addChild(renderers?.renderShell === "self" ? child : card(theme, context));
      return container;
    },
    renderResult(result, options, theme, context) {
      const args = context.args as RunArgs;
      const renderers = resolve(args.tool ?? "", context.cwd);
      const childContext = delegate(context, args, "result");
      const packet = result.details as { original?: unknown; taskbus?: { notices?: string[] } } | undefined;
      const wrapped = packet && Object.hasOwn(packet, "original") && packet.taskbus;
      const notices = wrapped ? packet.taskbus?.notices ?? [] : [];
      const original: AgentToolResult<unknown> = wrapped ? {
        ...result, details: packet.original,
        content: result.content.filter((item) => !(item.type === "text" && notices.length && item.text === `\n[Taskbus]\n${notices.join("\n")}`)),
      } : result;
      const fallbackText = new Text(original.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"), 0, 0);
      const fallback: Component = {
        invalidate: () => fallbackText.invalidate(),
        render(width) {
          const lines = fallbackText.render(width);
          if (options.expanded || lines.length <= 8) return lines;
          return [...lines.slice(0, 8), truncateToWidth(theme.fg("muted", `… (${lines.length - 8} more lines; ${context.keyHint("app.tools.expand", "expand")} )`), width)];
        },
      };
      const child = renderers?.renderResult?.(original, options, theme, childContext) ?? fallback;
      (context.state.taskbusDelegate as DelegateState).result = child;
      const state = context.state.taskbusDelegate as DelegateState;
      state.notices = notices.length ? new Text(theme.fg("warning", notices.map(safeText).join("\n")), 0, 0) : undefined;
      const container = new Container();
      if (renderers?.renderShell === "self") {
        container.addChild(child);
        if (state.notices) container.addChild(state.notices);
      } else {
        // One shared card owns call + result and a single pair of vertical padding rows.
        card(theme, context);
      }
      return container;
    },
  };
}
