import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyze } from "./analyze.ts";
import { fmtDay } from "./format.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CACHE_VERSION = 1;
const TOP = 10;

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
	/** Hours since the epoch to [requests, tokens, cost]. */
	hours: Record<string, [number, number, number]>;
	tools: Record<string, number>;
	programs: Record<string, number>;
	skills: Record<string, number>;
}

export interface DayStat {
	day: string;
	requests: number;
	tokens: number;
	cost: number;
}

export interface Insights {
	/** Length of the period in days. */
	days: number;
	/** Sessions with a request in the period, newest first. */
	sessions: SessionSummary[];
	requests: number;
	tokens: number;
	cost: number;
	activeDays: number;
	/** The last seven days, oldest first. */
	week: DayStat[];
	/** Requests by weekday (Monday first) and hour of day. */
	heat: number[][];
	tools: [string, number][];
	programs: [string, number][];
	skills: [string, number][];
}

interface Cache {
	version: number;
	files: Record<string, { size: number; mtimeMs: number; summary: SessionSummary }>;
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
		hours: {},
		tools: {},
		programs: {},
		skills: {},
	};
	for (const request of analysis.requests) {
		const tokens = request.context + request.output;
		const bucket = (summary.hours[Math.floor(request.time / HOUR)] ??= [0, 0, 0]);
		bucket[0]++;
		bucket[1] += tokens;
		bucket[2] += request.cost;
		summary.tokens += tokens;
		summary.cost += request.cost;
		summary.end = Math.max(summary.end, request.time);
	}
	for (const tool of analysis.tools) summary.tools[tool.name] = tool.calls + tool.nested;
	for (const command of analysis.commands) summary.programs[command.program] = (summary.programs[command.program] ?? 0) + 1;
	for (const skill of analysis.skills) summary.skills[skill.name] = (summary.skills[skill.name] ?? 0) + skill.loads;
	return summary;
}

/** Combines session summaries into the figures for the `days` days that end at `now`. */
export function aggregate(summaries: SessionSummary[], now: number, days: number): Insights {
	const since = now - days * DAY;
	const byDay = new Map<string, DayStat>();
	const insights: Insights = {
		days,
		sessions: [],
		requests: 0,
		tokens: 0,
		cost: 0,
		activeDays: 0,
		week: [],
		heat: Array.from({ length: 7 }, () => new Array<number>(24).fill(0)),
		tools: [],
		programs: [],
		skills: [],
	};
	const counts = { tools: new Map<string, number>(), programs: new Map<string, number>(), skills: new Map<string, number>() };
	for (const summary of summaries) {
		let active = false;
		for (const [hour, [requests, tokens, cost]] of Object.entries(summary.hours)) {
			const time = Number(hour) * HOUR;
			if (time + HOUR <= since) continue;
			active = true;
			const date = new Date(time);
			const day = fmtDay(time);
			const stat = byDay.get(day) ?? { day, requests: 0, tokens: 0, cost: 0 };
			stat.requests += requests;
			stat.tokens += tokens;
			stat.cost += cost;
			byDay.set(day, stat);
			insights.requests += requests;
			insights.tokens += tokens;
			insights.cost += cost;
			insights.heat[(date.getDay() + 6) % 7][date.getHours()] += requests;
		}
		if (!active) continue;
		insights.sessions.push(summary);
		for (const key of ["tools", "programs", "skills"] as const) {
			for (const [name, n] of Object.entries(summary[key])) counts[key].set(name, (counts[key].get(name) ?? 0) + n);
		}
	}
	insights.sessions.sort((a, b) => b.end - a.end);
	insights.activeDays = byDay.size;
	for (let i = 6; i >= 0; i--) {
		const day = fmtDay(now - i * DAY);
		insights.week.push(byDay.get(day) ?? { day, requests: 0, tokens: 0, cost: 0 });
	}
	for (const key of ["tools", "programs", "skills"] as const) {
		insights[key] = [...counts[key]].sort((a, b) => b[1] - a[1]).slice(0, TOP);
	}
	return insights;
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
	let done = 0;
	for (const file of files) {
		const hit = cache.files[file.path];
		if (hit && hit.size === file.size && hit.mtimeMs === file.mtimeMs) next.files[file.path] = hit;
		else {
			try {
				const summary = summarize(parseEntries(await readFile(file.path, "utf8")));
				next.files[file.path] = { size: file.size, mtimeMs: file.mtimeMs, summary };
			} catch {
				// Skip a file that cannot be read.
			}
		}
		onProgress?.(++done, files.length);
	}
	await writeFile(cachePath, JSON.stringify(next)).catch(() => {});
	return Object.values(next.files).map((file) => file.summary);
}