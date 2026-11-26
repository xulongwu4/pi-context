import { Buffer } from "node:buffer";
import type { Config } from "./config.ts";
import type { FleetEvent, TaskRec } from "./fleet.ts";
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
	/** Tool call id, for a tool call. */
	call?: string;
	/** Set for a tool result that is an error. */
	error?: boolean;
	/** The images of the message, in order. */
	images?: ImageRec[];
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
	/** Wall time of the turn: the request and the tools it ran, without the time that tools waited for an answer of the user. From the same record. */
	activeMs?: number;
	/** Time from the start of the request to the first token of the reply, when pi-context timed the stream. */
	ttft?: number;
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
	/** Time from the input to the last message it caused, without `waitMs`. */
	ms: number;
	/** Time that tools spent waiting for an answer of the user. Undefined when no tool asked. */
	waitMs?: number;
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
	/** For a compaction: the messages that its summary replaced. */
	replaced?: number;
	/** For a compaction: the estimated tokens of those messages. */
	removed?: number;
}

/** The kinds of file operations. A search counts on each file it found, or on the searched path. */
export const FILE_KINDS = ["reads", "writes", "edits", "searches", "images"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** One read, write, edit or search of a file. */
export interface FileOp {
	time: number;
	op: FileKind;
	tool: string;
	/** Number of the request that made the call. */
	request: number;
	/** Tool call whose result tells the outcome. For a nested call, the call that made it. */
	id: string;
	/** Lines the write or edit added and removed, when they are known. */
	added?: number;
	removed?: number;
	error?: boolean;
	/** Matches of the search in the file. Undefined when the session does not tell them. */
	hits?: number;
	/** For a read of a part of the file: its first line and its number of lines; 0 lines when the read names no limit. */
	range?: [number, number];
}

export interface FileRec {
	path: string;
	reads: number;
	writes: number;
	edits: number;
	searches: number;
	images: number;
	/** Lines added and removed by the writes and edits whose lines are known. */
	added: number;
	removed: number;
	ops: FileOp[];
}

export interface CommandRec {
	time: number;
	command: string;
	program: string;
	/** Every program that the command runs, in order. See {@link programsOf}. */
	programs: string[];
	/** Exit code, when the command ended with one that is not 0. */
	exit?: number;
	/** Set when the command did not end by itself: it ran into its timeout, or it was aborted. */
	stopped?: "timeout" | "aborted";
	/** Whether pi cut the output for the model. */
	truncated?: boolean;
	/** Lines that the command printed. */
	lines?: number;
	/** Characters of the output that the session holds. */
	chars?: number;
	/** Seconds that the call allowed the command to run, when it set a timeout. */
	timeout?: number;
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
	/** Time of the last call. */
	last?: number;
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
	/** Time of the last load. */
	last?: number;
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
	/** Prompt tokens of the agent's last request, and the context window of its model when it is known. */
	context?: number;
	window?: number;
	/** Estimated tokens of the agent's last recorded request, by category. */
	sums?: Record<Category, number>;
	/** How many agents are above it: 0 for an agent of this session. */
	depth?: number;
	/** The final reply. */
	result?: string;
}

export interface Timing {
	activeMs: number;
	modelMs: number;
	toolMs: number;
	/** Sum of the times to the first token, over the requests whose stream pi-context timed. */
	ttftMs: number;
	/** Time that those requests took after their first token, their number, and the tokens they put out. */
	streamMs: number;
	streamed: number;
	streamOutput: number;
	/** Time and number of the blocks of each part of their replies. */
	spans: Record<ReplyKind, [ms: number, blocks: number]>;
}

/** Output tokens per second of the timed streams, after the first token. Undefined when no stream was timed. */
export const tokensPerSecond = (timing: Timing): number | undefined => (timing.streamMs > 0 ? (timing.streamOutput * 1000) / timing.streamMs : undefined);

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
	/** Time from the start of the request to the first token of the reply, and the time and number of the blocks of each part of the reply. Unset when the reply came without stream events. */
	ttft?: number;
	spans?: Partial<Record<ReplyKind, [ms: number, blocks: number]>>;
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
	/** The tool declarations that pi-context recorded, oldest first: name to size in characters, and who provides each tool. */
	declarations: { time: number; declared: Record<string, number>; sources: Record<string, string> }[];
	/** Estimated time at which the prompt cache of the last request expires. Undefined when the model does not cache. */
	cacheUntil?: number;
}

export interface Rates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ToolDoc {
	description?: string;
	params: ParamRec[];
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
	/** Tokens of the window that pi keeps free: before it compacts, and for the reply of the model. */
	reserve?: { compaction?: number; output?: number };
	/** Delegations, messages and completions of the subagents, oldest first. */
	timeline: FleetEvent[];
	/** The tasks of the session's pi-tasks list. */
	tasks: TaskRec[];
	parentSession?: string;
	/** Name of the session, when it is not the current one. Such data is read-only. */
	other?: string;
	/** Prices of the models that made the requests, in dollars for a million tokens. Only the models that pi knows now. */
	rates?: Record<string, Rates>;
	/** The description and the parameters of a tool that pi knows now. */
	toolDoc?: (name: string) => ToolDoc | undefined;
	/** The whole result of the tool call `id`, as the session holds it. */
	resultText?: (id: string) => string | undefined;
	/** Rebuilds the composition of a request that has no snapshot. */
	reconstruct: (request: RequestRec) => Row[];
	/** What {@link reconstruct} rebuilds a request from. With it, the items of many requests are read without rebuilding each request whole. */
	source?: RowSource;
}

export interface RowSource {
	/** The messages that the session tells for the request. */
	messages(request: RequestRec): any[];
	/** The rows of messages, without their content. For system messages alone: the system prompt, the skill catalog and the tool schemas. */
	rows(messages: any[]): Row[];
}

