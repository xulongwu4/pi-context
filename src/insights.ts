import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyze, CATEGORIES, type Category } from "./analyze.ts";
import { fmtDay } from "./format.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CACHE_VERSION = 5;
const TOP = 10;
/** Days that the list of days covers at most: 53 weeks. */
const MAX_DAYS = 371;
/** Cached summaries of files older than this are dropped. */
const KEEP_DAYS = 120;

export type SkillSource = "project" | "package" | "user";

/** Where a skill comes from: the project that the session ran in, an installed package, or the user's own skills. */
export function skillSource(path: string, cwd: string): SkillSource {
	if (cwd && path.startsWith(`${cwd}/`)) return "project";
	return /\/(node_modules|git)\//.test(path) ? "package" : "user";
}
/** What Insights keeps of one session file. */
export interface SessionSummary {
	id: string;
	cwd: string;
	name: string;
	start: number;
	end: number;
	requests: number;
	userInputs: number;
	toolCalls: number;
	/** Input, cache and output tokens of the session's own requests. */
	tokens: number;
	cost: number;
	/** Model, then hours since the epoch, to [requests, tokens, cost]. */
	models: Record<string, Record<string, [number, number, number]>>;
	tools: Record<string, number>;
	programs: Record<string, number>;
	skills: Record<string, number>;
	/**
	 * Hours since the epoch, to the requests that pi-context recorded in that hour,
	 * followed by the tokens they sent in each category, in the order of CATEGORIES.
	 */
	composition: Record<string, number[]>;
	/**
	 * Hours since the epoch, to the human inputs and tool calls of the hour, the recorded wall time of its turns,
	 * and the prompt tokens of its requests with those of them read from the cache.
	 * The tool calls count in the hour of the human input that caused them.
	 */
	activity: Record<string, [number, number, number, number, number]>;
	/** Prompt tokens of the last request. */
	context: number;
	/** Estimated tokens of the last recorded request, in the order of CATEGORIES. */
	profile?: number[];
	/** Start of the last human input. */
	lastUser: string;
	/** Skill to its path and where it comes from. */
	skillInfo: Record<string, [path: string, source: SkillSource]>;
	/** Time of the last use of each tool, program and skill. */
	lastUsed: Record<"tools" | "programs" | "skills", Record<string, number>>;
	/** Path of the session file. `scan` sets it; it is not cached. */
	file?: string;
}

export interface DayStat {
	day: string;
	requests: number;
	tokens: number;
	cost: number;
	/** Sessions with a request on the day. */
	sessions: number;
}

export type SessionSort = "recent" | "cost" | "tokens" | "context";

export interface InsightsFilter {
	/** Count only sessions that ran in this directory or below it. */
	cwd?: string;
	/** Order of the sessions. Default: the most recent first. */
	sort?: SessionSort;
	/** Count only this day of the period, as `fmtDay` writes it. `daily`, `week` and `activeDays` still cover the period. */
	day?: string;
	/** With `day`: count the days from `day` to this day, both included. */
	until?: string;
	/** List only the sessions that used this tool, program or skill. The figures still cover all sessions. */
	uses?: { kind: "tools" | "programs" | "skills"; name: string };
}

export interface Insights {
	/** Length of the period in days. Infinite when the period has no start. */
	days: number;
	/** The day that the figures are narrowed to, or with `until` the first and the last day. */
	day?: string;
	until?: string;
	/** Sessions with a request in the period. */
	sessions: SessionSummary[];
	requests: number;
	tokens: number;
	cost: number;
	/** Human inputs and tool calls in the period, and the recorded wall time of its turns. */
	userInputs: number;
	toolCalls: number;
	activeMs: number;
	/** Share of the prompt tokens that were read from the cache. */
	cacheRate: number;
	activeDays: number;
	/** The last seven days, oldest first. */
	week: DayStat[];
	/** Every day that the period touches, oldest first. At most the last 53 weeks. */
	daily: DayStat[];
	/** Tokens sent by category, for the requests that pi-context recorded. */
	composition: { requests: number; sums: Record<Category, number> };
	/** Requests by weekday (Monday first) and hour of day. */
	heat: number[][];
	/** Model, requests, tokens and cost in the period; the most expensive first. */
	models: [string, number, number, number][];
	/** Working directory, sessions, requests, tokens and cost in the period; the most expensive first. */
	projects: [string, number, number, number, number][];
	/** Name, uses in the sessions of the period, the time of the last use, and the sessions that used it. The most used first. */
	tools: [string, number, number, number][];
	programs: [string, number, number, number][];
	skills: [string, number, number, number][];
	/** Skill to its path and where it comes from. */
	skillInfo: Record<string, [path: string, source: SkillSource]>;
}

