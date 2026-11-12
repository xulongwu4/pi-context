import type { Config } from "./config.ts";
import { fmtTokens } from "./format.ts";
import type { Hint } from "./hints.ts";

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
	/** Full content. Only rows built for inspection carry it. */
	text?: string;
	/** Tool call id, for a tool result. */
	id?: string;
	/** The user dropped this tool result: the model gets a stub in its place. */
	dropped?: boolean;
	/** When the message of the row was created, in ms. The system prompt and the tool schemas have none. */
	time?: number;
}

/** How the rows of a request differ from those of the request before it. */
export interface RowDiff {
	/** For each row of the request: "+" added, "~" changed, "" unchanged. */
	marks: ("+" | "~" | "")[];
	/** Rows of the previous request that this one no longer carries. */
	removed: Row[];
	/** Change of the estimated size of each category. */
	delta: Record<Category, number>;
	/** Change of the number of rows of each category. */
	items: Record<Category, number>;
}

/** A request that read little of the previous request from the cache, so the provider billed that part again. */
export interface CacheMiss {
	/** Tokens of the previous request that were not read from the cache. */
	tokens: number;
	/** Estimated extra cost: those tokens at the rate paid, less the cache read rate. */
	cost: number;
	/** Time since the previous request. */
	idleMs: number;
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
	miss?: CacheMiss;
	/** Entry the request's context ends at. The composition can be rebuilt from the branch up to it. */
	parentId?: string | null;
	/** Composition snapshot with its items; only for requests made in this run of pi. */
	rows?: Row[];
	/** Composition by category and duration, when pi-context recorded the turn in the session. */
	sums?: Record<Category, number>;
	ms?: number;
}

/** One human input and the work it caused, up to the next input. */
export interface InputRec {
	n: number;
	time: number;
	preview: string;
	/** Index in `requests` of the first request it caused; -1 when it caused none. */
	first: number;
	requests: number;
	toolCalls: number;
	/** Input and cache tokens of its requests. */
	sent: number;
	output: number;
	cost: number;
	/** Time from the input to the last message it caused. */
	ms: number;
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
	/** Direct calls made while the recorded declarations did not include the tool. */
	undeclared: number;
	/** Direct calls made before pi-context recorded any declarations. */
	unchecked: number;
}

export interface ModelRec {
	model: string;
	requests: number;
	/** Input and cache tokens of the requests. */
	sent: number;
	output: number;
	cost: number;
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
	inputs: InputRec[];
	events: EventRec[];
	files: FileRec[];
	commands: CommandRec[];
	tools: ToolRec[];
	skills: SkillRec[];
	models: ModelRec[];
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
	/** Tokens sent over the session by category: the recorded composition of each request, scaled to its provider-reported size. */
	billed: Record<Category, number>;
	/** Requests that `billed` covers. */
	billedRequests: number;
	/** Estimated time at which the prompt cache of the last request expires. Undefined when the model does not cache. */
	cacheUntil?: number;
}

export interface ViewData {
	analysis: Analysis;
	current: Row[];
	usage?: { tokens: number | null; contextWindow: number; percent: number | null };
	model?: string;
	/** Names of the tools declared to the model now. */
	declared: string[];
	/** Scales the estimates of the current context to the provider-reported size; 1 when that size is unknown. */
	factor: number;
	hints: Hint[];
	/** The dropped tool results that the context still holds, with their original sizes. */
	dropped: Row[];
	config: Config;
	/** Finished and live subagents, newest first. */
	agents: AgentRec[];
	running: boolean;
	parentSession?: string;
	/** Name of the session, when it is not the current one. Such data is read-only. */
	other?: string;
	/** Rebuilds the composition of a request that has no snapshot. */
	reconstruct: (request: RequestRec) => Row[];
}

const CHARS_PER_TOKEN = 4;
const IMAGE_CHARS = 4800;

export const estimate = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

export function contentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content) chars += block?.type === "image" ? IMAGE_CHARS : (block?.text?.length ?? 0);
	return chars;
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block?.type === "image" ? "[image]" : (block?.text ?? ""))).join(" ");
}

export function argPath(args: any): string | undefined {
	const path = args?.path ?? args?.file_path ?? args?.filePath;
	return typeof path === "string" ? path : undefined;
}

export const isSkillRead = (call: any) => /read/i.test(call.name) && /(^|\/)SKILL\.md$/.test(argPath(call.arguments) ?? "");

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