const CHARS_PER_TOKEN = 4;
/** Tokens of an image whose pixels are not known. */
const IMAGE_TOKENS = 1200;
/** The longer side that an image keeps, the pixels of one token, and the most tokens of an image: the rule that Anthropic publishes. */
const IMAGE_SIDE = 1568;
const IMAGE_PIXELS = 750;
const IMAGE_MOST = 1600;
/** Characters of the base64 text that are read to find the pixels of an image: a JPEG can carry metadata before them. */
const IMAGE_HEAD = 87_384;

export const estimate = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

/** An image of a message. */
export interface ImageRec {
	/** Media type, as the session names it. */
	type: string;
	/** Size of the stored image in bytes. */
	bytes: number;
	/** Pixels, when the start of the image tells them. */
	width?: number;
	height?: number;
	/** Estimated tokens. See {@link imageTokens}. */
	tokens: number;
	/** The image as base64. Only rows built for inspection carry it. */
	data?: string;
}

/** Width and height of a PNG, GIF, WebP or JPEG image in pixels, from the start of its base64 text. Undefined when the start does not tell them. */
export function imageSize(data: string): [width: number, height: number] | undefined {
	const bytes = Buffer.from(data.slice(0, IMAGE_HEAD), "base64");
	const ascii = (at: number, length: number) => bytes.toString("latin1", at, at + length);
	if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
	if (bytes.length >= 10 && ascii(0, 3) === "GIF") return [bytes.readUInt16LE(6), bytes.readUInt16LE(8)];
	if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
		const kind = ascii(12, 4);
		if (kind === "VP8 ") return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
		if (kind === "VP8X") return [bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1];
		if (kind !== "VP8L") return undefined;
		const bits = bytes.readUInt32LE(21);
		return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
	}
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
	// A JPEG is a list of segments. The frame segment tells the pixels: its height, then its width.
	for (let at = 2; at + 9 <= bytes.length && bytes[at] === 0xff; ) {
		const marker = bytes[at + 1];
		if (marker === 0xff) at++;
		else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return [bytes.readUInt16BE(at + 7), bytes.readUInt16BE(at + 5)];
		else at += marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9) ? 2 : 2 + bytes.readUInt16BE(at + 2);
	}
	return undefined;
}

/**
 * Estimated tokens of an image of that many pixels: one token for 750 pixels, after the image is reduced to 1568 pixels on its longer side, and 1600 at most.
 * Without the pixels, 1200.
 */
export function imageTokens(width?: number, height?: number): number {
	if (!width || !height) return IMAGE_TOKENS;
	const scale = Math.min(1, IMAGE_SIDE / Math.max(width, height));
	return Math.min(IMAGE_MOST, Math.max(1, Math.ceil((width * scale * (height * scale)) / IMAGE_PIXELS)));
}

/** What was measured of each image block. A block is measured once: a request carries the images of all requests before it. */
const measured = new WeakMap<object, ImageRec>();

function imageOf(block: any): ImageRec {
	let image = measured.get(block);
	if (!image) {
		const data: string = typeof block.data === "string" ? block.data : "";
		const [width, height] = imageSize(data) ?? [];
		const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
		image = { type: typeof block.mimeType === "string" ? block.mimeType : "image", bytes: Math.max(0, Math.floor((data.length * 3) / 4) - padding), tokens: imageTokens(width, height) };
		if (width && height) Object.assign(image, { width, height });
		measured.set(block, image);
	}
	return image;
}

/** The images of a message content, in order. With `full`, each carries its data. */
export function imagesOf(content: unknown, full = false): ImageRec[] {
	if (!Array.isArray(content)) return [];
	return content.filter((block) => block?.type === "image").map((block) => (full ? { ...imageOf(block), data: block.data } : imageOf(block)));
}

/** One line about an image: its type, its pixels, its stored size and its estimated tokens, scaled by `factor`. */
export function imageText(image: ImageRec, factor = 1): string {
	const size = image.bytes >= 1e6 ? `${(image.bytes / 1e6).toFixed(1)} MB` : image.bytes >= 1e3 ? `${(image.bytes / 1e3).toFixed(1)} kB` : `${image.bytes} B`;
	return [image.type, image.width ? `${image.width}×${image.height} px` : "", size, `≈${fmtTokens(image.tokens * factor)} tokens`].filter(Boolean).join(" · ");
}

export function contentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content) chars += block?.type === "image" ? imageOf(block).tokens * CHARS_PER_TOKEN : (block?.text?.length ?? 0);
	return chars;
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block?.type === "image" ? "[image]" : (block?.text ?? ""))).join(" ");
}

/** Characters of a message: its text and images, its reasoning, and the arguments of its tool calls. */
function messageChars(message: any): number {
	let chars = contentChars(message?.content);
	if (!Array.isArray(message?.content)) return chars;
	for (const block of message.content) chars += (block?.thinking?.length ?? 0) + (block?.type === "toolCall" ? JSON.stringify(block.arguments ?? {}).length : 0);
	return chars;
}

