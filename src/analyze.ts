import { fmtTokens } from "./format.ts";

export const CATEGORIES = [
	"system",
	"tools",
	"user",
	"injected",
	"skills",
	"toolCalls",
	"toolResults",
	"reasoning",
	"answers",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const LABELS: Record<Category, string> = {
	system: "System prompt",
	tools: "Tool schemas",
	user: "User messages",
	injected: "Injected context",
	skills: "Skill injections",
	toolCalls: "Tool calls",
	toolResults: "Tool results",
	reasoning: "Reasoning",
	answers: "Answers",
};

/** One part of a request: a message, or one content kind of an assistant message. */
export interface Row {
	cat: Category;
	tokens: number;
	label: string;
	preview: string;
}

export interface RequestRec {
	n: number;
	time: number;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Tokens sent: input + cacheRead + cacheWrite. */
	context: number;
	cost: number;
	stop: string;
	/** Entry the request's context ends at. The composition can be rebuilt from the branch up to it. */
	parentId?: string | null;
	/** Composition snapshot with its items; only for requests made in this run of pi. */
	rows?: Row[];
	/** Composition by category and duration, when pi-context recorded the turn in the session. */
	sums?: Record<Category, number>;
	ms?: number;
}

export interface EventRec {
	time: number;
	kind: string;
	detail: string;
}

export interface FileRec {
	path: string;
	reads: number;
	writes: number;
	edits: number;
}

export interface CommandRec {
	time: number;
	command: string;
	program: string;
	ok?: boolean;
}

export interface ToolRec {
	name: string;
	/** Calls the model made directly. */
	calls: number;
	/** Calls made by another tool, for example from a script. Their tokens belong to that tool. */
	nested: number;
	errors: number;
	callTokens: number;
	resultTokens: number;
}

export interface SkillRec {
	path: string;
	name: string;
	loads: number;
	/** Estimated size of the last load; 0 when the load was a nested call. */
	tokens: number;
}

export interface AgentRec {
	id: string;
	type: string;
	description: string;
	status: string;
	startedAt?: number;
	completedAt?: number;
	sessionFile?: string;
	error?: string;
	/** Id of the agent that started this one, for nested agents. */
	parent?: string;
	model?: string;
	requests?: number;
	tokens?: number;
	cost?: number;
	toolUses?: number;
	compactions?: number;
}

export interface Timing {
	activeMs: number;
	modelMs: number;
	toolMs: number;
}

/** Session entry type that pi-context appends at the end of each turn. */
export const TURN_ENTRY = "pi-context:turn";

/** What pi-context records about one turn: one request and the tool calls it made. */
export interface TurnData {
	/** Timestamp of the assistant message. It joins the record to its request. */
	time: number;
	ms: number;
	toolMs: number;
	activeMs: number;
	sums: Record<Category, number>;
	/** Tool call id to file path, for edit tools whose arguments carry no path. */
	paths?: Record<string, string>;
	/** Tool declarations the request carried, when they differ from the last record: name to size in characters. */
	declared?: Record<string, number>;
}

export interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface Analysis {
	requests: RequestRec[];
	events: EventRec[];
	files: FileRec[];
	commands: CommandRec[];
	tools: ToolRec[];
	skills: SkillRec[];
	/** Subagents that finished on this branch, from the records pi-subagents saves. */
	agents: AgentRec[];
	userInputs: number;
	toolCalls: number;
	toolErrors: number;
	/** Anchor-based edits whose file is unknown because no turn record names it. */
	unresolvedEdits: number;
	totals: Totals;
	/** Sums over the turns pi-context recorded. */
	timing: Timing;
}

export interface ViewData {
	analysis: Analysis;
	current: Row[];
	usage?: { tokens: number | null; contextWindow: number; percent: number | null };
	model?: string;
	/** Names of the tools declared to the model now. */
	declared: string[];
	/** Finished and live subagents, newest first. */
	agents: AgentRec[];
	running: boolean;
	parentSession?: string;
	/** Rebuilds the composition of a request that has no snapshot. */
	reconstruct: (request: RequestRec) => Row[];
}

const CHARS_PER_TOKEN = 4;
const IMAGE_CHARS = 4800;

export const estimate = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

function contentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content) chars += block?.type === "image" ? IMAGE_CHARS : (block?.text?.length ?? 0);
	return chars;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block?.type === "image" ? "[image]" : (block?.text ?? ""))).join(" ");
}