/**
 * Direct calls to the tool that the model made while the tool was not declared to it.
 * Calls made before pi-context recorded declarations are judged by `declared`, the tools declared now.
 */
export const undeclared = (tool: ToolRec, declared: string[]) => tool.undeclared + (declared.includes(tool.name) ? 0 : tool.unchecked);

/** Factor that scales estimates so that they add up to the provider-reported figure; 1 when that figure is unknown. */
export const scaleOf = (estimated: number, reported?: number | null) => (estimated > 0 && reported ? reported / estimated : 1);

export const sumTokens = (rows: Row[]) => rows.reduce((total, row) => total + row.tokens, 0);

/**
 * Splits the messages of one request into categorized rows with estimated token counts. See {@link schemasOf}.
 * With `full`, each row also carries its whole content.
 */
export function rowsOf(messages: any[], declared?: Record<string, number>, hidden: string[] = [], full = false): Row[] {
	const rows: Row[] = [];
	/** Time of the message being read. */
	let time: number | undefined;
	const push = (cat: Category, chars: number, label: string, text: string, content = text, id?: string) => {
		if (chars <= 0) return;
		const row: Row = { cat, tokens: estimate(chars), label, preview: text.slice(0, 640).replace(/\s+/g, " ").trim().slice(0, 160) };
		if (full) row.text = content;
		if (id) row.id = id;
		if (time !== undefined) row.time = time;
		rows.push(row);
	};
	// System messages replay in order: later ones append text, and replace or remove sections.
	const sections = new Map<string, string>();
	const skillCalls = new Set<string>();
	let systemChars = 0;
	let systemText = "";
	let headAt = -1;
	for (const m of messages) {
		time = typeof m?.timestamp === "number" ? m.timestamp : undefined;
		switch (m?.role) {
			case "system":
				systemChars += contentChars(m.content);
				systemText += contentText(m.content);
				for (const [name, text] of Object.entries(m.sections ?? {})) {
					if (typeof text === "string") sections.set(name, text);
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
					undefined,
					m.toolCallId,
				);
				break;
			case "bashExecution":
				if (!m.excludeFromContext) {
					push("injected", (m.command?.length ?? 0) + (m.output?.length ?? 0), "bash", m.command ?? "", `${m.command ?? ""}\n${m.output ?? ""}`);
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
	const schemas = schemasOf(messages, declared, hidden);
	const sectionChars = [...sections.values()].reduce((total, text) => total + text.length, 0);
	const schemaChars = [...schemas.values()].reduce((total, size) => total + size, 0);
	const tail = rows.splice(Math.max(0, headAt));
	time = undefined;
	push(
		"system",
		systemChars + sectionChars,
		"system",
		systemText || [...sections.keys()].join(", "),
		full ? [systemText, ...[...sections].map(([name, text]) => `[${name}]\n${text}`)].filter(Boolean).join("\n\n") : "",
	);
	push(
		"tools",
		schemaChars,
		`${schemas.size} tool schemas`,
		[...schemas.keys()].join(", "),
		full
			? [...schemas]
					.sort((x, y) => y[1] - x[1])
					.map(([name, chars]) => `≈${fmtTokens(estimate(chars)).padStart(6)}  ${name}`)
					.join("\n")
			: "",
	);
	rows.push(...tail);
	return rows;
}

/**
 * The whole content of a row. A row of a recorded request carries none;
 * its content is that of the same item among `rebuilt`, the rows of the request rebuilt from the session.
 */
export function textOf(row: Row, index: number, rebuilt: Row[]): string | undefined {
	if (row.text !== undefined) return row.text;
	const same = (other?: Row) => other?.cat === row.cat && other.label === row.label && other.preview === row.preview;
	const fixed = row.cat === "system" || row.cat === "tools";
	return (same(rebuilt[index]) ? rebuilt[index] : (rebuilt.find(same) ?? (fixed ? rebuilt.find((other) => other.cat === row.cat) : undefined)))?.text;
}

export function sumByCategory(rows: Row[]): Record<Category, number> {
	const sums = emptySums();
	for (const row of rows) sums[row.cat] += row.tokens;
	return sums;
}

const emptySums = () => Object.fromEntries(CATEGORIES.map((cat) => [cat, 0])) as Record<Category, number>;

/** Compares the rows of a request with those of the request before it. */
export function diffRows(previous: Row[], rows: Row[]): RowDiff {
	const content = (row: Row) => `${row.cat}\n${row.label}\n${row.tokens}\n${row.preview}`;
	// The system prompt, the tool schemas and a tool result keep their identity when their content changes.
	const identity = (row: Row) => (row.cat === "system" || row.cat === "tools" ? row.cat : row.id ? `id\n${row.id}` : content(row));
	const left = new Map<string, Row[]>();
	for (const row of previous) {
		const same = left.get(identity(row));
		if (same) same.push(row);
		else left.set(identity(row), [row]);
	}
	const marks = rows.map((row) => {
		const match = left.get(identity(row))?.shift();
		return !match ? "+" : content(match) === content(row) ? "" : "~";
	});
	const before = sumByCategory(previous);
	const delta = sumByCategory(rows);
	for (const cat of CATEGORIES) delta[cat] -= before[cat];
	const items = emptySums();
	for (const row of rows) items[row.cat]++;
	for (const row of previous) items[row.cat]--;
	return { marks, removed: [...left.values()].flat(), delta, items };
}

/**
 * Number of the first request that carried the row: the first one made after the message of the row was created.
 * Undefined when the row has no time, or no request was made since.
 */
export function introducedAt(row: Row, requests: RequestRec[]): number | undefined {
	const time = row.time;
	return time === undefined ? undefined : requests.find((request) => request.time > time)?.n;
}

/**
 * The rows as a strip of `width` cells in reading order: each cell has the category of the row at its middle.
 * A row smaller than a cell can be left out. Empty when the rows have no tokens.
 */
export function bands(rows: Row[], width: number): Category[] {
	const total = sumTokens(rows);
	if (total <= 0) return [];
	const cells: Category[] = [];
	let index = 0;
	let end = rows[0].tokens;
	for (let cell = 0; cell < width; cell++) {
		const middle = ((cell + 0.5) / width) * total;
		while (end <= middle && index < rows.length - 1) end += rows[++index].tokens;
		cells.push(rows[index].cat);
	}
	return cells;
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

/** Providers do not cache prompts shorter than about this. */
const MIN_CACHED_TOKENS = 1024;
/** How long providers keep a cached prompt after its last use: by default, and with the long retention. */
const CACHE_MS = 5 * 60_000;
const LONG_CACHE_MS = 60 * 60_000;

const ANCHOR_KEYS = ["anchor", "remove_from", "replace_from", "source_from"];
const hasAnchor = (args: any) => ANCHOR_KEYS.some((key) => typeof args?.[key] === "string");

/** Derives requests, events, tool, file and command activity from the session entries of one branch. */
export function analyze(entries: any[]): Analysis {
	const analysis: Analysis = {
		requests: [],
		inputs: [],
		events: [],
		files: [],
		commands: [],
		tools: [],
		skills: [],
		models: [],
		agents: [],
		userInputs: 0,
		toolCalls: 0,
		toolErrors: 0,
		unresolvedEdits: 0,
		totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		timing: { activeMs: 0, modelMs: 0, toolMs: 0 },
		billed: emptySums(),
		billedRequests: 0,
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
	const declarations: { time: number; names: Set<string> }[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== TURN_ENTRY || !entry.data) continue;
		const turn: TurnData = entry.data;
		turns.set(turn.time, turn);
		for (const [id, path] of Object.entries(turn.paths ?? {})) paths.set(id, path);
		if (turn.declared) declarations.push({ time: turn.time, names: new Set(Object.keys(turn.declared)) });
		analysis.timing.activeMs += turn.activeMs ?? 0;
		analysis.timing.modelMs += turn.ms ?? 0;
		analysis.timing.toolMs += turn.toolMs ?? 0;
	}
	declarations.sort((x, y) => x.time - y.time);
	/** Whether the request made at `time` declared the tool. Undefined before the first recorded declarations. */
	const declaredThen = (name: string, time: number) => declarations.findLast((record) => record.time <= time)?.names.has(name);
	const tool = (name: string) => {
		let rec = tools.get(name);
		if (!rec) {
			rec = { name, calls: 0, nested: 0, errors: 0, callTokens: 0, resultTokens: 0, undeclared: 0, unchecked: 0 };
			tools.set(name, rec);
		}
		return rec;
	};
	const models = new Map<string, ModelRec>();
	/** Cost per cache-read token, by model. */
	const readRates = new Map<string, number>();
	/** Models that have used the prompt cache on this branch. */
	const caching = new Set<string>();
	/** Models that have written to the cache with the long retention. */
	const longCache = new Set<string>();
	/** The last request whose context a later request can read from the cache. */
	let cached: RequestRec | undefined;
	/** The human input whose work the entries now belong to. */
	let input: InputRec | undefined;
	const inputAt = (time: number, preview: string) => {
		const rec: InputRec = { n: analysis.inputs.length + 1, time, preview, first: -1, requests: 0, toolCalls: 0, sent: 0, output: 0, cost: 0, ms: 0 };
		analysis.inputs.push(rec);
		return rec;
	};
	const recordCall = (call: { id: string; name: string; arguments?: any }, time: number, nestedStatus?: string) => {
		analysis.toolCalls++;
		if (input) input.toolCalls++;
		const rec = tool(call.name);
		if (nestedStatus) {
			rec.nested++;
			if (nestedStatus === "error") rec.errors++;
		} else {
			rec.calls++;
			rec.callTokens += estimate(call.name.length + JSON.stringify(call.arguments ?? {}).length);
			const known = declaredThen(call.name, time);
			if (known === false) rec.undeclared++;
			else if (known === undefined) rec.unchecked++;
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
			// The compacted context is new to the cache; the next request is not a miss.
			cached = undefined;
			analysis.cacheUntil = undefined;
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
		if (m.role === "user") {
			analysis.userInputs++;
			input = inputAt(time, contentText(m.content).slice(0, 480).replace(/\s+/g, " ").trim().slice(0, 120));
		} else if (input && (m.role === "assistant" || m.role === "toolResult")) input.ms = Math.max(input.ms, (entryTime || time) - input.time);
		if (m.role === "bashExecution") {
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
			const request: RequestRec = {
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
			};
			analysis.requests.push(request);
			input ??= inputAt(time, "");
			if (input.first < 0) input.first = request.n - 1;
			input.requests++;
			input.sent += request.context;
			input.output += request.output;
			input.cost += request.cost;
			const estimated = turn?.sums ? CATEGORIES.reduce((sum, cat) => sum + (turn.sums[cat] ?? 0), 0) : 0;
			if (turn && estimated > 0 && request.context > 0) {
				for (const cat of CATEGORIES) analysis.billed[cat] += ((turn.sums[cat] ?? 0) * request.context) / estimated;
				analysis.billedRequests++;
			}
			const model = models.get(request.model) ?? { model: request.model, requests: 0, sent: 0, output: 0, cost: 0 };
			model.requests++;
			model.sent += request.context;
			model.output += request.output;
			model.cost += request.cost;
			models.set(request.model, model);
			if (request.cacheRead > 0 && usage.cost?.cacheRead > 0) readRates.set(request.model, usage.cost.cacheRead / request.cacheRead);
			if (request.cacheRead + request.cacheWrite > 0) caching.add(request.model);
			if (usage.cacheWrite1h > 0) longCache.add(request.model);
			if (request.context > 0) {
				if (
					cached &&
					cached.model === request.model &&
					caching.has(request.model) &&
					cached.context >= MIN_CACHED_TOKENS &&
					request.cacheRead < cached.context / 2
				) {
					const tokens = cached.context - request.cacheRead;
					const paidTokens = request.input + request.cacheWrite;
					const rate = paidTokens > 0 ? ((usage.cost?.input ?? 0) + (usage.cost?.cacheWrite ?? 0)) / paidTokens : 0;
					request.miss = {
						tokens,
						cost: tokens * Math.max(0, rate - (readRates.get(request.model) ?? 0)),
						idleMs: time - cached.time,
					};
				}
				cached = request;
				analysis.cacheUntil = caching.has(request.model) ? time + (longCache.has(request.model) ? LONG_CACHE_MS : CACHE_MS) : undefined;
			}
			for (const call of Array.isArray(m.content) ? m.content : []) {
				if (call?.type === "toolCall") recordCall(call, time);
			}
		}
	}
	analysis.files = [...files.values()];
	analysis.tools = [...tools.values()];
	analysis.skills = [...skills.values()];
	analysis.models = [...models.values()];
	analysis.agents = [...agents.values()];
	return analysis;
}
/** Prompt cache use over the requests of the branch. */
export function cacheStats(analysis: Analysis): { rate: number; misses: number; tokens: number; cost: number } {
	let sent = 0;
	let read = 0;
	const stats = { rate: 0, misses: 0, tokens: 0, cost: 0 };
	for (const request of analysis.requests) {
		sent += request.context;
		read += request.cacheRead;
		if (!request.miss) continue;
		stats.misses++;
		stats.tokens += request.miss.tokens;
		stats.cost += request.miss.cost;
	}
	stats.rate = sent > 0 ? read / sent : 0;
	return stats;
}