/** The text of the result of the tool call `id` among the entries. */
export function resultText(entries: any[], id: string): string | undefined {
	const entry = entries.findLast((each) => each.type === "message" && each.message?.role === "toolResult" && each.message.toolCallId === id);
	return entry && contentText(entry.message.content);
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
	const push = (cat: Category, chars: number, label: string, text: string, content = text, id?: string): Row | undefined => {
		if (chars <= 0) return undefined;
		const row: Row = { cat, tokens: estimate(chars), label, preview: text.slice(0, 640).replace(/\s+/g, " ").trim().slice(0, 160) };
		if (full) row.text = content;
		if (id) row.id = id;
		if (time !== undefined) row.time = time;
		rows.push(row);
		return row;
	};
	// System messages replay in order: later ones append text, and replace or remove sections.
	const sections = new Map<string, string>();
	const skillCalls = new Set<string>();
	/** Gives the row the images of its message. */
	const picture = (row: Row | undefined, content: unknown) => {
		const images = row ? imagesOf(content, full) : [];
		if (row && images.length > 0) row.images = images;
	};
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
				picture(push("user", contentChars(m.content) - (skill?.block.length ?? 0), "user", skill ? skill.rest : contentText(m.content)), m.content);
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
					const row = push("toolCalls", call.name.length + args.length, `call ${call.name}`, args);
					if (row && call.id) row.call = call.id;
				}
				break;
			}
			case "toolResult": {
				const row = push(
					skillCalls.has(m.toolCallId) ? "skills" : "toolResults",
					contentChars(m.content),
					`result ${m.toolName}`,
					contentText(m.content),
					undefined,
					m.toolCallId,
				);
				if (row && m.isError) row.error = true;
				picture(row, m.content);
				break;
			}
			case "bashExecution":
				if (!m.excludeFromContext) {
					push("injected", (m.command?.length ?? 0) + (m.output?.length ?? 0), "bash", m.command ?? "", `${m.command ?? ""}\n${m.output ?? ""}`);
				}
				break;
			case "custom":
				picture(push("injected", contentChars(m.content), m.customType ?? "custom", contentText(m.content)), m.content);
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
export const textOf = (row: Row, index: number, rebuilt: Row[]): string | undefined => fullOf(row, index, rebuilt)?.text;

/** The row that carries the whole content of `row`: the row itself, or the same item among `rebuilt`. */
export function fullOf(row: Row, index: number, rebuilt: Row[]): Row | undefined {
	if (row.text !== undefined) return row;
	const same = (other?: Row) => other?.cat === row.cat && other.label === row.label && other.preview === row.preview;
	const fixed = row.cat === "system" || row.cat === "tools";
	return same(rebuilt[index]) ? rebuilt[index] : (rebuilt.find(same) ?? (fixed ? rebuilt.find((other) => other.cat === row.cat) : undefined));
}

/** A row without its content: its text and the data of its images. */
export function bare({ text, images, ...row }: Row): Row {
	return images ? { ...row, images: images.map(({ data, ...image }) => image) } : row;
}

/** The parts of the replies of the model, as categories. */
export const REPLY_KINDS = ["reasoning", "toolCalls", "answers"] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number];

/** How many rows each part of the replies has. */
export function replyCounts(rows: Row[]): Record<ReplyKind, number> {
	const counts: Record<ReplyKind, number> = { reasoning: 0, toolCalls: 0, answers: 0 };
	for (const row of rows) {
		const kind = REPLY_KINDS.find((each) => each === row.cat);
		if (kind) counts[kind]++;
	}
	return counts;
}

/** The row of the tool call that a tool result answers. */
export const callOf = (row: Row, rows: Row[]) => (row.id ? rows.find((other) => other.call === row.id) : undefined);

/** What the view of a tool result tells about its call. */
export interface CallView {
	tool: string;
	status: "ok" | "error";
	/** Lines of the result. */
	lines: number;
	/** The arguments of the call, when its row is known. */
	args?: string;
}

/** Describes the call of a tool result from the text of the result and the arguments on the row of the call. */
export function callView(row: Row, text: string, argsText?: string): CallView {
	const view: CallView = { tool: row.label.replace(/^result /, ""), status: row.error ? "error" : "ok", lines: text ? text.split("\n").length : 0 };
	if (argsText === undefined) return view;
	try {
		view.args = JSON.stringify(JSON.parse(argsText), null, 2);
	} catch {
		view.args = argsText;
	}
	return view;
}

/**
 * Index of the request that the diff of request `index` compares with: the request before it,
 * or with "input" the last request before the human input that the request belongs to. -1 when there is none.
 */
export function baselineOf(analysis: Analysis, index: number, base: "request" | "input" = "request"): number {
	if (base === "request") return index - 1;
	const input = analysis.inputs.findLast((rec) => rec.requests > 0 && rec.first <= index);
	return input ? input.first - 1 : -1;
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
	/** Recorded duration of the request, or of the requests of the human input. */
	ms?: number;
	/** What happened since the bar before, and what sets the bar apart: some of MARK_KINDS, in their order. */
	marks?: string[];
}

/**
 * What the trend flags on a bar. An event flags the bar after it: a compaction, a drop or restore of tool results, a finished or created task,
 * a question to the user, a delegation, a message of a subagent ("agent"), a loaded skill, a change of model.
 * "longest" flags the bar that took the most time, "growth" the bar whose context grew most since the bar before.
 */
export const MARK_KINDS = ["compaction", "drop", "restore", "task done", "task", "question", "longest", "growth", "delegation", "agent", "skill", "model"] as const;
export type MarkKind = (typeof MARK_KINDS)[number];

/** Types of the messages that pi-subagents puts into the context. */
const AGENT_MESSAGES = ["subagent-notification", "workflow-result"];

