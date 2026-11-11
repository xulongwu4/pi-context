import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	buildSessionProjection,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type AgentRec,
	type Analysis,
	analyze,
	CATEGORIES,
	type Category,
	declaredTools,
	estimate,
	fileOp,
	LABELS,
	recordedDeclarations,
	type Row,
	rowsOf,
	scaleOf,
	schemasOf,
	sumByCategory,
	sumTokens,
	TURN_ENTRY,
	type TurnData,
	type ViewData,
} from "./analyze.ts";
import { applyAffixes, DEFAULT_WARN_PERCENT, loadConfig, saveConfig } from "./config.ts";
import { exportMarkdown } from "./export.ts";
import { fmtPercent, fmtTokens } from "./format.ts";
import { hintsOf } from "./hints.ts";
import { aggregate, parseEntries, type SessionSummary, scan, summarize } from "./insights.ts";
import { ContextOverlay, type OverlayHost, type Setting, type SettingRequest, type Tab } from "./overlay.ts";
import { report, SECTIONS } from "./report.ts";

const MAX_SNAPSHOTS = 200;
const INSIGHTS_DAYS = 30;
const DAY = 86_400_000;

type AgentUsage = Pick<AgentRec, "requests" | "tokens" | "cost">;

export default function (pi: ExtensionAPI) {
	const configPath = join(getAgentDir(), "pi-context.json");
	const cachePath = join(getAgentDir(), "pi-context-cache.json");
	/** Composition of each request made in this run, keyed by the assistant message timestamp. */
	const snapshots = new Map<number, Row[]>();
	/** Top-level tool calls now running, and when the first of them started. */
	const runningTools = new Set<string>();
	let toolsStart = 0;
	let pendingMessages: any[] = [];
	let pendingRows: Row[] = [];
	let requestStart = 0;
	/** Tool declarations of the last request, by name with their size. Undefined until one is known. */
	let declared: Record<string, number> | undefined;
	/** The declarations last written to the session, as JSON. */
	let savedDeclared = "";
	/** Active tools whose declarations requests leave out. Used until the declarations of a request are known. */
	let hidden: string[] = [];
	// The turn in progress. It is written to the session when the turn ends.
	let turnStart = 0;
	let turnToolMs = 0;
	let turnPaths: Record<string, string> = {};
	let turnRequest: { time: number; ms: number; sums: Record<Category, number> } | undefined;
	let running = false;
	let warned = false;
	/** Subagents seen through pi-subagents events in this run. */
	const liveAgents = new Map<string, AgentRec>();
	const fileUsageCache = new Map<string, { mtimeMs: number; usage: AgentUsage }>();
	let unsubscribe: (() => void)[] = [];

	/** Rows of the messages, with the system prompt and tool schemas added when the messages do not carry them. */
	function rowsFor(messages: any[], ctx: ExtensionContext, full = false): Row[] {
		const rows = rowsOf(messages, declared, hidden, full);
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
		const head = { role: "system", content: hasSystem ? "" : ctx.getSystemPrompt(), toolsAdded };
		return [...rowsOf([head], hasTools ? {} : declared, hidden, full), ...rows];
	}

	const currentRows = (ctx: ExtensionContext) => rowsFor(ctx.sessionManager.buildSessionProjection().messages, ctx);

	/** Names of the tools declared to the model now. */
	function declaredNames(messages: any[]): string[] {
		const schemas = schemasOf(messages, declared, hidden);
		// A session without a recorded system message says nothing about tools; the active ones are declared.
		return schemas.size > 0 ? [...schemas.keys()] : pi.getActiveTools().filter((name) => !hidden.includes(name));
	}

	/** Requests, tokens and cost of a finished subagent, read from its saved session. */
	function fileUsage(file: string | undefined): AgentUsage {
		if (!file) return {};
		try {
			const mtimeMs = statSync(file).mtimeMs;
			const hit = fileUsageCache.get(file);
			if (hit?.mtimeMs === mtimeMs) return hit.usage;
			const { requests, tokens, cost } = summarize(parseEntries(readFileSync(file, "utf8")));
			fileUsageCache.set(file, { mtimeMs, usage: { requests, tokens, cost } });
			return { requests, tokens, cost };
		} catch {
			return {};
		}
	}

	/** Saved records and live state of the subagents, newest first, each followed by the agents it started. */
	function agentsOf(analysis: Analysis): AgentRec[] {
		const merged = new Map<string, AgentRec>();
		for (const saved of analysis.agents) {
			const live = liveAgents.get(saved.id);
			// A resumed agent runs again after its record was saved.
			const rec: AgentRec = live && !live.completedAt ? { ...saved, ...live } : { ...live, ...saved };
			merged.set(saved.id, rec.requests == null ? { ...rec, ...fileUsage(rec.sessionFile) } : rec);
		}
		for (const live of liveAgents.values()) if (!merged.has(live.id)) merged.set(live.id, live);
		const all = [...merged.values()];
		const family = (agent: AgentRec): AgentRec[] => [agent, ...all.filter((child) => child.parent === agent.id).flatMap(family)];
		return all
			.filter((agent) => !agent.parent || !merged.has(agent.parent))
			.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
			.flatMap(family);
	}

	function collect(ctx: ExtensionContext): ViewData {
		const analysis = analyze(ctx.sessionManager.getBranch());
		for (const request of analysis.requests) request.rows = snapshots.get(request.time);
		// A skill read by a nested call leaves no result in the session; use the size of its file.
		for (const skill of analysis.skills) {
			if (skill.tokens) continue;
			try {
				skill.tokens = estimate(statSync(skill.path).size);
			} catch {
				// The file is gone; the size stays unknown.
			}
		}
		const messages = ctx.sessionManager.buildSessionProjection().messages;
		const current = rowsFor(messages, ctx, true);
		const usage = ctx.getContextUsage();
		return {
			analysis,
			current,
			usage,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			declared: declaredNames(messages),
			factor: scaleOf(sumTokens(current), usage?.tokens),
			hints: hintsOf(messages),
			config: loadConfig(configPath),
			agents: agentsOf(analysis),
			running,
			parentSession: ctx.sessionManager.getHeader()?.parentSession,
			reconstruct: (request) =>
				request.parentId ? rowsFor(buildSessionProjection(ctx.sessionManager.getEntries(), request.parentId).messages, ctx, true) : [],
		};
	}

	/** Summaries of the sessions of all projects that changed in the last `days` days. */
	function loadSummaries(ctx: ExtensionContext, days: number, onProgress?: (done: number, total: number) => void): Promise<SessionSummary[]> {
		const dir = ctx.sessionManager.getSessionDir();
		const root = dir ? dirname(dir) : join(getAgentDir(), "sessions");
		return scan(root, cachePath, Date.now() - days * DAY, onProgress);
	}

	/** Sets the system prompt prefix or suffix. Without `text`, the user edits it. Empty text disables it. */
	async function setAffix(ctx: ExtensionCommandContext, sub: "prefix" | "suffix", text?: string): Promise<void> {
		const key = sub === "prefix" ? "systemPromptPrefix" : "systemPromptSuffix";
		const config = loadConfig(configPath);
		text ??= await ctx.ui.editor(`System prompt ${sub} (empty = disabled)`, config[key] ?? "");
		if (text === undefined) return;
		config[key] = text.trim() || undefined;
		saveConfig(configPath, config);
		ctx.ui.notify(config[key] ? `System prompt ${sub} saved. It applies from the next turn.` : `System prompt ${sub} disabled.`, "info");
	}

	/** Sets the context warning. Without `value`, the default applies again. */
	function setWarn(ctx: ExtensionContext, value?: string): void {
		const percent = value === undefined ? undefined : Number(value);
		if (percent !== undefined && !(value?.trim() && percent >= 0 && percent <= 100)) {
			ctx.ui.notify("Give a percentage from 0 to 100. 0 disables the warning.", "error");
			return;
		}
		const config = loadConfig(configPath);
		config.warnPercent = percent;
		saveConfig(configPath, config);
		ctx.ui.notify(percent === 0 ? "Context warning disabled." : `Context warning set to ${percent ?? DEFAULT_WARN_PERCENT}%.`, "info");
		warned = false;
		updateStatus(ctx);
	}

	/** Makes the change the user asked for in the Settings tab. */
	async function changeSetting(ctx: ExtensionCommandContext, { setting, clear }: SettingRequest): Promise<void> {
		if (setting !== "warn") return setAffix(ctx, setting, clear ? "" : undefined);
		const current = loadConfig(configPath).warnPercent ?? DEFAULT_WARN_PERCENT;
		const value = clear ? undefined : await ctx.ui.input("Context warning, in percent of the window (0 = disabled)", String(current));
		if (clear || value !== undefined) setWarn(ctx, value);
	}

	/** Updates the footer, and warns once each time context use rises to the configured percentage. */
	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const usage = ctx.getContextUsage();
		if (usage?.percent == null) {
			ctx.ui.setStatus("pi-context", undefined);
			return;
		}
		const limit = loadConfig(configPath).warnPercent ?? DEFAULT_WARN_PERCENT;
		const over = limit > 0 && usage.percent >= limit;
		const size = `${Math.round(usage.percent)}% ${fmtTokens(usage.tokens)}/${fmtTokens(usage.contextWindow)}`;
		ctx.ui.setStatus("pi-context", ctx.ui.theme.fg(over ? "warning" : "dim", `ctx ${size}`));
		if (over && !warned) {
			const sums = sumByCategory(currentRows(ctx));
			const total = CATEGORIES.reduce((sum, cat) => sum + sums[cat], 0);
			const largest = CATEGORIES.reduce((a, b) => (sums[b] > sums[a] ? b : a));
			ctx.ui.notify(
				`Context is at ${size}. Largest part: ${LABELS[largest]}, ≈${fmtPercent(sums[largest], total)}. Run /context for details.`,
				"warning",
			);
		}
		warned = over;
	}

	function liveAgent(data: any): AgentRec {
		let agent = liveAgents.get(data.id);
		if (!agent) {
			agent = {
				id: data.id,
				type: data.type ?? "",
				description: data.description ?? "",
				status: data.parentAgentId ? "nested" : "queued",
				parent: data.parentAgentId,
			};
			liveAgents.set(data.id, agent);
		}
		return agent;
	}

	pi.on("session_start", (_event, ctx) => {
		snapshots.clear();
		runningTools.clear();
		liveAgents.clear();
		hidden = [];
		declared = recordedDeclarations(ctx.sessionManager.getBranch());
		savedDeclared = JSON.stringify(declared) ?? "";
		requestStart = 0;
		turnRequest = undefined;
		running = false;
		warned = false;
		for (const off of unsubscribe) off();
		unsubscribe = [
			pi.events.on("subagents:created", (data) => void liveAgent(data)),
			pi.events.on("subagents:started", (data) => {
				const agent = liveAgent(data);
				agent.status = "running";
				agent.startedAt ??= Date.now();
				agent.completedAt = undefined;
			}),
			// One event for each assistant message of any agent, nested agents included.
			pi.events.on("subagents:usage", (data: any) => {
				const agent = liveAgent(data);
				agent.requests = (agent.requests ?? 0) + 1;
				agent.tokens = (agent.tokens ?? 0) + (data.usage?.totalTokens ?? 0);
				agent.cost = (agent.cost ?? 0) + (data.usage?.cost?.total ?? 0);
				if (data.model) agent.model = data.model;
			}),
			pi.events.on("subagents:compacted", (data: any) => {
				liveAgent(data).compactions = data.compactionCount;
			}),
			...["subagents:completed", "subagents:failed"].map((channel) =>
				pi.events.on(channel, (data: any) => {
					const agent = liveAgent(data);
					agent.status = data.status;
					agent.completedAt = Date.now();
					agent.toolUses = data.toolUses;
					agent.error = data.error;
				}),
			),
		];
		updateStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		for (const off of unsubscribe) off();
		unsubscribe = [];
	});

	pi.on("before_agent_start", (event) => {
		hidden = event.systemPromptOptions.hiddenTools;
		const systemPrompt = applyAffixes(event.systemPrompt, loadConfig(configPath));
		if (systemPrompt !== event.systemPrompt) return { systemPrompt };
	});

	pi.on("agent_start", () => {
		running = true;
	});

	pi.on("agent_end", (_event, ctx) => {
		running = false;
		updateStatus(ctx);
	});

	pi.on("turn_start", () => {
		turnStart = Date.now();
		turnToolMs = 0;
		turnPaths = {};
		turnRequest = undefined;
	});

	pi.on("context_with_system", (event, ctx) => {
		pendingMessages = event.messages;
		pendingRows = rowsFor(pendingMessages, ctx);
	});

	// The payload is the only place that shows which tool declarations the request carries.
	pi.on("before_provider_request", (event, ctx) => {
		requestStart = Date.now();
		const found = declaredTools(event.payload);
		if (!found) return;
		declared = found;
		pendingRows = rowsFor(pendingMessages, ctx);
	});

	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant" || !requestStart) return;
		turnRequest = { time: message.timestamp, ms: Date.now() - requestStart, sums: sumByCategory(pendingRows) };
		requestStart = 0;
		snapshots.set(message.timestamp, pendingRows);
		if (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value as number);
	});

	pi.on("tool_execution_start", (event) => {
		if (event.parentToolCallId) return;
		if (runningTools.size === 0) toolsStart = Date.now();
		runningTools.add(event.toolCallId);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		// Anchor-based edit tools name the file only in their result.
		const path = event.result?.structuredContent?.path ?? event.result?.details?.path;
		if (!event.isError && typeof path === "string" && fileOp(event.toolName) === "edits") {
			turnPaths[event.toolCallId] = resolve(ctx.cwd, path);
		}
		// Parallel tool calls count once: tool time is the wall time with at least one top-level tool running.
		if (!runningTools.delete(event.toolCallId)) return;
		if (runningTools.size === 0) turnToolMs += Date.now() - toolsStart;
	});

	pi.on("turn_end", (_event, ctx) => {
		if (turnRequest) {
			const data: TurnData = { ...turnRequest, toolMs: turnToolMs, activeMs: Date.now() - turnStart };
			if (Object.keys(turnPaths).length > 0) data.paths = turnPaths;
			if (declared && JSON.stringify(declared) !== savedDeclared) {
				data.declared = declared;
				savedDeclared = JSON.stringify(declared);
			}
			pi.appendEntry(TURN_ENTRY, data);
		}
		updateStatus(ctx);
	});

	pi.on("session_compact", (_event, ctx) => updateStatus(ctx));
	pi.on("model_select", (_event, ctx) => updateStatus(ctx));

	pi.registerCommand("context", {
		description:
			"Show context insights. Subcommands: prefix [text] and suffix [text] set the system prompt prefix/suffix, warn [percent] sets the context warning, export [file] writes a Markdown report",
		handler: async (args, ctx) => {
			hidden = ctx.getSystemPromptOptions().hiddenTools ?? [];
			const [, sub, rest = ""] = /^(prefix|suffix|warn|export)\b\s*([\s\S]*)$/.exec(args.trim()) ?? [];
			if (sub === "prefix" || sub === "suffix") return setAffix(ctx, sub, rest || undefined);
			if (sub === "warn") {
				if (rest) return setWarn(ctx, rest);
				const percent = loadConfig(configPath).warnPercent ?? DEFAULT_WARN_PERCENT;
				ctx.ui.notify(`Context warning at ${percent}% (0 = disabled). Set it with /context warn <percent>.`, "info");
				return;
			}
			if (sub === "export") {
				const file = resolve(ctx.cwd, rest || `pi-context-${ctx.sessionManager.getSessionId().slice(0, 8)}.md`);
				const insights = aggregate(await loadSummaries(ctx, INSIGHTS_DAYS), Date.now(), INSIGHTS_DAYS);
				writeFileSync(file, exportMarkdown(collect(ctx), insights));
				ctx.ui.notify(`Context report written to ${file}`, "info");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify(report(collect(ctx)), "info");
				return;
			}
			const host: OverlayHost = {
				collect: () => collect(ctx),
				isLive: () => running || [...liveAgents.values()].some((agent) => agent.status === "running"),
				loadSummaries: (days, onProgress) => loadSummaries(ctx, days, onProgress),
				cwd: ctx.cwd,
				configPath,
			};
			// Editing a setting needs the editor, so the overlay closes for it and opens again on the Settings tab.
			let tab: Tab | undefined;
			for (;;) {
				const request = await ctx.ui.custom<SettingRequest | undefined>(
					(tui, theme, _keybindings, done) => new ContextOverlay(tui, theme, { ...host, tab }, done),
					{ overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%" } },
				);
				if (!request) return;
				await changeSetting(ctx, request);
				tab = "Settings";
			}
		},
	});

	pi.registerTool({
		name: "context_insight",
		label: "Context Insight",
		description:
			"Report your own context window. Without a section: provider-reported usage and session totals, the estimated composition by category (system prompt, tool schemas, user messages, injected context, skills, tool calls, tool results, reasoning, answers), and the largest items. A section returns one part in more detail.",
		promptSnippet: "Report context window usage and what it is composed of",
		parameters: Type.Object({
			section: Type.Optional(
				StringEnum(SECTIONS, {
					description:
						"summary (default): usage, totals, composition. composition: categories and the 20 largest items. requests: recent requests with cache use and cost per model. tools: calls and tokens per tool, skills loaded. files: reads, writes and edits per file. commands: shell commands and how they ended. hints: what could be dropped from the context.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return { content: [{ type: "text", text: report(collect(ctx), SECTIONS.find((section) => section === params.section)) }], details: {} };
		},
	});
}