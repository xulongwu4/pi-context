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

/** Something that entered the context between two requests. */
export interface AddedRec {
	label: string;
	/** Estimated size. */
	tokens: number;
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
	/** What entered the context since the request before. */
	added: AddedRec[];
	/** What the model answered: the start of its text, and the names of the tools that it called. */
	reply: string;
	calls: string[];
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
	/** Requests made before the event. */
	after: number;
	/** For an injection: the extension message type or the skill that put content into the context. */
	producer?: string;
	/** Tokens that the event added to the context, or took from it when negative. Undefined when the event changes no size or the size is not known. */
	delta?: number;
}

/** One read, write or edit of a file. */
export interface FileOp {
	time: number;
	op: "reads" | "writes" | "edits";
	tool: string;
	/** Number of the request that made the call. */
	request: number;
	/** Tool call whose result tells the outcome. For a nested call, the call that made it. */
	id: string;
	/** Lines the write or edit added and removed, when they are known. */
	added?: number;
	removed?: number;
	error?: boolean;
}

export interface FileRec {
	path: string;
	reads: number;
	writes: number;
	edits: number;
	/** Lines added and removed by the writes and edits whose lines are known. */
	added: number;
	removed: number;
	ops: FileOp[];
}

export interface CommandRec {
	time: number;
	command: string;
	program: string;
	/** Requests made before the command ran: the number of the request that ran it, for a command of the model. */
	request: number;
	/** Tool call whose result tells the outcome. For a nested call, the call that made it. Undefined for a command of the user. */
	id?: string;
	/** Wall time, when the session tells it. */
	ms?: number;
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

/** Session entry type that lists the tool calls whose results the user dropped. The last entry on the branch applies. */
export const PRUNE_ENTRY = "pi-context:prune";

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
	/** Tool call id to the lines an edit added and removed, counted in the diff of its result. */
	lines?: Record<string, [number, number]>;
	/** Tool declarations the request carried, when they differ from the last record: name to size in characters. */
	declared?: Record<string, number>;
	/** Who provides each of those tools. Written with `declared`. See {@link toolSource}. */
	sources?: Record<string, string>;
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
	/** Schemas of those tools: name to estimated tokens. */
	schemas: Record<string, number>;
	/** Who provides each known tool. See {@link toolSource}. */
	sources: Record<string, string>;
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

/** The list of the available skills in a system prompt, with the lines that introduce it. */
const SKILL_CATALOG = /(?:The following skills provide[^<]*)?<(available_skills|skills)>[\s\S]*?<\/\1>/;

/** The skill that a `/skill:name` input loads: pi puts its file before the text of the user. */
export function skillBlock(text: string): { block: string; name: string; path: string; rest: string } | undefined {
	const found = /^(<skill name="([^"]+)" location="([^"]+)">\n[\s\S]*?\n<\/skill>)(?:\n\n([\s\S]+))?$/.exec(text);
	return found ? { block: found[1], name: found[2], path: found[3], rest: found[4] ?? "" } : undefined;
}

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

function recorded<K extends "declared" | "sources">(entries: any[], key: K): TurnData[K] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === TURN_ENTRY && entry.data?.[key]) return entry.data[key];
	}
	return undefined;
}

/** The tool declarations pi-context last recorded on the branch. */
export const recordedDeclarations = (entries: any[]) => recorded(entries, "declared");

/** Who provided the tools that pi-context last recorded on the branch. */
export const recordedSources = (entries: any[]) => recorded(entries, "sources");

/**
 * Who provides a tool: `mcp:<server>` for a tool of an MCP server, `pi` for a built-in tool,
 * the package of an extension (such as `npm:name`), or the name of an extension file.
 * `info` is what pi tells about the tool; without it, only the name of an MCP tool tells.
 */