/** The flag that an event puts on the bar after it. */
function markOf(event: EventRec): MarkKind | undefined {
	if (event.kind !== "injection") return MARK_KINDS.find((kind) => kind === event.kind);
	if (event.producer?.startsWith("skill ")) return "skill";
	return AGENT_MESSAGES.includes(event.producer ?? "") ? "agent" : undefined;
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
	const bars = picked.map(({ index, n }, i) => {
		const before = delta && i > 0 ? requests[picked[i - 1].index] : undefined;
		const base = before && scaled(before);
		let parts = scaled(requests[index]);
		if (before && !base) parts = undefined;
		if (parts && base) for (const cat of CATEGORIES) parts[cat] -= base[cat];
		const bar: TrendBar = { index, n, value: requests[index].context - (before?.context ?? 0) };
		if (parts) bar.parts = parts;
		const from = i > 0 ? picked[i - 1].index : -1;
		const marks = analysis.events.filter((event) => event.after > from && event.after <= index).flatMap((event) => markOf(event) ?? []);
		if (marks.length > 0) bar.marks = marks;
		const timed = requests.slice(byTurn ? from + 1 : index, index + 1).filter((request) => request.ms !== undefined);
		if (timed.length > 0) bar.ms = timed.reduce((sum, request) => sum + (request.ms ?? 0), 0);
		return bar;
	});
	/** The bar with the highest score above 0; -1 when no bar has one. */
	const top = (score: (i: number) => number) => {
		let best = -1;
		for (let i = 0; i < bars.length; i++) {
			if (score(i) > (best < 0 ? 0 : score(best))) best = i;
		}
		return best;
	};
	const flags: [MarkKind, number][] = [
		["longest", bars.length > 1 ? top((i) => bars[i].ms ?? 0) : -1],
		["growth", top((i) => (i > 0 ? requests[bars[i].index].context - requests[bars[i - 1].index].context : 0))],
	];
	for (const [mark, i] of flags) {
		if (i >= 0) (bars[i].marks ??= []).push(mark);
	}
	for (const bar of bars) {
		if (bar.marks) bar.marks = MARK_KINDS.filter((kind) => bar.marks?.includes(kind));
	}
	return bars;
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

/** Commands that run another command, each with its options that take a value. */
const WRAPPERS = new Map<string, RegExp>([
	["sudo", /^-[ughpCDRT]$/],
	["doas", /^-[uC]$/],
	["env", /^-[uCS]$/],
	["timeout", /^-[ks]$/],
	["nice", /^-n$/],
	["time", /^-[of]$/],
	["exec", /^-a$/],
	["nohup", /^$/],
	["command", /^$/],
	["stdbuf", /^-[ioe]$/],
	["caffeinate", /^-[tw]$/],
	["noglob", /^$/],
	["nocorrect", /^$/],
]);
/** Shell words that a command can follow, and words that start a part without a command. */
const SHELL_PREFIXES = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "{"]);
const SHELL_WORDS = new Set(["for", "case", "select", "function", "fi", "done", "esac", "}"]);

/**
 * Every program that a shell command runs, in order: one for each part of a pipeline or a list.
 * Env assignments, directories, wrappers such as sudo or timeout, the bodies of heredocs and quoted text do not count; `cd` counts only when nothing else runs.
 */