interface Cache {
	version: number;
	files: Record<string, { size: number; mtimeMs: number; summary: SessionSummary }>;
}

/** The entries from the root of the session tree to the entry `leafId`, in order. */
export function branchOf(entries: any[], leafId: string | undefined): any[] {
	const byId = new Map<string, any>(entries.map((entry) => [entry.id, entry]));
	const branch: any[] = [];
	for (let entry = byId.get(leafId ?? ""); entry && branch.length <= entries.length; entry = byId.get(entry.parentId)) branch.push(entry);
	return branch.reverse();
}

export function parseEntries(text: string): any[] {
	const entries: any[] = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// A torn last line is expected while a session is being written.
		}
	}
	return entries;
}

/** Reduces all entries of one session file to the figures Insights needs. */
export function summarize(entries: any[]): SessionSummary {
	const analysis = analyze(entries);
	const header = entries.find((entry) => entry.type === "session") ?? {};
	const start = Date.parse(header.timestamp) || analysis.requests[0]?.time || 0;
	const summary: SessionSummary = {
		id: header.id ?? "",
		cwd: header.cwd ?? "",
		name: entries.findLast((entry) => entry.type === "session_info")?.name ?? "",
		start,
		end: start,
		requests: analysis.requests.length,
		userInputs: analysis.userInputs,
		toolCalls: analysis.toolCalls,
		tokens: 0,
		cost: 0,
		models: {},
		tools: {},
		programs: {},
		skills: {},
		composition: {},
		activity: {},
		context: 0,
		lastUser: analysis.inputs.findLast((input) => input.preview)?.preview ?? "",
		skillInfo: {},
		lastUsed: { tools: {}, programs: {}, skills: {} },
	};
	const hourOf = (time: number) => (summary.activity[Math.floor(time / HOUR)] ??= [0, 0, 0, 0, 0]);
	for (const request of analysis.requests) {
		const tokens = request.context + request.output;
		const estimated = request.sums ? CATEGORIES.reduce((sum, cat) => sum + (request.sums?.[cat] ?? 0), 0) : 0;
		if (request.sums && estimated > 0 && request.context > 0) {
			const sent = (summary.composition[Math.floor(request.time / HOUR)] ??= new Array<number>(CATEGORIES.length + 1).fill(0));
			sent[0]++;
			CATEGORIES.forEach((cat, i) => {
				sent[i + 1] += Math.round(((request.sums?.[cat] ?? 0) * request.context) / estimated);
			});
		}
		const bucket = ((summary.models[request.model] ??= {})[Math.floor(request.time / HOUR)] ??= [0, 0, 0]);
		bucket[0]++;
		bucket[1] += tokens;
		bucket[2] += request.cost;
		summary.tokens += tokens;
		summary.cost += request.cost;
		summary.end = Math.max(summary.end, request.time);
		const hour = hourOf(request.time);
		hour[2] += request.activeMs ?? 0;
		hour[3] += request.context;
		hour[4] += request.cacheRead;
		summary.context = request.context;
		if (request.sums && estimated > 0) summary.profile = CATEGORIES.map((cat) => request.sums?.[cat] ?? 0);
	}
	for (const input of analysis.inputs) {
		const hour = hourOf(input.time);
		// A session that starts without a user message has an input without text.
		if (input.preview) hour[0]++;
		hour[1] += input.toolCalls;
	}
	const used = (key: "tools" | "programs" | "skills", name: string, time = 0) => {
		summary.lastUsed[key][name] = Math.max(summary.lastUsed[key][name] ?? 0, time);
	};
	for (const tool of analysis.tools) {
		summary.tools[tool.name] = tool.calls + tool.nested;
		used("tools", tool.name, tool.last);
	}
	for (const command of analysis.commands) {
		for (const program of command.programs) {
			summary.programs[program] = (summary.programs[program] ?? 0) + 1;
			used("programs", program, command.time);
		}
	}
	for (const skill of analysis.skills) {
		summary.skills[skill.name] = (summary.skills[skill.name] ?? 0) + skill.loads;
		used("skills", skill.name, skill.last);
		summary.skillInfo[skill.name] = [skill.path, skillSource(skill.path, summary.cwd)];
	}
	return summary;
}

