import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
	cacheStats,
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
import { applyAffixes, type Config, DEFAULT_WARN_PERCENT, FOOTER_ITEMS, type FooterItem, loadConfig, saveConfig } from "./config.ts";
import { exportJson, exportMarkdown } from "./export.ts";
import { type FooterStats, footerItems, footerText } from "./footer.ts";
import { fmtCost, fmtPercent, fmtTokens } from "./format.ts";
import { hintsOf } from "./hints.ts";
import { aggregate, branchOf, parseEntries, type SessionSummary, scan, summarize } from "./insights.ts";
import { ContextOverlay, type OverlayHost, type SettingRequest, type Tab } from "./overlay.ts";
import { droppedOf, PRUNE_ENTRY, prune, prunedOf } from "./prune.ts";
import { report, SECTIONS } from "./report.ts";
import { type Outcome, openBrowser, startWeb, type WebServer } from "./web.ts";

const MAX_SNAPSHOTS = 200;
const INSIGHTS_DAYS = 30;
const DAY = 86_400_000;
/** How often the footer is drawn again, so that the time until the cache expires stays current. */
const FOOTER_MS = 15_000;

/** The settings that hold one number. A value of 0 turns the feature off. */
const NUMBERS = {
	warn: {
		key: "warnPercent",
		max: 100,
		prompt: "Context warning, in percent of the window (0 = disabled)",
		error: "Give a percentage from 0 to 100. 0 disables the warning.",
	},
	compact: {
		key: "compactPercent",
		max: 100,
		prompt: "Auto-compact, in percent of the window (0 = off)",
		error: "Give a percentage from 0 to 100. 0 turns auto-compact off.",
	},
	budget: {
		key: "budget",
		max: Number.POSITIVE_INFINITY,
		prompt: "Cost budget of a session, in dollars (0 = none)",
		error: "Give an amount in dollars. 0 removes the budget.",
	},
} as const;
type NumberSetting = keyof typeof NUMBERS;

const AFFIXES = { prefix: "systemPromptPrefix", suffix: "systemPromptSuffix" } as const;

const say = (ctx: ExtensionContext, { message, level }: Outcome) => ctx.ui.notify(message, level);