export function programsOf(command: string): string[] {
	const bare = command
		.replace(/((?<!<)<<(?!<)-?\s*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, "$1")
		.replace(/'[^']*'|"(?:\\.|[^"\\$`])*"/g, "''");
	const programs: string[] = [];
	let cd = false;
	for (const segment of bare.split(/&&|\|\||[;|\n]/)) {
		const words = segment
			.trim()
			.split(/\s+/)
			.map((w) => w.replace(/^\w+=\$\(/, "").replace(/^\(+/, ""));
		let i = 0;
		for (; i < words.length; i++) {
			if (!words[i] || /^\w+=/.test(words[i]) || SHELL_PREFIXES.has(words[i])) continue;
			const wrapper = words[i];
			const takesValue = WRAPPERS.get(wrapper);
			if (!takesValue) break;
			while (words[i + 1]?.startsWith("-")) i += takesValue.test(words[i + 1]) ? 2 : 1;
			// The duration.
			if (wrapper === "timeout") i++;
		}
		const program = (words[i] ?? "").split("/").pop() ?? "";
		if (!program || program.startsWith("#") || SHELL_WORDS.has(program)) continue;
		if (program === "cd") cd = true;
		else programs.push(program);
	}
	return programs.length === 0 && cd ? ["cd"] : programs;
}

/** The first program that a shell command runs. See {@link programsOf}. */
export function programOf(command: string): string {
	return programsOf(command)[0] ?? "";
}

const SEARCH_TOOLS = /^(grep|find|glob|rg|ffgrep|fffind)$/i;
const IMAGE_PATH = /\.(png|jpe?g|gif|webp)$/i;
/** Most files that one search is recorded on. */
const MAX_SEARCH_FILES = 100;

/** The kind of file operation a tool makes. A read of a path with an image extension is an image read. */
export function fileOp(toolName: string, path?: string): FileKind | undefined {
	if (toolName === "read") return path && IMAGE_PATH.test(path) ? "images" : "reads";
	if (toolName === "write") return "writes";
	if (/edit|replace|insert|patch/i.test(toolName)) return "edits";
	if (SEARCH_TOOLS.test(toolName)) return "searches";
	return undefined;
}

const hasImage = (content: unknown) => Array.isArray(content) && content.some((block) => block?.type === "image");

/**
 * The files that the result of a search lists, with the matches in each: at most {@link MAX_SEARCH_FILES} files.
 * Reads `path:line:` lines and lines under `=== path ===` headers; for a find or glob tool, one path on each line.
 * Paths are relative to the searched path `base`.
 */
export function searchHits(toolName: string, text: string, base = "."): Map<string, number> {
	const hits = new Map<string, number>();
	const dir = base.replace(/\/+$/, "");
	const resolve = (path: string) => {
		if (/^[/~]/.test(path) || dir === "." || dir === "") return path;
		// A search of one file names the file without its directory.
		return dir === path || dir.endsWith(`/${path}`) ? dir : `${dir}/${path}`;
	};
	const count = (path: string, by: number) => {
		if (hits.has(path) || hits.size < MAX_SEARCH_FILES) hits.set(path, (hits.get(path) ?? 0) + by);
	};
	const byName = /find|glob/i.test(toolName);
	let group: string | undefined;
	for (const line of text.split("\n")) {
		const header = /^=== (.+) ===$/.exec(line);
		if (header) {
			group = resolve(header[1]);
			count(group, 0);
		} else if (group) {
			if (/^\s*\d+:/.test(line)) count(group, 1);
		} else if (byName) {
			if (line.trim() && !/^(\[|No )/.test(line)) count(resolve(line.trim().replace(/\/$/, "")), 1);
		} else {
			const match = /^(.+?):\d+:/.exec(line);
			if (match) count(resolve(match[1]), 1);
		}
	}
	return hits;
}

/** The operations on the files, summed by kind. */
export function fileTotals(files: FileRec[]): Record<FileKind, number> {
	const totals: Record<FileKind, number> = { reads: 0, writes: 0, edits: 0, searches: 0, images: 0 };
	for (const file of files) for (const kind of FILE_KINDS) totals[kind] += file[kind];
	return totals;
}

/** Orders of the file list: {@link fileRows}. */
export const FILE_ORDERS = ["ops", "recent", "name", "file", "lines"] as const;
export type FileOrder = (typeof FILE_ORDERS)[number];

/** The files with the most operations first, the last used first, by path, by file name, or with the most changed lines first. With `kind`, only the files with such operations. */
export function fileRows(files: FileRec[], order: FileOrder = "ops", kind?: FileKind): FileRec[] {
	const rows = kind ? files.filter((file) => file[kind] > 0) : [...files];
	const ops = (file: FileRec) => FILE_KINDS.reduce((sum, each) => sum + file[each], 0);
	const last = (file: FileRec) => file.ops.reduce((time, op) => Math.max(time, op.time), 0);
	if (order === "lines") return rows.sort((a, b) => b.added + b.removed - (a.added + a.removed));
	if (order === "name") return rows.sort((a, b) => a.path.localeCompare(b.path));
	// Files of the same name in several directories come together.
	const name = (file: FileRec) => file.path.slice(file.path.lastIndexOf("/") + 1);
	if (order === "file") return rows.sort((a, b) => name(a).localeCompare(name(b)) || a.path.localeCompare(b.path));
	if (order === "recent") return rows.sort((a, b) => last(b) - last(a));
	return rows.sort((a, b) => ops(b) - ops(a));
}

export const COMMAND_STATUSES = ["ok", "failed", "unknown"] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

/** Whether the command succeeded, failed, or the session does not tell. */
export const commandStatus = (command: CommandRec): CommandStatus => (command.ok === undefined ? "unknown" : command.ok ? "ok" : "failed");

/** Index of the run with the longest wall time; -1 when no run has one. */
export function slowest(commands: CommandRec[]): number {
	let index = -1;
	commands.forEach((command, i) => {
		if (command.ms !== undefined && (index < 0 || command.ms > (commands[index].ms ?? 0))) index = i;
	});
	return index;
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

/** How often the commands ran each program, and in how many commands. The most run first. */
export function programRanks(commands: CommandRec[]): { program: string; uses: number; runs: number }[] {
	const ranks = new Map<string, { program: string; uses: number; runs: number }>();
	for (const command of commands) {
		const seen = new Set<string>();
		for (const program of command.programs) {
			const rank = ranks.get(program) ?? { program, uses: 0, runs: 0 };
			rank.uses++;
			if (!seen.has(program)) rank.runs++;
			seen.add(program);
			ranks.set(program, rank);
		}
	}
	return [...ranks.values()].sort((a, b) => b.uses - a.uses || a.program.localeCompare(b.program));
}

/** The commands that deserve a look. */
export interface Attention {
	/** Index of the run with the longest wall time, when it took a second or more. */
	slowest?: number;
	/** The program whose runs failed most, when two or more failed. */
	failing?: { program: string; count: number };
	/** The command that ran most often, when it ran twice or more. */
	repeated?: { command: string; count: number };
}

export function attentionOf(commands: CommandRec[]): Attention {
	const attention: Attention = {};
	const index = slowest(commands);
	if (index >= 0 && (commands[index].ms ?? 0) >= 1000) attention.slowest = index;
	/** The key that occurs most often, when it occurs twice or more. */
	const most = (keys: string[]) => {
		const counts = new Map<string, number>();
		let best: [key: string, count: number] | undefined;
		for (const key of keys) {
			const count = (counts.get(key) ?? 0) + 1;
			counts.set(key, count);
			if (count >= 2 && count > (best?.[1] ?? 0)) best = [key, count];
		}
		return best;
	};
	const failing = most(commands.filter((command) => command.ok === false).map((command) => command.program));
	if (failing) attention.failing = { program: failing[0], count: failing[1] };
	const repeated = most(commands.map((command) => command.command));
	if (repeated) attention.repeated = { command: repeated[0], count: repeated[1] };
	return attention;
}

/** Whether the run took ten seconds or more. */
export const isSlow = (command: CommandRec): boolean => (command.ms ?? 0) >= 10_000;

/** Which commands to list, and in which order. */
export interface CommandLens {
	status?: CommandStatus;
	/** Only the slow commands. See {@link isSlow}. */
	slow?: boolean;
	/** Only the commands that run the program. */
	program?: string;
	/** Only the commands that contain the text, in any case. */
	text?: string;
	/** The slowest first, instead of the order of the session. A command without a time comes last. */
	slowest?: boolean;
}

/** Indexes of the commands that the lens lets through, in its order. */
export function commandRows(commands: CommandRec[], lens: CommandLens = {}): number[] {
	const text = lens.text?.toLowerCase();
	const rows = commands
		.map((_, index) => index)
		.filter((index) => {
			const command = commands[index];
			if (lens.status && commandStatus(command) !== lens.status) return false;
			if (lens.slow && !isSlow(command)) return false;
			if (lens.program && !command.programs.includes(lens.program)) return false;
			return !text || command.command.toLowerCase().includes(text);
		});
	return lens.slowest ? rows.sort((a, b) => (commands[b].ms ?? -1) - (commands[a].ms ?? -1)) : rows;
}

/** The lens that shows what an entry of the attention list is about. Undefined when the list has no such entry. */
export function attentionLens(attention: Attention, entry: keyof Attention): CommandLens | undefined {
	if (entry === "slowest") return attention.slowest === undefined ? undefined : { slowest: true };
	if (entry === "failing") return attention.failing && { status: "failed", program: attention.failing.program };
	return attention.repeated && { text: attention.repeated.command };
}

const COMMAND_END = /(?:^|\n\n)Command (exited with code (\d+)|timed out after [\s\S]*|aborted|terminated without an exit code)$/;

/** What the result of pi's bash tool tells about the end of the command, and the lines and the characters that the command printed. */
function commandEnd(text: string, details?: any): Pick<CommandRec, "exit" | "stopped" | "truncated" | "lines" | "chars"> {
	const end: Pick<CommandRec, "exit" | "stopped" | "truncated" | "lines" | "chars"> = {};
	const status = COMMAND_END.exec(text);
	if (status?.[2]) end.exit = Number(status[2]);
	else if (status?.[1].startsWith("timed out")) end.stopped = "timeout";
	else if (status?.[1] === "aborted") end.stopped = "aborted";
	const output = (status ? text.slice(0, status.index) : text).trimEnd();
	end.chars = output.length;
	if (details?.truncation?.truncated) end.truncated = true;
	end.lines = end.truncated && typeof details.truncation.totalLines === "number" ? details.truncation.totalLines : output ? output.split("\n").length : 0;
	return end;
}

/** The lines of a command, and whether it holds a heredoc or a script given to an interpreter on the command line. */
export function commandShape(text: string): { lines: number; heredoc: boolean; inline: boolean } {
	return {
		lines: text.split("\n").length,
		heredoc: /(?<!<)<<(?!<)-?\s*['"]?\w/.test(text),
		inline: /(?:^|[\s;|&(])(?:python[\d.]*|node|bun|deno|perl|ruby|bash|sh|zsh)\s+(?:-\w+\s+)*(?:-c|-e|--eval)\s/.test(text),
	};
}

/** The files as they were after request number `request`: only the operations made up to it. */
export function filesUpTo(files: FileRec[], request: number): FileRec[] {
	return files.flatMap((file) => {
		const ops = file.ops.filter((op) => op.request <= request);
		if (ops.length === 0) return [];
		const rec: FileRec = { path: file.path, reads: 0, writes: 0, edits: 0, searches: 0, images: 0, added: 0, removed: 0, ops };
		for (const op of ops) {
			rec[op.op]++;
			rec.added += op.added ?? 0;
			rec.removed += op.removed ?? 0;
		}
		return [rec];
	});
}

/** Tokens and cost of the session's own requests, of its subagents, and of both. */
export function familyTotals(totals: Totals, agents: AgentRec[]) {
	const own = { tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite, cost: totals.cost };
	const sub = { count: agents.length, tokens: 0, cost: 0 };
	for (const agent of agents) {
		sub.tokens += agent.tokens ?? 0;
		sub.cost += agent.cost ?? 0;
	}
	return { own, agents: sub, tokens: own.tokens + sub.tokens, cost: own.cost + sub.cost };
}

/** The human input that the request at `index` belongs to, and its place among the requests of that input. */
export function placeOf(analysis: Analysis, index: number): { input: number; step: number; steps: number } | undefined {
	const input = analysis.inputs.find((each) => each.first >= 0 && index >= each.first && index < each.first + each.requests);
	return input && { input: input.n, step: index - input.first + 1, steps: input.requests };
}

/** The place of every request. See {@link placeOf}. */
export const places = (analysis: Analysis) => analysis.requests.map((_, index) => placeOf(analysis, index));

/** A tool that a request declared: the estimated tokens of its schema, who provides it, and how often the request called it. */
export interface DeclaredTool {
	name: string;
	tokens: number;
	source: string;
	calls: number;
}

/** The tools that the request at `index` declared, the largest schema first. Empty when pi-context recorded no declarations for it. */
export function toolsAt(analysis: Analysis, index: number): DeclaredTool[] {
	const request = analysis.requests[index];
	const record = request && analysis.declarations.findLast((each) => each.time <= request.time);
	if (!record) return [];
	return Object.entries(record.declared)
		.map(([name, chars]) => ({ name, tokens: estimate(chars), source: record.sources[name] ?? toolSource(name), calls: request.calls.filter((call) => call === name).length }))
		.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
}

/** One parameter of a tool. */
export interface ParamRec {
	name: string;
	type: string;
	required: boolean;
	description: string;
}

function schemaType(schema: any): string {
	if (!schema || typeof schema !== "object") return "any";
	const options = schema.anyOf ?? schema.oneOf;
	if (Array.isArray(options)) return options.map(schemaType).join(" | ");
	if (Array.isArray(schema.enum)) return `${schema.type ?? "string"} (enum)`;
	if (schema.const !== undefined) return JSON.stringify(schema.const);
	if (Array.isArray(schema.type)) return schema.type.join(" | ");
	if (schema.type === "array") return schema.items ? `array<${schemaType(schema.items)}>` : "array";
	if (schema.type === "object" && schema.properties) return `object{${Object.keys(schema.properties).length}}`;
	return typeof schema.type === "string" ? schema.type : "any";
}

/** The parameters of a tool, from its JSON schema or from a declaration that holds the schema. */
export function paramsOf(declaration: any): ParamRec[] {
	const schema = declaration?.input_schema ?? declaration?.function?.parameters ?? declaration?.parameters ?? declaration;
	const required = new Set<string>(Array.isArray(schema?.required) ? schema.required : []);
	return Object.entries<any>(schema?.properties ?? {}).map(([name, param]) => ({
		name,
		type: schemaType(param),
		required: required.has(name),
		description: typeof param?.description === "string" ? param.description : "",
	}));
}

/** Whether the tool asks the user a question and waits for the answer. */
const isQuestion = (name: string) => /^(ask_user_question|AskUserQuestion|questionnaire)$/.test(name);

/** The event that a call of a workflow tool makes: a question to the user, a delegation, or a task that is created or finished. */
function workflowEvent(call: { name: string; arguments?: any }): [kind: string, detail: string] | undefined {
	const args = call.arguments ?? {};
	if (isQuestion(call.name)) {
		const questions: any[] = Array.isArray(args.questions) ? args.questions : [args];
		const first = String(questions[0]?.question ?? "");
		return ["question", questions.length > 1 ? `${questions.length} questions: ${first}` : first];
	}
	if (call.name === "Agent") return ["delegation", `${args.subagent_type ?? "agent"}: ${args.description ?? ""}`];
	if (call.name === "TaskCreate") return ["task", String(args.subject ?? "")];
	if (call.name === "TaskUpdate" && args.status === "completed") return ["task done", `#${args.taskId}`];
	return undefined;
}
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
		timing: { activeMs: 0, modelMs: 0, toolMs: 0, ttftMs: 0, streamMs: 0, streamed: 0, streamOutput: 0, spans: { reasoning: [0, 0], toolCalls: [0, 0], answers: [0, 0] } },
		declarations: [],
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
	const opsById = new Map<string, { op: FileOp; path: string }>();
	const fileAt = (path: string) => {
		let file = files.get(path);
		if (!file) {
			file = { path, reads: 0, writes: 0, edits: 0, searches: 0, images: 0, added: 0, removed: 0, ops: [] };
			files.set(path, file);
		}
		return file;
	};
	const addOp = (path: string, op: FileOp) => {
		const file = fileAt(path);
		file[op.op]++;
		file.ops.push(op);
	};
	const { declarations } = analysis;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== TURN_ENTRY || !entry.data) continue;
		const turn: TurnData = entry.data;
		turns.set(turn.time, turn);
		for (const [id, path] of Object.entries(turn.paths ?? {})) paths.set(id, path);
		for (const [id, change] of Object.entries(turn.lines ?? {})) lines.set(id, change);
		if (turn.declared) declarations.push({ time: turn.time, declared: turn.declared, sources: turn.sources ?? {} });
		analysis.timing.activeMs += turn.activeMs ?? 0;
		analysis.timing.modelMs += turn.ms ?? 0;
		analysis.timing.toolMs += turn.toolMs ?? 0;
	}
	declarations.sort((x, y) => x.time - y.time);
	// A record without sources keeps those of the record before.
	declarations.forEach((record, i) => {
		if (i > 0 && Object.keys(record.sources).length === 0) record.sources = declarations[i - 1].sources;
	});
	/** Whether the request made at `time` declared the tool. Undefined before the first recorded declarations. */
	const declaredThen = (name: string, time: number) => {
		const then = declarations.findLast((record) => record.time <= time)?.declared;
		return then && Object.hasOwn(then, name);
	};
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
	const loadSkill = (path: string, time: number) => {
		const skill: SkillRec = skills.get(path) ?? { path, name: path.split("/").at(-2) ?? path, loads: 0, tokens: 0 };
		skill.loads++;
		skill.last = time;
		skills.set(path, skill);
		return skill;
	};
	/** Time of the entry being read. */
	let now = 0;
	const event = (kind: string, detail: string, delta?: number) => {
		const rec: EventRec = { time: now, kind, detail, after: analysis.requests.length };
		if (delta !== undefined) rec.delta = delta;
		analysis.events.push(rec);
		return rec;
	};
	/** Sets the time that a tool waited for an answer of the user apart from the work of the turn. */
	const waited = (ms: number) => {
		if (!input) return;
		input.waitMs = (input.waitMs ?? 0) + ms;
		const request = analysis.requests.at(-1);
		if (request?.activeMs === undefined) return;
		const part = Math.min(ms, request.activeMs);
		request.activeMs -= part;
		analysis.timing.activeMs -= part;
		analysis.timing.toolMs = Math.max(0, analysis.timing.toolMs - part);
	};
	/** Ids of the messages that the context holds in full: those since the last compaction, and those it kept; and the characters of each. */
	const live: string[] = [];
	const liveChars: number[] = [];
	/** Counts a tool call. A call nested in the result of another one comes with its status and the id of that other call. */
	const recordCall = (call: { id: string; name: string; arguments?: any; durationMs?: number }, time: number, nestedStatus?: string, outer?: string) => {
		analysis.toolCalls++;
		if (input) input.toolCalls++;
		const workflow = workflowEvent(call);
		if (workflow) event(workflow[0], workflow[1]);
		if (isQuestion(call.name) && typeof call.durationMs === "number") waited(call.durationMs);
		const rec = tool(call.name);
		rec.last = time;
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
		const op = fileOp(call.name, argPath(call.arguments));
		const path = argPath(call.arguments) ?? paths.get(call.id) ?? (op === "searches" ? "." : undefined);
		if (path && op) {
			const rec: FileOp = { time, op, tool: call.name, request: analysis.requests.length, id: outer ?? call.id };
			if (nestedStatus === "error") rec.error = true;
			const { offset, limit } = call.arguments ?? {};
			if (op === "reads" && (typeof offset === "number" || typeof limit === "number")) rec.range = [typeof offset === "number" ? offset : 1, typeof limit === "number" ? limit : 0];
			const change = (op === "writes" || op === "edits") && !rec.error ? (lines.get(call.id) ?? argLines(call.arguments)) : undefined;
			// A write does not tell what it replaced.
			if (change && op === "writes") rec.added = change[0];
			else if (change) [rec.added, rec.removed] = change;
			addOp(path, rec);
			if (!nestedStatus) opsById.set(call.id, { op: rec, path });
		} else if (op === "edits" && nestedStatus !== "error" && hasAnchor(call.arguments)) analysis.unresolvedEdits++;
		if (path && isSkillRead(call)) skillsById.set(call.id, loadSkill(path, time));
		if (call.name === "bash" && typeof call.arguments?.command === "string") {
			const programs = programsOf(call.arguments.command);
			const command: CommandRec = {
				time,
				command: call.arguments.command,
				program: programs[0] ?? "",
				programs,
				request: analysis.requests.length,
				id: outer ?? call.id,
			};
			if (typeof call.durationMs === "number") command.ms = call.durationMs;
			if (typeof call.arguments.timeout === "number" && call.arguments.timeout > 0) command.timeout = call.arguments.timeout;
			commandsById.set(call.id, command);
			analysis.commands.push(command);
		}
	};
	for (const entry of entries) {
		const entryTime = Date.parse(entry.timestamp) || 0;
		now = entryTime;
		/** Content that an extension or a skill put into the context. */
		const inject = (producer: string, chars: number) => {
			event("injection", `${producer}, ≈${fmtTokens(estimate(chars))} tokens`, estimate(chars)).producer = producer;
		};
		if (entry.type === "compaction") {
			const rec = event("compaction", `${fmtTokens(entry.tokensBefore)} tokens before compaction`);
			const kept = live.indexOf(entry.firstKeptEntryId);
			rec.replaced = kept < 0 ? live.length : kept;
			live.splice(0, rec.replaced);
			rec.removed = estimate(liveChars.splice(0, rec.replaced).reduce((sum, chars) => sum + chars, 0));
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
			const { id, type, description, status, startedAt, completedAt, sessionFile, error, result } = entry.data;
			agents.set(id, { id, type, description, status, startedAt, completedAt, sessionFile, error, result });
		}
		if (entry.type === "custom_message") {
			add(entry.customType ?? "custom", contentChars(entry.content));
			inject(entry.customType ?? "custom", contentChars(entry.content));
		}
		if (entry.type !== "message") continue;
		live.push(entry.id);
		liveChars.push(messageChars(entry.message));

		const m = entry.message;
		const time = m.timestamp ?? entryTime;
		if (m.role === "user") {
			analysis.userInputs++;
			const skill = skillBlock(contentText(m.content));
			if (skill) {
				loadSkill(skill.path, time).tokens = estimate(skill.block.length);
				add(`skill ${skill.name}`, skill.block.length);
				inject(`skill ${skill.name}`, skill.block.length);
			}
			if (!skill || skill.rest) add("user message", skill ? skill.rest.length : contentChars(m.content));
			input = inputAt(time, preview(skill ? `/skill:${skill.name} ${skill.rest}` : contentText(m.content)));
		} else if (input && (m.role === "assistant" || m.role === "toolResult")) input.ms = Math.max(input.ms, (entryTime || time) - input.time);
		if (m.role === "bashExecution") {
			analysis.commands.push({ time, command: m.command, program: programOf(m.command ?? ""), programs: programsOf(m.command ?? ""), request: analysis.requests.length, ok: m.exitCode === 0, ...(m.exitCode ? { exit: m.exitCode } : {}) });
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
			if (isQuestion(m.toolName) && typeof m.durationMs === "number") waited(m.durationMs);
			const done = opsById.get(m.toolCallId);
			const op = done?.op;
			if (op && m.isError) {
				op.error = true;
				op.added = op.removed = undefined;
			} else if (done && op?.op === "searches") {
				// The search moves from the searched path to the files it found.
				const found = searchHits(m.toolName, contentText(m.content), done.path);
				if (found.size === 0) op.hits = 0;
				else {
					const searched = fileAt(done.path);
					searched.searches--;
					searched.ops.splice(searched.ops.indexOf(op), 1);
					if (searched.ops.length === 0) files.delete(done.path);
					for (const [path, hits] of found) addOp(path, { ...op, hits });
				}
			} else if (done && op?.op === "reads" && hasImage(m.content)) {
				fileAt(done.path).reads--;
				fileAt(done.path).images++;
				op.op = "images";
			} else if (op && (op.op === "writes" || op.op === "edits") && typeof m.details?.diff === "string") [op.added, op.removed] = diffLines(m.details.diff);
			const command = commandsById.get(m.toolCallId);
			if (command) {
				command.ok = !m.isError;
				Object.assign(command, commandEnd(contentText(m.content), m.details));
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
				activeMs: turn?.activeMs,
				ttft: turn?.ttft,
			};
			analysis.requests.push(request);
			if (turn && typeof turn.ttft === "number") {
				const { timing } = analysis;
				timing.ttftMs += turn.ttft;
				timing.streamMs += Math.max(0, turn.ms - turn.ttft);
				timing.streamed++;
				timing.streamOutput += request.output;
				for (const kind of REPLY_KINDS) {
					timing.spans[kind][0] += turn.spans?.[kind]?.[0] ?? 0;
					timing.spans[kind][1] += turn.spans?.[kind]?.[1] ?? 0;
				}
			}
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
	for (const each of analysis.inputs) each.ms = Math.max(0, each.ms - (each.waitMs ?? 0));
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