/** Combines session summaries into the figures for the `days` days that end at `now`. With infinite `days`, the period has no start. */
export function aggregate(summaries: SessionSummary[], now: number, days: number, filter: InsightsFilter = {}): Insights {
	const since = now - days * DAY;
	const byDay = new Map<string, DayStat>();
	/** Start of the first counted hour. */
	let first = now;
	const insights: Insights = {
		days,
		day: filter.day,
		until: filter.until,
		sessions: [],
		requests: 0,
		tokens: 0,
		cost: 0,
		userInputs: 0,
		toolCalls: 0,
		activeMs: 0,
		cacheRate: 0,
		activeDays: 0,
		week: [],
		daily: [],
		composition: { requests: 0, sums: Object.fromEntries(CATEGORIES.map((cat) => [cat, 0])) as Record<Category, number> },
		heat: Array.from({ length: 7 }, () => new Array<number>(24).fill(0)),
		models: [],
		projects: [],
		tools: [],
		programs: [],
		skills: [],
		skillInfo: {},
	};
	const models = new Map<string, [string, number, number, number]>();
	const projects = new Map<string, [string, number, number, number, number]>();
	/** Name to the count, the time of the last use, and the sessions. */
	const tally = () => new Map<string, [number, number, number]>();
	const inRange = (day: string) => !filter.day || (filter.until ? day >= filter.day && day <= filter.until : day === filter.day);
	const counts = { tools: tally(), programs: tally(), skills: tally() };
	/** Prompt tokens of the counted requests, and those of them read from the cache. */
	let sent = 0;
	let cacheRead = 0;
	for (const summary of summaries) {
		if (filter.cwd && summary.cwd !== filter.cwd && !summary.cwd.startsWith(`${filter.cwd}/`)) continue;
		let active = false;
		const days = new Set<string>();
		const project = projects.get(summary.cwd) ?? [summary.cwd, 0, 0, 0, 0];
		for (const [name, hours] of Object.entries(summary.models)) {
			for (const [hour, [requests, tokens, cost]] of Object.entries(hours)) {
				const time = Number(hour) * HOUR;
				if (time + HOUR <= since) continue;
				const date = new Date(time);
				const day = fmtDay(time);
				const stat = byDay.get(day) ?? { day, requests: 0, tokens: 0, cost: 0, sessions: 0 };
				if (!days.has(day)) stat.sessions++;
				days.add(day);
				stat.requests += requests;
				stat.tokens += tokens;
				stat.cost += cost;
				byDay.set(day, stat);
				first = Math.min(first, time);
				if (!inRange(day)) continue;
				active = true;
				const model = models.get(name) ?? [name, 0, 0, 0];
				model[1] += requests;
				model[2] += tokens;
				model[3] += cost;
				project[2] += requests;
				project[3] += tokens;
				project[4] += cost;
				models.set(name, model);
				insights.requests += requests;
				insights.tokens += tokens;
				insights.cost += cost;
				insights.heat[(date.getDay() + 6) % 7][date.getHours()] += requests;
			}
		}
		if (!active) continue;
		project[1]++;
		projects.set(summary.cwd, project);
		insights.sessions.push(summary);
		for (const [hour, sent] of Object.entries(summary.composition ?? {})) {
			const time = Number(hour) * HOUR;
			if (time + HOUR <= since || !inRange(fmtDay(time))) continue;
			insights.composition.requests += sent[0];
			CATEGORIES.forEach((cat, i) => {
				insights.composition.sums[cat] += sent[i + 1];
			});
		}
		for (const [hour, [inputs, toolCalls, activeMs, hourSent, hourRead]] of Object.entries(summary.activity ?? {})) {
			const time = Number(hour) * HOUR;
			if (time + HOUR <= since || !inRange(fmtDay(time))) continue;
			insights.userInputs += inputs;
			insights.toolCalls += toolCalls;
			insights.activeMs += activeMs;
			sent += hourSent;
			cacheRead += hourRead;
		}
		Object.assign(insights.skillInfo, summary.skillInfo);
		for (const key of ["tools", "programs", "skills"] as const) {
			for (const [name, n] of Object.entries(summary[key])) {
				const [count, last, sessions] = counts[key].get(name) ?? [0, 0, 0];
				counts[key].set(name, [count + n, Math.max(last, summary.lastUsed?.[key][name] ?? 0), sessions + 1]);
			}
		}
	}
	const order: Record<SessionSort, (session: SessionSummary) => number> = {
		recent: (session) => session.end,
		cost: (session) => session.cost,
		tokens: (session) => session.tokens,
		context: (session) => session.context ?? 0,
	};
	const rank = order[filter.sort ?? "recent"];
	insights.sessions.sort((a, b) => rank(b) - rank(a) || b.end - a.end);
	const uses = filter.uses;
	if (uses) insights.sessions = insights.sessions.filter((session) => session[uses.kind][uses.name]);
	insights.cacheRate = sent > 0 ? cacheRead / sent : 0;
	insights.models = [...models.values()].sort((a, b) => b[3] - a[3] || b[2] - a[2]);
	insights.projects = [...projects.values()].sort((a, b) => b[4] - a[4] || b[3] - a[3]).slice(0, TOP);
	insights.activeDays = byDay.size;
	for (let i = 6; i >= 0; i--) {
		const day = fmtDay(now - i * DAY);
		insights.week.push(byDay.get(day) ?? { day, requests: 0, tokens: 0, cost: 0, sessions: 0 });
	}
	// Step by calendar day, so that a day of 23 or 25 hours counts once.
	const last = new Date(now);
	const date = new Date(Number.isFinite(since) ? since : first);
	date.setHours(0, 0, 0, 0);
	for (; date <= last; date.setDate(date.getDate() + 1)) {
		const day = fmtDay(date.getTime());
		insights.daily.push(byDay.get(day) ?? { day, requests: 0, tokens: 0, cost: 0, sessions: 0 });
	}
	insights.daily = insights.daily.slice(-MAX_DAYS);
	for (const key of ["tools", "programs", "skills"] as const) {
		insights[key] = [...counts[key]]
			.map(([name, [count, last, sessions]]): [string, number, number, number] => [name, count, last, sessions])
			.sort((a, b) => b[1] - a[1])
			.slice(0, TOP);
	}
	return insights;
}