function argPath(args: any): string | undefined {
	const path = args?.path ?? args?.file_path ?? args?.filePath;
	return typeof path === "string" ? path : undefined;
}

const isSkillRead = (call: any) => /read/i.test(call.name) && /(^|\/)SKILL\.md$/.test(argPath(call.arguments) ?? "");

/**
 * Tool declarations in a provider request payload: name to size in characters.
 * Undefined when the payload declares no tool list.
 */
export function declaredTools(payload: any): Record<string, number> | undefined {
	const list = payload?.tools ?? payload?.config?.tools ?? payload?.toolConfig?.tools;
	if (!Array.isArray(list)) return undefined;
	const declared: Record<string, number> = {};
	for (const entry of list) {
		// Google groups declarations in one entry. OpenAI chat and Bedrock nest the name one level down.
		for (const tool of entry?.functionDeclarations ?? [entry]) {
			const name = tool?.name ?? tool?.function?.name ?? tool?.toolSpec?.name;
			if (typeof name === "string") declared[name] = JSON.stringify(tool).length;
		}
	}
	return declared;
}

/** The tool declarations pi-context last recorded on the branch. */
export function recordedDeclarations(entries: any[]): Record<string, number> | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === TURN_ENTRY && entry.data?.declared) return entry.data.declared;
	}
	return undefined;
}

/**
 * Tool schemas a request carries: name to size in characters.
 *
 * The transcript declares every active tool, but a request can leave declarations out and change
 * descriptions (as codemode does in "only" mode). `declared` is what a request carried. Without it,
 * the schemas are those the system messages add and remove in order, less the tools named in `hidden`.
 */
export function schemasOf(messages: any[], declared?: Record<string, number>, hidden: string[] = []): Map<string, number> {
	if (declared) return new Map(Object.entries(declared));
	const schemas = new Map<string, number>();
	for (const m of messages) {
		if (m?.role !== "system") continue;
		for (const tool of m.toolsAdded ?? []) schemas.set(tool.name, JSON.stringify(tool).length);
		for (const tool of m.toolsRemoved ?? []) schemas.delete(typeof tool === "string" ? tool : tool.name);
	}
	for (const name of hidden) schemas.delete(name);
	return schemas;
}

/** Whether the model called the tool directly although the tool is not declared to it. */
export const undeclared = (tool: ToolRec, declared: string[]) => tool.calls > 0 && !declared.includes(tool.name);

/** Splits the messages of one request into categorized rows with estimated token counts. See {@link schemasOf}. */
export function rowsOf(messages: any[], declared?: Record<string, number>, hidden: string[] = []): Row[] {
	const rows: Row[] = [];
	const push = (cat: Category, chars: number, label: string, text: string) => {
		if (chars > 0) rows.push({ cat, tokens: estimate(chars), label, preview: text.replace(/\s+/g, " ").trim().slice(0, 160) });
	};
	// System messages replay in order: later ones append text, and replace or remove sections.
	const sections = new Map<string, number>();
	const skillCalls = new Set<string>();
	let systemChars = 0;
	let systemText = "";
	let headAt = -1;
	for (const m of messages) {
		switch (m?.role) {
			case "system":
				systemChars += contentChars(m.content);
				systemText += contentText(m.content);
				for (const [name, text] of Object.entries(m.sections ?? {})) {
					if (typeof text === "string") sections.set(name, text.length);
					else sections.delete(name);
				}
				if (headAt < 0) headAt = rows.length;
				break;
			case "user":
				push("user", contentChars(m.content), "user", contentText(m.content));
				break;
			case "assistant": {
				const blocks: any[] = Array.isArray(m.content) ? m.content : [];
				const textOf = (type: string, key: string) =>
					blocks
						.filter((b) => b?.type === type)
						.map((b) => b[key] ?? "")
						.join("\n");
				const thinking = textOf("thinking", "thinking");
				const answer = textOf("text", "text");
				push("reasoning", thinking.length, "reasoning", thinking);
				push("answers", answer.length, "answer", answer);
				for (const call of blocks.filter((b) => b?.type === "toolCall")) {
					const args = JSON.stringify(call.arguments ?? {});
					if (isSkillRead(call)) skillCalls.add(call.id);
					push("toolCalls", call.name.length + args.length, `call ${call.name}`, args);
				}
				break;
			}
			case "toolResult":
				push(
					skillCalls.has(m.toolCallId) ? "skills" : "toolResults",
					contentChars(m.content),
					`result ${m.toolName}`,
					contentText(m.content),
				);
				break;
			case "bashExecution":
				if (!m.excludeFromContext) {
					push("injected", (m.command?.length ?? 0) + (m.output?.length ?? 0), "bash", m.command ?? "");
				}
				break;
			case "custom":
				push("injected", contentChars(m.content), m.customType ?? "custom", contentText(m.content));
				break;
			case "branchSummary":
			case "compactionSummary":
				push("injected", m.summary?.length ?? 0, m.role, m.summary ?? "");
				break;
		}
	}
	const sum = (sizes: Map<string, number>) => [...sizes.values()].reduce((total, size) => total + size, 0);
	const schemas = schemasOf(messages, declared, hidden);
	const tail = rows.splice(Math.max(0, headAt));
	push("system", systemChars + sum(sections), "system", systemText || [...sections.keys()].join(", "));
	push("tools", sum(schemas), `${schemas.size} tool schemas`, [...schemas.keys()].join(", "));
	rows.push(...tail);
	return rows;
}