/** The state of a number setting, as a sentence. */
function describe(setting: NumberSetting, config: Config): string {
	if (setting === "warn") {
		const percent = config.warnPercent ?? DEFAULT_WARN_PERCENT;
		return percent === 0 ? "Context warning disabled." : `Context warning at ${percent}% of the window.`;
	}
	if (setting === "compact") return config.compactPercent ? `Auto-compact at ${config.compactPercent}% of the window.` : "Auto-compact is off.";
	return config.budget ? `Cost budget: ${fmtCost(config.budget)} for a session.` : "No cost budget.";
}

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
	let overBudget = false;
	let compacting = false;
	/** Tool calls whose results the user dropped from the context. */
	let pruned = new Set<string>();
	/** What the footer was last drawn from. */
	let footer: FooterStats = { cost: 0, requests: 0, cacheRate: 0 };
	let footerTimer: ReturnType<typeof setInterval> | undefined;
	/** Subagents seen through pi-subagents events in this run. */
	const liveAgents = new Map<string, AgentRec>();
	const fileUsageCache = new Map<string, { mtimeMs: number; usage: AgentUsage }>();
	let unsubscribe: (() => void)[] = [];
	/** The server of the context page, while it runs. */
	let web: WebServer | undefined;

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
		const projection = ctx.sessionManager.buildSessionProjection().messages;
		const messages = prune(projection, pruned);
		const current = rowsFor(messages, ctx, true);
		for (const row of current) if (row.id && pruned.has(row.id)) row.dropped = true;
		const usage = ctx.getContextUsage();
		const fileSize = (path: string) => {
			try {
				return statSync(resolve(ctx.cwd, path)).size;
			} catch {
				return undefined;
			}
		};
		return {
			analysis,
			current,
			usage,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			declared: declaredNames(messages),
			factor: scaleOf(sumTokens(current), usage?.tokens),
			hints: hintsOf(messages, fileSize),
			dropped: droppedOf(projection, pruned),
			config: loadConfig(configPath),
			agents: agentsOf(analysis),
			running,
			parentSession: ctx.sessionManager.getHeader()?.parentSession,
			reconstruct: (request) =>
				request.parentId ? rowsFor(buildSessionProjection(ctx.sessionManager.getEntries(), request.parentId).messages, ctx, true) : [],
		};
	}

	/** The dashboard data of a saved session: the branch that ends at the last entry of the file. */
	function collectFile(file: string, title: string): ViewData {
		const all = parseEntries(readFileSync(file, "utf8"));
		const entries = all.filter((entry) => entry.type !== "session");
		const leaf: string | undefined = entries.at(-1)?.id;
		const branch = branchOf(entries, leaf);
		const analysis = analyze(branch);
		const ids = prunedOf(branch);
		const then = recordedDeclarations(branch);
		const projection = buildSessionProjection(entries, leaf).messages;
		const messages = prune(projection, ids);
		const current = rowsOf(messages, then, [], true);
		for (const row of current) if (row.id && ids.has(row.id)) row.dropped = true;
		const last = analysis.requests.at(-1);
		const usage = last ? { tokens: last.context + last.output, contextWindow: 0, percent: null } : undefined;
		return {
			analysis,
			current,
			usage,
			model: last?.model,
			declared: [...schemasOf(messages, then).keys()],
			factor: scaleOf(sumTokens(current), usage?.tokens),
			hints: hintsOf(messages),
			dropped: droppedOf(projection, ids),
			config: loadConfig(configPath),
			agents: analysis.agents.map((agent) => ({ ...agent, ...fileUsage(agent.sessionFile) })),
			running: false,
			parentSession: all.find((entry) => entry.type === "session")?.parentSession,
			other: title,
			reconstruct: (request) => (request.parentId ? rowsOf(buildSessionProjection(entries, request.parentId).messages, then, [], true) : []),
		};
	}

	/** Drops tool results from the context, or restores them. The change applies from the next request. */
	function setDropped(ids: string[], dropped: boolean): void {
		for (const id of ids) {
			if (dropped) pruned.add(id);
			else pruned.delete(id);
		}
		pi.appendEntry(PRUNE_ENTRY, { ids: [...pruned] });
		web?.changed();
	}

	/** Summaries of the sessions of all projects that changed in the last `days` days. */
	function loadSummaries(ctx: ExtensionContext, days: number, onProgress?: (done: number, total: number) => void): Promise<SessionSummary[]> {
		const dir = ctx.sessionManager.getSessionDir();
		const root = dir ? dirname(dir) : join(getAgentDir(), "sessions");
		return scan(root, cachePath, Date.now() - days * DAY, onProgress);
	}

	/** Sets the system prompt prefix or suffix. Without `text`, the user edits it. Empty text disables it. */
	async function setAffix(ctx: ExtensionCommandContext, sub: "prefix" | "suffix", text?: string): Promise<void> {
		text ??= await ctx.ui.editor(`System prompt ${sub} (empty = disabled)`, loadConfig(configPath)[AFFIXES[sub]] ?? "");
		if (text !== undefined) say(ctx, saveAffix(sub, text));
	}

	function saveAffix(sub: "prefix" | "suffix", text: string): Outcome {
		const key = AFFIXES[sub];
		const config = loadConfig(configPath);
		config[key] = text.trim() || undefined;
		saveConfig(configPath, config);
		web?.changed();
		return { message: config[key] ? `System prompt ${sub} saved. It applies from the next turn.` : `System prompt ${sub} disabled.`, level: "info" };
	}

	/** Sets a number setting. Without `value`, the setting is cleared: the default applies again. */
	function setNumber(ctx: ExtensionContext, setting: NumberSetting, value?: string): Outcome {
		const { key, max, error } = NUMBERS[setting];
		const number = value === undefined ? undefined : Number(value);
		if (number !== undefined && !(value?.trim() && number >= 0 && number <= max)) {
			return { message: error, level: "error" };
		}
		const config = loadConfig(configPath);
		// Only the context warning has a default that 0 must override.
		config[key] = number === 0 && setting !== "warn" ? undefined : number;
		saveConfig(configPath, config);
		// The changed limit warns again when it is passed.
		if (setting === "warn") warned = false;
		if (setting === "budget") overBudget = false;
		updateStatus(ctx);
		return { message: describe(setting, config), level: "info" };
	}

	/** Sets what the footer shows, from a list of item names. An empty list restores the default. */
	function setFooter(ctx: ExtensionContext, value: string): Outcome {
		const names = value.split(/[\s,]+/).filter(Boolean);
		const items = names.filter((name): name is FooterItem => FOOTER_ITEMS.some((item) => item === name));
		if (items.length < names.length) {
			return { message: `Give one or more of: ${FOOTER_ITEMS.join(", ")}.`, level: "error" };
		}
		const config = loadConfig(configPath);
		config.footer = items.length > 0 ? [...new Set(items)] : undefined;
		saveConfig(configPath, config);
		updateStatus(ctx);
		return { message: `The footer shows: ${footerItems(config).join(", ")}.`, level: "info" };
	}

	/** Makes the change the user asked for in the Settings tab. */
	async function changeSetting(ctx: ExtensionCommandContext, { setting, clear }: SettingRequest): Promise<void> {
		if (setting === "prefix" || setting === "suffix") return setAffix(ctx, setting, clear ? "" : undefined);
		const config = loadConfig(configPath);
		if (setting === "footer") {
			const value = clear ? "" : await ctx.ui.input(`Footer items, in order: ${FOOTER_ITEMS.join(", ")}`, footerItems(config).join(", "));
			if (value !== undefined) say(ctx, setFooter(ctx, value));
			return;
		}
		const current = setting === "warn" ? (config.warnPercent ?? DEFAULT_WARN_PERCENT) : (config[NUMBERS[setting].key] ?? 0);
		const value = clear ? undefined : await ctx.ui.input(NUMBERS[setting].prompt, String(current));
		if (clear || value !== undefined) say(ctx, setNumber(ctx, setting, value));
	}

	/** Makes a change that the context page asked for. An empty number restores the default. */
	function applySetting(ctx: ExtensionContext, setting: string, value: string): Outcome {
		if (setting === "prefix" || setting === "suffix") return saveAffix(setting, value);
		if (setting === "footer") return setFooter(ctx, value);
		if (setting === "warn" || setting === "compact" || setting === "budget") return setNumber(ctx, setting, value.trim() ? value : undefined);
		return { message: `There is no setting "${setting}".`, level: "error" };
	}

	/** Draws the footer from the figures last collected. */
	function drawStatus(ctx: ExtensionContext, config = loadConfig(configPath)): void {
		const limit = config.warnPercent ?? DEFAULT_WARN_PERCENT;
		const text = footerText(config, footer, Date.now());
		const alert = (limit > 0 && (footer.usage?.percent ?? 0) >= limit) || (!!config.budget && footer.cost >= config.budget);
		ctx.ui.setStatus("pi-context", text ? ctx.ui.theme.fg(alert ? "warning" : "dim", text) : undefined);
	}

	/**
	 * Updates the footer. Warns once each time context use rises to the configured percentage,
	 * and once each time the session cost rises to the budget.
	 */
	function updateStatus(ctx: ExtensionContext): void {
		web?.changed();
		if (!ctx.hasUI) return;
		const config = loadConfig(configPath);
		const usage = ctx.getContextUsage();
		footer = { usage, cost: 0, requests: 0, cacheRate: 0 };
		// The figures of the session are needed only for the items that show them.
		if (footerItems(config).some((item) => item !== "context")) {
			const analysis = analyze(ctx.sessionManager.getBranch());
			footer = { usage, cost: analysis.totals.cost, requests: analysis.requests.length, cacheRate: cacheStats(analysis).rate, cacheUntil: analysis.cacheUntil };
		}
		drawStatus(ctx, config);
		const limit = config.warnPercent ?? DEFAULT_WARN_PERCENT;
		const over = limit > 0 && usage?.percent != null && usage.percent >= limit;
		if (over && !warned) {
			const sums = sumByCategory(currentRows(ctx));
			const total = CATEGORIES.reduce((sum, cat) => sum + sums[cat], 0);
			const largest = CATEGORIES.reduce((a, b) => (sums[b] > sums[a] ? b : a));
			ctx.ui.notify(
				`Context is at ${Math.round(usage.percent ?? 0)}% ${fmtTokens(usage.tokens)}/${fmtTokens(usage.contextWindow)}. Largest part: ${LABELS[largest]}, ≈${fmtPercent(sums[largest], total)}. Run /context for details.`,
				"warning",
			);
		}
		warned = over;
		const spent = !!config.budget && footer.cost >= config.budget;
		if (spent && !overBudget) {
			ctx.ui.notify(`The session cost ${fmtCost(footer.cost)} has reached the budget of ${fmtCost(config.budget ?? 0)}.`, "warning");
		}
		overBudget = spent;
	}

	/** Starts compaction when the agent has stopped and context use is at the configured percentage. */
	function autoCompact(ctx: ExtensionContext): void {
		const limit = loadConfig(configPath).compactPercent;
		const percent = ctx.getContextUsage()?.percent;
		if (!limit || percent == null || percent < limit || compacting || !ctx.hasUI) return;
		compacting = true;
		ctx.ui.notify(`Context is at ${Math.round(percent)}%. pi-context starts compaction (auto-compact at ${limit}%).`, "info");
		// Pi reports a failed compaction itself.
		const finished = () => {
			compacting = false;
		};
		ctx.compact({ onComplete: finished, onError: finished });
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
		const branch = ctx.sessionManager.getBranch();
		declared = recordedDeclarations(branch);
		savedDeclared = JSON.stringify(declared) ?? "";
		pruned = prunedOf(branch);
		requestStart = 0;
		turnRequest = undefined;
		running = false;
		warned = false;
		overBudget = false;
		compacting = false;
		clearInterval(footerTimer);
		if (ctx.hasUI) {
			footerTimer = setInterval(() => {
				try {
					const config = loadConfig(configPath);
					if (footerItems(config).includes("ttl")) drawStatus(ctx, config);
				} catch {
					// The session is gone.
					clearInterval(footerTimer);
				}
			}, FOOTER_MS);
			footerTimer.unref?.();
		}
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
		clearInterval(footerTimer);
		web?.close();
		web = undefined;
	});

	// Another branch has its own dropped results.
	pi.on("session_tree", (_event, ctx) => {
		pruned = prunedOf(ctx.sessionManager.getBranch());
		updateStatus(ctx);
	});

	pi.on("context", (event) => {
		if (pruned.size > 0) return { messages: prune(event.messages, pruned) };
	});

	pi.on("before_agent_start", (event) => {
		hidden = event.systemPromptOptions.hiddenTools;
		const systemPrompt = applyAffixes(event.systemPrompt, loadConfig(configPath));
		if (systemPrompt !== event.systemPrompt) return { systemPrompt };
	});

	pi.on("agent_start", () => {
		running = true;
		web?.changed();
	});

	pi.on("agent_end", (_event, ctx) => {
		running = false;
		updateStatus(ctx);
		autoCompact(ctx);
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
		web?.changed();
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
			"Show context insights. Subcommands: prefix [text] and suffix [text] set the system prompt prefix/suffix; warn [percent], compact [percent], budget [dollars] and footer [items] change settings; export [file] writes a Markdown report, or JSON when the file ends in .json; web opens the context page in the browser, web stop stops its server",
		handler: async (args, ctx) => {
			hidden = ctx.getSystemPromptOptions().hiddenTools ?? [];
			const [, sub, rest = ""] = /^(prefix|suffix|warn|compact|budget|footer|export|web)\b\s*([\s\S]*)$/.exec(args.trim()) ?? [];
			if (sub === "prefix" || sub === "suffix") return setAffix(ctx, sub, rest || undefined);
			if (sub === "warn" || sub === "compact" || sub === "budget") {
				if (rest) return say(ctx, setNumber(ctx, sub, rest));
				const unit = sub === "budget" ? "dollars" : "percent";
				ctx.ui.notify(`${describe(sub, loadConfig(configPath))} Set it with /context ${sub} <${unit}>; 0 turns it off.`, "info");
				return;
			}
			if (sub === "footer") {
				if (rest) return say(ctx, setFooter(ctx, rest));
				const items = footerItems(loadConfig(configPath)).join(", ");
				ctx.ui.notify(`The footer shows: ${items}. Set it with /context footer <items>, from: ${FOOTER_ITEMS.join(", ")}.`, "info");
				return;
			}
			if (sub === "export") {
				const file = resolve(ctx.cwd, rest || `pi-context-${ctx.sessionManager.getSessionId().slice(0, 8)}.md`);
				const insights = aggregate(await loadSummaries(ctx, INSIGHTS_DAYS), Date.now(), INSIGHTS_DAYS);
				writeFileSync(file, (file.endsWith(".json") ? exportJson : exportMarkdown)(collect(ctx), insights));
				ctx.ui.notify(`Context report written to ${file}`, "info");
				return;
			}
			const host: OverlayHost = {
				collect: () => collect(ctx),
				isLive: () => running || [...liveAgents.values()].some((agent) => agent.status === "running"),
				loadSummaries: (days, onProgress) => loadSummaries(ctx, days, onProgress),
				openSession: collectFile,
				setDropped,
				cwd: ctx.cwd,
				configPath,
			};
			if (sub === "web") {
				if (rest === "stop") {
					web?.close();
					ctx.ui.notify(web ? "The context page is stopped." : "The context page is not running.", "info");
					web = undefined;
					return;
				}
				web ??= await startWeb({
					...host,
					title: () => ctx.sessionManager.getSessionName() ?? basename(ctx.cwd),
					changeSetting: (setting, value) => applySetting(ctx, setting, value),
				});
				openBrowser(web.url);
				ctx.ui.notify(`Context page: ${web.url}\nIt stops when the session ends, or with /context web stop.`, "info");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify(report(collect(ctx)), "info");
				return;
			}
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