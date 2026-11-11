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
	/** Composition snapshot; only for requests made while the extension was loaded. */
	rows?: Row[];
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
	userInputs: number;
	toolCalls: number;
	toolErrors: number;
	totals: Totals;
}

export interface ViewData {
	analysis: Analysis;
	current: Row[];
	usage?: { tokens: number | null; contextWindow: number; percent: number | null };
	model?: string;
	timing: { activeMs: number; modelMs: number; toolMs: number };
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

/** Splits the messages of one request into categorized rows with estimated token counts. */
export function rowsOf(messages: any[]): Row[] {
	const rows: Row[] = [];
	const push = (cat: Category, chars: number, label: string, text: string) => {
		if (chars > 0) rows.push({ cat, tokens: estimate(chars), label, preview: text.replace(/\s+/g, " ").trim().slice(0, 160) });
	};
	// System messages replay in order: later ones append text, replace or remove sections, add or remove tools.
	const sections = new Map<string, number>();
	const tools = new Map<string, number>();
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
				for (const tool of m.toolsAdded ?? []) tools.set(tool.name, JSON.stringify(tool).length);
				for (const tool of m.toolsRemoved ?? []) tools.delete(typeof tool === "string" ? tool : tool.name);
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
	const tail = rows.splice(Math.max(0, headAt));
	push("system", systemChars + sum(sections), "system", systemText || [...sections.keys()].join(", "));
	push("tools", sum(tools), `${tools.size} tool schemas`, [...tools.keys()].join(", "));
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

function fileOp(toolName: string): "reads" | "writes" | "edits" | undefined {
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

/** Derives requests, events, file activity and commands from the session entries of one branch. */
export function analyze(entries: any[]): Analysis {
	const analysis: Analysis = {
		requests: [],
		events: [],
		files: [],
		commands: [],
		userInputs: 0,
		toolCalls: 0,
		toolErrors: 0,
		totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	};
	const files = new Map<string, FileRec>();
	const commandsById = new Map<string, CommandRec>();
	const recordCall = (call: { id: string; name: string; arguments?: any }, time: number) => {
		analysis.toolCalls++;
		const path = argPath(call.arguments);
		const op = fileOp(call.name);
		if (path && op) {
			const file = files.get(path) ?? { path, reads: 0, writes: 0, edits: 0 };
			file[op]++;
			files.set(path, file);
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
		if (entry.type !== "message") continue;

		const m = entry.message;
		const time = m.timestamp ?? entryTime;
		if (m.role === "user") analysis.userInputs++;
		else if (m.role === "bashExecution") {
			analysis.commands.push({ time, command: m.command, program: programOf(m.command), ok: m.exitCode === 0 });
		} else if (m.role === "toolResult") {
			if (m.isError) analysis.toolErrors++;
			addUsage(analysis.totals, m.usage);
			const command = commandsById.get(m.toolCallId);
			if (command) command.ok = !m.isError;
			// Calls that this tool made to other tools (for example from a script).
			for (const nested of m.nestedCalls?.calls ?? []) {
				recordCall(nested, time);
				if (nested.status === "error") analysis.toolErrors++;
				const nestedCommand = commandsById.get(nested.id);
				if (nestedCommand && nested.status !== "unfinished") nestedCommand.ok = nested.status === "ok";
			}
		} else if (m.role === "assistant") {
			const usage = m.usage ?? {};
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
			});
			for (const call of Array.isArray(m.content) ? m.content : []) {
				if (call?.type === "toolCall") recordCall(call, time);
			}
		}
	}
	analysis.files = [...files.values()];
	return analysis;
}