export function toolSource(name: string, info?: { source?: string; path?: string }): string {
	const server = /^mcp__(.+?)__/.exec(name)?.[1];
	if (server) return `mcp:${server}`;
	const source = info?.source ?? "";
	if (source === "builtin") return "pi";
	if (source !== "local" && source !== "auto") return source;
	// An extension outside a package: the name of its file, or of its directory.
	const parts = (info?.path ?? "").split(/[\\/]/).filter(Boolean);
	const file = (parts.pop() ?? "").replace(/\.[^.]+$/, "");
	return (file === "index" ? parts.pop() : file) || source;
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

const newTool = (name: string): ToolRec => ({ name, calls: 0, nested: 0, errors: 0, callTokens: 0, resultTokens: 0, undeclared: 0, unchecked: 0 });

/** A tool with its calls, the estimated tokens of its schema (0 when it is not declared now), and who provides it. */
export interface ToolRow extends ToolRec {
	schema: number;
	source: string;
}

export const TOOL_ORDERS = ["calls", "schema", "name"] as const;
export type ToolOrder = (typeof TOOL_ORDERS)[number];

/** The tools that were called or are declared now, most called first, or largest schema first, or by name. */
export function toolRows(tools: ToolRec[], schemas: Record<string, number>, sources: Record<string, string>, order: ToolOrder = "calls"): ToolRow[] {
	const names = new Set([...tools.map((tool) => tool.name), ...Object.keys(schemas)]);
	const rows = [...names].map((name) => ({
		...(tools.find((tool) => tool.name === name) ?? newTool(name)),
		schema: schemas[name] ?? 0,
		source: sources[name] ?? toolSource(name),
	}));
	const used = (row: ToolRow) => row.calls + row.nested;
	const byName = (a: ToolRow, b: ToolRow) => a.name.localeCompare(b.name);
	if (order === "name") return rows.sort(byName);
	if (order === "schema") return rows.sort((a, b) => b.schema - a.schema || used(b) - used(a) || byName(a, b));
	return rows.sort((a, b) => used(b) - used(a) || b.schema - a.schema || byName(a, b));
}

/** The declared tool schemas by who provides the tools, largest first. */
export function schemaSources(schemas: Record<string, number>, sources: Record<string, string>): { source: string; tools: number; tokens: number }[] {
	const groups = new Map<string, { source: string; tools: number; tokens: number }>();
	for (const [name, tokens] of Object.entries(schemas)) {
		const source = sources[name] ?? toolSource(name);
		const group = groups.get(source) ?? { source, tools: 0, tokens: 0 };
		group.tools++;
		group.tokens += tokens;
		groups.set(source, group);
	}
	return [...groups.values()].sort((a, b) => b.tokens - a.tokens);
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
 * With `full`, each row also carries its whole content. `sources` tells who provides each tool; the content of the tool schemas names it.
 */
export function rowsOf(messages: any[], declared?: Record<string, number>, hidden: string[] = [], full = false, sources: Record<string, string> = {}): Row[] {
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
			case "user": {
				const skill = skillBlock(contentText(m.content));
				if (skill) push("skills", skill.block.length, `skill ${skill.name}`, skill.block);
				push("user", contentChars(m.content) - (skill?.block.length ?? 0), "user", skill ? skill.rest : contentText(m.content));
				break;
			}
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
	// The skill catalog is part of the system prompt, but it counts as a skill injection.
	let catalog = "";
	const cut = (text: string) =>
		text.replace(SKILL_CATALOG, (found) => {
			catalog += found;
			return "";
		});
	systemText = cut(systemText);
	systemChars -= catalog.length;
	for (const [name, text] of sections) {
		const rest = cut(text);
		if (rest) sections.set(name, rest);
		else sections.delete(name);
	}
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
	push("skills", catalog.length, "skill catalog", catalog);
	push(
		"tools",
		schemaChars,
		`${schemas.size} tool schemas`,
		[...schemas.keys()].join(", "),
		full
			? [...schemas]
					.sort((x, y) => y[1] - x[1])
					.map(([name, chars]) => `≈${fmtTokens(estimate(chars)).padStart(6)}  ${name}  ${sources[name] ?? toolSource(name)}`.trimEnd())
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

/** One bar of the trend. */
export interface TrendBar {
	/** Index in `requests` of the request that the bar shows: the request itself, or the last request of the human input. */
	index: number;
	/** Number of the request, or of the human input. */
	n: number;
	/** Tokens that the request sent, or their change since the bar before. */
	value: number;
	/** `value` by category. Undefined when pi-context has no record of the composition. */
	parts?: Record<Category, number>;
}

/**
 * The bars of the trend: one for each request, or with `byTurn` one for each human input that caused a request.
 * With `delta`, a bar is the change since the bar before it.
 */
export function trendBars(analysis: Analysis, byTurn: boolean, delta: boolean): TrendBar[] {
	const { requests } = analysis;
	const picked = byTurn
		? analysis.inputs.filter((input) => input.requests > 0).map((input) => ({ index: input.first + input.requests - 1, n: input.n }))
		: requests.map((request, index) => ({ index, n: request.n }));
	/** The recorded composition of the request, scaled to the size the provider reported. */
	const scaled = ({ sums, context }: RequestRec) => {
		const total = sums ? CATEGORIES.reduce((sum, cat) => sum + (sums[cat] ?? 0), 0) : 0;
		if (!sums || total <= 0) return undefined;
		const parts = emptySums();
		for (const cat of CATEGORIES) parts[cat] = ((sums[cat] ?? 0) * context) / total;
		return parts;
	};
	return picked.map(({ index, n }, i) => {
		const before = delta && i > 0 ? requests[picked[i - 1].index] : undefined;
		const base = before && scaled(before);
		let parts = scaled(requests[index]);
		if (before && !base) parts = undefined;
		if (parts && base) for (const cat of CATEGORIES) parts[cat] -= base[cat];
		const bar: TrendBar = { index, n, value: requests[index].context - (before?.context ?? 0) };
		if (parts) bar.parts = parts;
		return bar;
	});
}

/** What one request did, in three lines. */
export interface Brief {
	/** Index in `requests` of the first request of the human input. */
	first?: number;
	/** The human input that the request works on. */
	user: string;
	/** What entered the context since the request before. */
	added: string;
	/** What the model answered: the tools that it called and the start of its text. */
	reply: string;
}

/**
 * Tells what the request at `index` did. With `byTurn`, tells what the human input did up to that request:
 * all that entered the context and all the tools called since its first request.
 */
export function briefOf(analysis: Analysis, index: number, byTurn = false): Brief | undefined {
	const request = analysis.requests[index];
	if (!request) return undefined;
	const input = analysis.inputs.findLast((rec) => rec.first >= 0 && rec.first <= index);
	const covered = analysis.requests.slice(byTurn && input ? input.first : index, index + 1);
	const counted = (names: string[]) => {
		const counts = new Map<string, number>();
		for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
		return [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
	};
	const sizes = new Map<string, number>();
	for (const item of covered.flatMap((rec) => rec.added)) sizes.set(item.label, (sizes.get(item.label) ?? 0) + item.tokens);
	const added = counted(covered.flatMap((rec) => rec.added.map((item) => item.label)));
	const calls = counted(covered.flatMap((rec) => rec.calls)).join(", ");
	return {
		first: input?.first,
		user: input ? `#${input.n} ${input.preview}`.trim() : "",
		added: [...sizes.values()].map((tokens, i) => `${added[i]} ≈${fmtTokens(tokens)}`).join(" · ") || "nothing",
		reply: [calls && `calls ${calls}`, request.reply].filter(Boolean).join(" · ") || `nothing (${request.stop})`,
	};
}

/** The kinds of the events with the number of events of each, in the order in which they first occur. */
export function eventKinds(events: EventRec[]): [string, number][] {
	const counts = new Map<string, number>();
	for (const event of events) counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
	return [...counts];
}

/** The injections summed by producer, largest first. */
export function injectors(events: EventRec[]): { producer: string; count: number; tokens: number }[] {
	const sums = new Map<string, { producer: string; count: number; tokens: number }>();
	for (const event of events) {
		if (event.producer === undefined) continue;
		const sum = sums.get(event.producer) ?? { producer: event.producer, count: 0, tokens: 0 };
		sum.count++;
		sum.tokens += event.delta ?? 0;
		sums.set(event.producer, sum);
	}
	return [...sums.values()].sort((a, b) => b.tokens - a.tokens);
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

/** Lines that a diff adds and removes. */
export function diffLines(diff: string): [number, number] {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (/^\+(?!\+\+ )/.test(line)) added++;
		else if (/^-(?!-- )/.test(line)) removed++;
	}
	return [added, removed];
}

/** Lines that a write or an edit adds and removes, as far as its arguments tell. A write counts its whole content as added. */
export function argLines(args: any): [number, number] | undefined {
	const lines = (text: string) => (text ? text.replace(/\n$/, "").split("\n") : []);
	if (typeof args?.content === "string") return [lines(args.content).length, 0];
	let change: [number, number] | undefined;
	for (const edit of Array.isArray(args?.edits) ? args.edits : [args]) {
		if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") continue;
		const before = lines(edit.oldText);
		const after = lines(edit.newText);
		// The lines that both texts start and end with are context.
		let start = 0;
		while (start < before.length && start < after.length && before[start] === after[start]) start++;
		let end = 0;
		while (end < before.length - start && end < after.length - start && before.at(-1 - end) === after.at(-1 - end)) end++;
		change ??= [0, 0];
		change[0] += after.length - start - end;
		change[1] += before.length - start - end;
	}
	return change;
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
	const lines = new Map<string, [number, number]>();
	/** File operations of direct calls, until their result tells the outcome. */
	const opsById = new Map<string, FileOp>();
	const declarations: { time: number; names: Set<string> }[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== TURN_ENTRY || !entry.data) continue;
		const turn: TurnData = entry.data;
		turns.set(turn.time, turn);
		for (const [id, path] of Object.entries(turn.paths ?? {})) paths.set(id, path);
		for (const [id, change] of Object.entries(turn.lines ?? {})) lines.set(id, change);
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
			rec = newTool(name);
			tools.set(name, rec);
		}
		return rec;
	};
	const models = new Map<string, ModelRec>();
	/** Estimated size of each tool result, by tool call id. */
	const resultTokens = new Map<string, number>();
	/** Tool calls whose results are dropped, as of the entry being read. */
	let dropped = new Set<string>();
	/** The last compaction, until the request after it shows what it left. */
	let compacted: { event: EventRec; before: number } | undefined;
	/** Cost per cache-read token, by model. */
	const readRates = new Map<string, number>();
	/** Models that have used the prompt cache on this branch. */
	const caching = new Set<string>();
	/** Models that have written to the cache with the long retention. */
	const longCache = new Set<string>();
	/** The last request whose context a later request can read from the cache. */
	let cached: RequestRec | undefined;
	/** What entered the context since the last request. */
	let added: AddedRec[] = [];
	const add = (label: string, chars: number) => added.push({ label, tokens: estimate(chars) });
	const preview = (text: string) => text.slice(0, 480).replace(/\s+/g, " ").trim().slice(0, 120);
	/** The human input whose work the entries now belong to. */
	let input: InputRec | undefined;
	const inputAt = (time: number, preview: string) => {
		const rec: InputRec = { n: analysis.inputs.length + 1, time, preview, first: -1, requests: 0, toolCalls: 0, sent: 0, output: 0, cost: 0, ms: 0 };
		analysis.inputs.push(rec);
		return rec;
	};
	const loadSkill = (path: string) => {
		const skill = skills.get(path) ?? { path, name: path.split("/").at(-2) ?? path, loads: 0, tokens: 0 };
		skill.loads++;
		skills.set(path, skill);
		return skill;
	};
	/** Counts a tool call. A call nested in the result of another one comes with its status and the id of that other call. */
	const recordCall = (call: { id: string; name: string; arguments?: any; durationMs?: number }, time: number, nestedStatus?: string, outer?: string) => {
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
			const file = files.get(path) ?? { path, reads: 0, writes: 0, edits: 0, added: 0, removed: 0, ops: [] };
			file[op]++;
			const rec: FileOp = { time, op, tool: call.name, request: analysis.requests.length, id: outer ?? call.id };
			if (nestedStatus === "error") rec.error = true;
			const change = op === "reads" || rec.error ? undefined : (lines.get(call.id) ?? argLines(call.arguments));
			// A write does not tell what it replaced.
			if (change && op === "writes") rec.added = change[0];
			else if (change) [rec.added, rec.removed] = change;
			file.ops.push(rec);
			if (!nestedStatus) opsById.set(call.id, rec);
			files.set(path, file);
		} else if (op === "edits" && nestedStatus !== "error" && hasAnchor(call.arguments)) analysis.unresolvedEdits++;
		if (path && isSkillRead(call)) skillsById.set(call.id, loadSkill(path));
		if (call.name === "bash" && typeof call.arguments?.command === "string") {
			const command: CommandRec = {
				time,
				command: call.arguments.command,
				program: programOf(call.arguments.command),
				request: analysis.requests.length,
				id: outer ?? call.id,
			};
			if (typeof call.durationMs === "number") command.ms = call.durationMs;
			commandsById.set(call.id, command);
			analysis.commands.push(command);
		}
	};
	for (const entry of entries) {
		const entryTime = Date.parse(entry.timestamp) || 0;
		const event = (kind: string, detail: string, delta?: number) => {
			const rec: EventRec = { time: entryTime, kind, detail, after: analysis.requests.length };
			if (delta !== undefined) rec.delta = delta;
			analysis.events.push(rec);
			return rec;
		};
		/** Content that an extension or a skill put into the context. */
		const inject = (producer: string, chars: number) => {
			event("injection", `${producer}, ≈${fmtTokens(estimate(chars))} tokens`, estimate(chars)).producer = producer;
		};
		if (entry.type === "compaction") {
			const rec = event("compaction", `${fmtTokens(entry.tokensBefore)} tokens before compaction`);
			compacted = typeof entry.tokensBefore === "number" ? { event: rec, before: entry.tokensBefore } : undefined;
			// The compacted context is new to the cache; the next request is not a miss.
			cached = undefined;
			analysis.cacheUntil = undefined;
			addUsage(analysis.totals, entry.usage);
			add("compaction summary", entry.summary?.length ?? 0);
		} else if (entry.type === "model_change") event("model", `${entry.provider}/${entry.modelId}`);
		else if (entry.type === "thinking_level_change") event("thinking", String(entry.thinkingLevel));
		else if (entry.type === "branch_summary") {
			const tokens = estimate(entry.summary?.length ?? 0);
			event("branch summary", `${fmtTokens(tokens)} tokens`, tokens);
			add("branch summary", entry.summary?.length ?? 0);
		} else if (entry.type === "custom" && entry.customType === PRUNE_ENTRY) {
			const ids = new Set<string>(Array.isArray(entry.data?.ids) ? entry.data.ids : []);
			const change = (kind: string, list: string[], sign: number) => {
				if (list.length === 0) return;
				const tokens = list.reduce((sum, id) => sum + (resultTokens.get(id) ?? 0), 0);
				event(kind, `${list.length} tool ${list.length === 1 ? "result" : "results"}, ≈${fmtTokens(tokens)} tokens`, sign * tokens);
			};
			change(
				"drop",
				[...ids].filter((id) => !dropped.has(id)),
				-1,
			);
			change(
				"restore",
				[...dropped].filter((id) => !ids.has(id)),
				1,
			);
			dropped = ids;
		} else if (entry.type === "usage") addUsage(analysis.totals, entry.usage);
		else if (entry.type === "custom" && entry.customType === "subagents:record" && typeof entry.data?.id === "string") {
			const { id, type, description, status, startedAt, completedAt, sessionFile, error } = entry.data;
			agents.set(id, { id, type, description, status, startedAt, completedAt, sessionFile, error });
		}
		if (entry.type === "custom_message") {
			add(entry.customType ?? "custom", contentChars(entry.content));
			inject(entry.customType ?? "custom", contentChars(entry.content));
		}
		if (entry.type !== "message") continue;

		const m = entry.message;
		const time = m.timestamp ?? entryTime;
		if (m.role === "user") {
			analysis.userInputs++;
			const skill = skillBlock(contentText(m.content));
			if (skill) {
				loadSkill(skill.path).tokens = estimate(skill.block.length);
				add(`skill ${skill.name}`, skill.block.length);
				inject(`skill ${skill.name}`, skill.block.length);
			}
			if (!skill || skill.rest) add("user message", skill ? skill.rest.length : contentChars(m.content));
			input = inputAt(time, preview(skill ? `/skill:${skill.name} ${skill.rest}` : contentText(m.content)));
		} else if (input && (m.role === "assistant" || m.role === "toolResult")) input.ms = Math.max(input.ms, (entryTime || time) - input.time);
		if (m.role === "bashExecution") {
			analysis.commands.push({ time, command: m.command, program: programOf(m.command), request: analysis.requests.length, ok: m.exitCode === 0 });
			if (!m.excludeFromContext) add("bash", (m.command?.length ?? 0) + (m.output?.length ?? 0));
		} else if (m.role === "toolResult") {
			const rec = tool(m.toolName);
			rec.resultTokens += estimate(contentChars(m.content));
			resultTokens.set(m.toolCallId, estimate(contentChars(m.content)));
			add(`result ${m.toolName}`, contentChars(m.content));
			if (m.isError) {
				analysis.toolErrors++;
				rec.errors++;
			}
			addUsage(analysis.totals, m.usage);
			const op = opsById.get(m.toolCallId);
			if (op && m.isError) {
				op.error = true;
				op.added = op.removed = undefined;
			} else if (op && op.op !== "reads" && typeof m.details?.diff === "string") [op.added, op.removed] = diffLines(m.details.diff);
			const command = commandsById.get(m.toolCallId);
			if (command) {
				command.ok = !m.isError;
				if (typeof m.durationMs === "number") command.ms = m.durationMs;
			}
			const skill = skillsById.get(m.toolCallId);
			if (skill) {
				skill.tokens = estimate(contentChars(m.content));
				inject(`skill ${skill.name}`, contentChars(m.content));
			}
			// Calls that this tool made to other tools (for example from a script).
			for (const nested of m.nestedCalls?.calls ?? []) {
				recordCall(nested, time, nested.status ?? "ok", m.toolCallId);
				if (nested.status === "error") analysis.toolErrors++;
				const nestedCommand = commandsById.get(nested.id);
				if (nestedCommand && nested.status !== "unfinished") nestedCommand.ok = nested.status === "ok";
			}
		} else if (m.role === "assistant") {
			const usage = m.usage ?? {};
			const turn = turns.get(time);
			const parts: any[] = Array.isArray(m.content) ? m.content : [];
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
				added,
				reply: preview(parts.filter((part) => part?.type === "text").map((part) => part.text ?? "").join(" ")),
				calls: parts.filter((part) => part?.type === "toolCall").map((part) => part.name),
				parentId: entry.parentId,
				sums: turn?.sums,
				ms: turn?.ms,
			};
			analysis.requests.push(request);
			added = [];
			if (compacted) {
				compacted.event.delta = request.context - compacted.before;
				compacted = undefined;
			}
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
			for (const call of parts) {
				if (call?.type === "toolCall") recordCall(call, time);
			}
		}
	}
	analysis.files = [...files.values()];
	for (const file of analysis.files) {
		for (const op of file.ops) {
			file.added += op.added ?? 0;
			file.removed += op.removed ?? 0;
		}
	}
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