export function sumByCategory(rows: Row[]): Record<Category, number> {
	const sums = Object.fromEntries(CATEGORIES.map((cat) => [cat, 0])) as Record<Category, number>;
	for (const row of rows) sums[row.cat] += row.tokens;
	return sums;
}

/** Program a shell command runs: the first one that is not `cd`, ignoring env assignments, sudo and directories. */
export function programOf(command: string): string {
	let fallback = "";
	for (const segment of command.split(/&&|\|\||[;|\n]/)) {
		const word =
			segment
				.trim()
				.split(/\s+/)
				.map((w) => w.replace(/^\w+=\$\(/, ""))
				.find((w) => w && !/^\w+=/.test(w) && w !== "sudo") ?? "";
		const program = word.split("/").pop() ?? "";
		if (program && program !== "cd") return program;
		fallback ||= program;
	}
	return fallback;
}

export function fileOp(toolName: string): "reads" | "writes" | "edits" | undefined {
	if (toolName === "read") return "reads";
	if (toolName === "write") return "writes";
	if (/edit|replace|insert|patch/i.test(toolName)) return "edits";
	return undefined;
}

function addUsage(totals: Totals, usage: any): void {
	totals.input += usage?.input ?? 0;
	totals.output += usage?.output ?? 0;
	totals.cacheRead += usage?.cacheRead ?? 0;
	totals.cacheWrite += usage?.cacheWrite ?? 0;
	totals.cost += usage?.cost?.total ?? 0;
}

const ANCHOR_KEYS = ["anchor", "remove_from", "replace_from", "source_from"];
const hasAnchor = (args: any) => ANCHOR_KEYS.some((key) => typeof args?.[key] === "string");

/** Derives requests, events, tool, file and command activity from the session entries of one branch. */
export function analyze(entries: any[]): Analysis {
	const analysis: Analysis = {
		requests: [],
		events: [],
		files: [],
		commands: [],
		tools: [],
		skills: [],
		agents: [],
		userInputs: 0,
		toolCalls: 0,
		toolErrors: 0,
		unresolvedEdits: 0,
		totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		timing: { activeMs: 0, modelMs: 0, toolMs: 0 },
	};
	const files = new Map<string, FileRec>();
	const tools = new Map<string, ToolRec>();
	const skills = new Map<string, SkillRec>();
	const agents = new Map<string, AgentRec>();
	const commandsById = new Map<string, CommandRec>();
	const skillsById = new Map<string, SkillRec>();
	// A turn record follows the messages it describes, so read the records first.
	const turns = new Map<number, TurnData>();
	const paths = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== TURN_ENTRY || !entry.data) continue;
		const turn: TurnData = entry.data;
		turns.set(turn.time, turn);
		for (const [id, path] of Object.entries(turn.paths ?? {})) paths.set(id, path);
		analysis.timing.activeMs += turn.activeMs ?? 0;
		analysis.timing.modelMs += turn.ms ?? 0;
		analysis.timing.toolMs += turn.toolMs ?? 0;
	}
	const tool = (name: string) => {
		let rec = tools.get(name);
		if (!rec) tools.set(name, (rec = { name, calls: 0, nested: 0, errors: 0, callTokens: 0, resultTokens: 0 }));
		return rec;
	};
	const recordCall = (call: { id: string; name: string; arguments?: any }, time: number, nestedStatus?: string) => {
		analysis.toolCalls++;
		const rec = tool(call.name);
		if (nestedStatus) {
			rec.nested++;
			if (nestedStatus === "error") rec.errors++;
		} else {
			rec.calls++;
			rec.callTokens += estimate(call.name.length + JSON.stringify(call.arguments ?? {}).length);
		}
		const path = argPath(call.arguments) ?? paths.get(call.id);
		const op = fileOp(call.name);
		if (path && op) {
			const file = files.get(path) ?? { path, reads: 0, writes: 0, edits: 0 };
			file[op]++;
			files.set(path, file);
		} else if (op === "edits" && nestedStatus !== "error" && hasAnchor(call.arguments)) analysis.unresolvedEdits++;
		if (path && isSkillRead(call)) {
			const skill = skills.get(path) ?? { path, name: path.split("/").at(-2) ?? path, loads: 0, tokens: 0 };
			skill.loads++;
			skills.set(path, skill);
			skillsById.set(call.id, skill);
		}
		if (call.name === "bash" && typeof call.arguments?.command === "string") {
			const command: CommandRec = { time, command: call.arguments.command, program: programOf(call.arguments.command) };
			commandsById.set(call.id, command);
			analysis.commands.push(command);
		}
	};
	for (const entry of entries) {
		const entryTime = Date.parse(entry.timestamp) || 0;
		const event = (kind: string, detail: string) => analysis.events.push({ time: entryTime, kind, detail });
		if (entry.type === "compaction") {
			event("compaction", `${fmtTokens(entry.tokensBefore)} tokens before compaction`);
			addUsage(analysis.totals, entry.usage);
		} else if (entry.type === "model_change") event("model", `${entry.provider}/${entry.modelId}`);
		else if (entry.type === "thinking_level_change") event("thinking", String(entry.thinkingLevel));
		else if (entry.type === "branch_summary") event("branch summary", `${fmtTokens(estimate(entry.summary?.length ?? 0))} tokens`);
		else if (entry.type === "usage") addUsage(analysis.totals, entry.usage);
		else if (entry.type === "custom" && entry.customType === "subagents:record" && typeof entry.data?.id === "string") {
			const { id, type, description, status, startedAt, completedAt, sessionFile, error } = entry.data;
			agents.set(id, { id, type, description, status, startedAt, completedAt, sessionFile, error });
		}
		if (entry.type !== "message") continue;

		const m = entry.message;
		const time = m.timestamp ?? entryTime;
		if (m.role === "user") analysis.userInputs++;
		else if (m.role === "bashExecution") {
			analysis.commands.push({ time, command: m.command, program: programOf(m.command), ok: m.exitCode === 0 });
		} else if (m.role === "toolResult") {
			const rec = tool(m.toolName);
			rec.resultTokens += estimate(contentChars(m.content));
			if (m.isError) {
				analysis.toolErrors++;
				rec.errors++;
			}
			addUsage(analysis.totals, m.usage);
			const command = commandsById.get(m.toolCallId);
			if (command) command.ok = !m.isError;
			const skill = skillsById.get(m.toolCallId);
			if (skill) skill.tokens = estimate(contentChars(m.content));
			// Calls that this tool made to other tools (for example from a script).
			for (const nested of m.nestedCalls?.calls ?? []) {
				recordCall(nested, time, nested.status ?? "ok");
				if (nested.status === "error") analysis.toolErrors++;
				const nestedCommand = commandsById.get(nested.id);
				if (nestedCommand && nested.status !== "unfinished") nestedCommand.ok = nested.status === "ok";
			}
		} else if (m.role === "assistant") {
			const usage = m.usage ?? {};
			const turn = turns.get(time);
			addUsage(analysis.totals, usage);
			analysis.requests.push({
				n: analysis.requests.length + 1,
				time,
				model: m.model ?? "",
				input: usage.input ?? 0,
				output: usage.output ?? 0,
				cacheRead: usage.cacheRead ?? 0,
				cacheWrite: usage.cacheWrite ?? 0,
				context: (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
				cost: usage.cost?.total ?? 0,
				stop: m.stopReason ?? "",
				parentId: entry.parentId,
				sums: turn?.sums,
				ms: turn?.ms,
			});
			for (const call of Array.isArray(m.content) ? m.content : []) {
				if (call?.type === "toolCall") recordCall(call, time);
			}
		}
	}
	analysis.files = [...files.values()];
	analysis.tools = [...tools.values()];
	analysis.skills = [...skills.values()];
	analysis.agents = [...agents.values()];
	return analysis;
}