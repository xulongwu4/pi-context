import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { analyze, type Row, rowsOf, type ViewData } from "./analyze.ts";
import { applyAffixes, loadConfig, saveConfig } from "./config.ts";
import { fmtTokens } from "./format.ts";
import { ContextOverlay } from "./overlay.ts";
import { report } from "./report.ts";

const MAX_SNAPSHOTS = 200;

export default function (pi: ExtensionAPI) {
	const configPath = join(getAgentDir(), "pi-context.json");
	/** Composition and duration of each request, keyed by the assistant message timestamp. */
	const snapshots = new Map<number, { rows: Row[]; ms: number }>();
	/** Top-level tool calls now running, and when the first of them started. */
	const runningTools = new Set<string>();
	let toolsStart = 0;
	let timing = { activeMs: 0, modelMs: 0, toolMs: 0 };
	let pendingRows: Row[] = [];
	let requestStart = 0;
	let agentStart = 0;

	/** Adds the system prompt and tool schemas when the messages do not carry them. */
	function complete(rows: Row[], ctx: ExtensionContext): Row[] {
		const hasSystem = rows.some((row) => row.cat === "system");
		const hasTools = rows.some((row) => row.cat === "tools");
		if (hasSystem && hasTools) return rows;
		const active = new Set(pi.getActiveTools());
		const toolsAdded = hasTools
			? []
			: pi
					.getAllTools()
					.filter((tool) => active.has(tool.name))
					.map(({ name, description, parameters }) => ({ name, description, parameters }));
		return [...rowsOf([{ role: "system", content: hasSystem ? "" : ctx.getSystemPrompt(), toolsAdded }]), ...rows];
	}

	function collect(ctx: ExtensionContext): ViewData {
		const analysis = analyze(ctx.sessionManager.getBranch());
		for (const request of analysis.requests) Object.assign(request, snapshots.get(request.time));
		return {
			analysis,
			current: complete(rowsOf(ctx.sessionManager.buildSessionProjection().messages), ctx),
			usage: ctx.getContextUsage(),
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			timing: { ...timing, activeMs: timing.activeMs + (agentStart ? Date.now() - agentStart : 0) },
		};
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const usage = ctx.getContextUsage();
		if (usage?.percent == null) {
			ctx.ui.setStatus("pi-context", undefined);
			return;
		}
		const text = `ctx ${Math.round(usage.percent)}% ${fmtTokens(usage.tokens)}/${fmtTokens(usage.contextWindow)}`;
		ctx.ui.setStatus("pi-context", ctx.ui.theme.fg(usage.percent >= 80 ? "warning" : "dim", text));
	}

	pi.on("session_start", (_event, ctx) => {
		snapshots.clear();
		runningTools.clear();
		timing = { activeMs: 0, modelMs: 0, toolMs: 0 };
		requestStart = 0;
		agentStart = 0;
		updateStatus(ctx);
	});

	pi.on("before_agent_start", (event) => {
		const systemPrompt = applyAffixes(event.systemPrompt, loadConfig(configPath));
		if (systemPrompt !== event.systemPrompt) return { systemPrompt };
	});

	pi.on("agent_start", () => {
		agentStart = Date.now();
	});

	pi.on("agent_end", (_event, ctx) => {
		if (agentStart) timing.activeMs += Date.now() - agentStart;
		agentStart = 0;
		updateStatus(ctx);
	});

	pi.on("context_with_system", (event, ctx) => {
		pendingRows = complete(rowsOf(event.messages), ctx);
	});

	pi.on("before_provider_request", () => {
		requestStart = Date.now();
	});

	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant" || !requestStart) return;
		const ms = Date.now() - requestStart;
		requestStart = 0;
		timing.modelMs += ms;
		snapshots.set(message.timestamp, { rows: pendingRows, ms });
		if (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value as number);
	});

	pi.on("tool_execution_start", (event) => {
		if (event.parentToolCallId) return;
		if (runningTools.size === 0) toolsStart = Date.now();
		runningTools.add(event.toolCallId);
	});

	// Parallel tool calls count once: tool time is the wall time with at least one tool running.
	pi.on("tool_execution_end", (event) => {
		if (!runningTools.delete(event.toolCallId)) return;
		if (runningTools.size === 0) timing.toolMs += Date.now() - toolsStart;
	});

	pi.on("turn_end", (_event, ctx) => updateStatus(ctx));
	pi.on("session_compact", (_event, ctx) => updateStatus(ctx));
	pi.on("model_select", (_event, ctx) => updateStatus(ctx));

	pi.registerCommand("context", {
		description: "Show context insights. Subcommands: prefix [text], suffix [text] set the system prompt prefix/suffix",
		handler: async (args, ctx) => {
			const affix = /^(prefix|suffix)\b\s*([\s\S]*)$/.exec(args.trim());
			if (affix) {
				const key = affix[1] === "prefix" ? "systemPromptPrefix" : "systemPromptSuffix";
				const config = loadConfig(configPath);
				const text = affix[2] || (await ctx.ui.editor(`System prompt ${affix[1]} (empty = disabled)`, config[key] ?? ""));
				if (text === undefined) return;
				config[key] = text.trim() || undefined;
				saveConfig(configPath, config);
				ctx.ui.notify(
					config[key] ? `System prompt ${affix[1]} saved. It applies from the next turn.` : `System prompt ${affix[1]} disabled.`,
					"info",
				);
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify(report(collect(ctx)), "info");
				return;
			}
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => new ContextOverlay(tui, theme, collect(ctx), () => collect(ctx), () => done()),
				{ overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%" } },
			);
		},
	});

	pi.registerTool({
		name: "context_insight",
		label: "Context Insight",
		description:
			"Report your own context window: provider-reported usage and session totals, the estimated composition by category (system prompt, tool schemas, user messages, injected context, skills, tool calls, tool results, reasoning, answers), and the largest items.",
		promptSnippet: "Report context window usage and what it is composed of",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return { content: [{ type: "text", text: report(collect(ctx)) }], details: {} };
		},
	});
}