/** The sessions by working directory, in the order given: the directories in the order of their first session. */
export function groupSessions(sessions: SessionSummary[]): [string, SessionSummary[]][] {
	const groups = new Map<string, SessionSummary[]>();
	for (const session of sessions) groups.set(session.cwd, [...(groups.get(session.cwd) ?? []), session]);
	return [...groups];
}
/** The days as a calendar: one row per weekday, Monday first, and one column per week. A cell outside the days is undefined. */
export function calendar(daily: DayStat[]): (DayStat | undefined)[][] {
	const rows: (DayStat | undefined)[][] = Array.from({ length: 7 }, () => []);
	if (daily.length === 0) return rows;
	const [year, month, date] = daily[0].day.split("-").map(Number);
	const offset = (new Date(year, month - 1, date).getDay() + 6) % 7;
	const weeks = Math.ceil((offset + daily.length) / 7);
	for (let i = 0; i < weeks * 7; i++) rows[i % 7].push(daily[i - offset]);
	return rows;
}

/**
 * Summarizes every session file under `root` that changed at or after `since`.
 * Summaries are cached in `cachePath` by file size and modification time, so only changed files are read again.
 */
export async function scan(
	root: string,
	cachePath: string,
	since: number,
	onProgress?: (done: number, total: number) => void,
): Promise<SessionSummary[]> {
	let cache: Cache = { version: CACHE_VERSION, files: {} };
	try {
		const loaded = JSON.parse(await readFile(cachePath, "utf8"));
		if (loaded.version === CACHE_VERSION) cache = loaded;
	} catch {
		// No cache yet, or an unreadable one: read every file.
	}
	const files: { path: string; size: number; mtimeMs: number }[] = [];
	for (const dir of await readdir(root).catch(() => [])) {
		for (const name of await readdir(join(root, dir)).catch(() => [])) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(root, dir, name);
			const info = await stat(path).catch(() => undefined);
			if (info && info.mtimeMs >= since) files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
		}
	}
	const next: Cache = { version: CACHE_VERSION, files: {} };
	// Keep the summaries of older files, so that a scan of a longer period after a shorter one reads nothing again.
	for (const [path, file] of Object.entries(cache.files)) {
		if (file.mtimeMs < since && file.mtimeMs >= Date.now() - KEEP_DAYS * DAY) next.files[path] = file;
	}
	const summaries: SessionSummary[] = [];
	let done = 0;
	for (const file of files) {
		const hit = cache.files[file.path];
		try {
			const summary =
				hit && hit.size === file.size && hit.mtimeMs === file.mtimeMs
					? hit.summary
					: summarize(parseEntries(await readFile(file.path, "utf8")));
			next.files[file.path] = { size: file.size, mtimeMs: file.mtimeMs, summary };
			summaries.push({ ...summary, file: file.path });
		} catch {
			// Skip a file that cannot be read.
		}
		onProgress?.(++done, files.length);
	}
	await writeFile(cachePath, JSON.stringify(next)).catch(() => {});
	return summaries;
}