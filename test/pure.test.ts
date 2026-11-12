import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	analyze,
	bands,
	briefOf,
	cacheStats,
	declaredTools,
	diffRows,
	eventKinds,
	introducedAt,
	programOf,
	recordedDeclarations,
	rowsOf,
	scaleOf,
	schemasOf,
	sumByCategory,
	TURN_ENTRY,
	trendBars,
	undeclared,
	type ViewData,
} from "../src/analyze.ts";
import { applyAffixes, loadConfig, saveConfig } from "../src/config.ts";
import { exportJson, exportMarkdown } from "../src/export.ts";
import { expiryText, expiryWarnAt, footerItems, footerText } from "../src/footer.ts";
import { bar, fmtDay, fmtDuration, fmtTokens, sparkline } from "../src/format.ts";
import { hintsOf, hintTotal } from "../src/hints.ts";
import { aggregate, branchOf, calendar, parseEntries, scan, summarize } from "../src/insights.ts";
import { droppedOf, isStub, PRUNE_ENTRY, prune, prunedOf } from "../src/prune.ts";
import { report } from "../src/report.ts";

const usage = (input: number, output: number, cacheRead = 0, cost = 0) => ({
	input,
	output,
	cacheRead,
	cacheWrite: 0,
	totalTokens: input + output + cacheRead,
	cost: { total: cost },
});

const messages = [
	{ role: "system", content: "s".repeat(400), toolsAdded: [{ name: "read", description: "d", parameters: {} }, { name: "gone", description: "d", parameters: {} }] },
	{ role: "system", content: "", toolsRemoved: [{ name: "gone" }] },
	{ role: "user", content: [{ type: "text", text: "u".repeat(40) }, { type: "image", data: "x", mimeType: "image/png" }] },
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "t".repeat(80) },
			{ type: "text", text: "a".repeat(20) },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/skills/x/SKILL.md" } },
			{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "FOO=1 /usr/bin/git status" } },
		],
	},
	{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "k".repeat(400) }], isError: false },
	{ role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: "r".repeat(40) }], isError: true },
	{ role: "custom", customType: "note", content: "c".repeat(40), display: true },
	{ role: "bashExecution", command: "ls", output: "x".repeat(38), excludeFromContext: false },
	{ role: "bashExecution", command: "ls", output: "hidden", excludeFromContext: true },
	{ role: "compactionSummary", summary: "m".repeat(40) },
];

test("rowsOf categorizes every message kind", () => {
	const sums = sumByCategory(rowsOf(messages));
	expect(sums.system).toBe(100);
	expect(sums.user).toBe(10 + 1200);
	expect(sums.reasoning).toBe(20);
	expect(sums.answers).toBe(5);
	expect(sums.skills).toBe(100);
	expect(sums.toolResults).toBe(10);
	expect(sums.injected).toBe(10 + 10 + 10);
	expect(sums.toolCalls).toBeGreaterThan(0);
});

test("rowsOf counts only tools that are still declared", () => {
	const rows = rowsOf(messages);
	const tools = rows.filter((row) => row.cat === "tools");
	expect(tools).toHaveLength(1);
	expect(tools[0].label).toBe("1 tool schemas");
	expect(tools[0].preview).toBe("read");
	expect(rows[1].cat).toBe("tools");
});

test("rowsOf replays system prompt sections", () => {
	const rows = rowsOf([
		{ role: "system", content: "", sections: { a: "x".repeat(40), b: "y".repeat(40) } },
		{ role: "user", content: "hi" },
		{ role: "system", content: "z".repeat(8), sections: { a: null, b: "y".repeat(80) } },
	]);
	expect(rows.map((row) => [row.cat, row.tokens])).toEqual([["system", 22], ["user", 1]]);
	expect(rows[0].preview).toBe("zzzzzzzz");
});

test("rowsOf counts the skill catalog and /skill invocations as skill injections", () => {
	const catalog = `The following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file.\n\n<available_skills>\n  <skill>\n    <name>x</name>\n  </skill>\n</available_skills>`;
	const block = `<skill name="x" location="/skills/x/SKILL.md">\n${"k".repeat(400)}\n</skill>`;
	const rows = rowsOf(
		[
			{ role: "system", content: `${"s".repeat(400)}${catalog}${"e".repeat(40)}` },
			{ role: "user", content: `${block}\n\nfix the bug` },
			{ role: "user", content: [{ type: "text", text: block }] },
			{ role: "user", content: "<skills> are mentioned, not invoked" },
		],
		undefined,
		[],
		true,
	);
	expect(rows.map((row) => [row.cat, row.label, row.tokens])).toEqual([
		["system", "system", 110],
		["skills", "skill catalog", Math.ceil(catalog.length / 4)],
		["skills", "skill x", Math.ceil(block.length / 4)],
		["user", "user", 4],
		["skills", "skill x", Math.ceil(block.length / 4)],
		["user", "user", 9],
	]);
	expect(rows[0].text).toBe("s".repeat(400) + "e".repeat(40));
	expect(rows[1].text).toBe(catalog);
	expect(rows[2].text).toBe(block);
	expect(rows[3].text).toBe("fix the bug");
	// A harness can list the skills in another tag, and a section can hold the list.
	const other = "<skills>\nThe following skills provide specialized instructions for specific tasks.\n## Skills in /skills\n- x: does x\n</skills>";
	const sectioned = rowsOf([{ role: "system", content: "s".repeat(40), sections: { skills: other } }]);
	expect(sectioned.map((row) => [row.cat, row.tokens])).toEqual([["system", 10], ["skills", Math.ceil(other.length / 4)]]);
});

test("analyze counts calls nested in a tool result", () => {
	const a = analyze([
		{
			type: "message",
			timestamp: new Date(0).toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "codemode",
				content: [],
				isError: false,
				timestamp: 5,
				nestedCalls: {
					complete: true,
					calls: [
						{ id: "c1/1", name: "bash", status: "error", arguments: { command: "false" } },
						{ id: "c1/2", name: "write", status: "ok", arguments: { path: "/b.ts" } },
						{ id: "c1/3", name: "bash", status: "unfinished", arguments: { command: "sleep 9" } },
					],
				},
			},
		},
	]);
	expect(a.toolCalls).toBe(3);
	expect(a.toolErrors).toBe(1);
	expect(a.files).toEqual([{ path: "/b.ts", reads: 0, writes: 1, edits: 0 }]);
	expect(a.commands.map((c) => [c.program, c.ok])).toEqual([["false", false], ["sleep", undefined]]);
});

test("analyze derives requests, events, files and commands", () => {
	const entry = (message: any, i: number) => ({ type: "message", timestamp: new Date(1000 * i).toISOString(), message });
	const entries = [
		{ type: "model_change", timestamp: new Date(0).toISOString(), provider: "p", modelId: "m1" },
		entry({ role: "user", content: "hi", timestamp: 1 }, 1),
		entry({ ...messages[3], model: "m1", stopReason: "toolUse", timestamp: 2, usage: usage(100, 10, 900, 0.5) }, 2),
		entry({ ...messages[4], timestamp: 3 }, 3),
		entry({ ...messages[5], timestamp: 4 }, 4),
		{ type: "compaction", timestamp: new Date(5000).toISOString(), tokensBefore: 12345, summary: "s" },
		entry(
			{
				role: "assistant",
				model: "m1",
				stopReason: "stop",
				timestamp: 6,
				usage: usage(50, 5, 0, 0.25),
				content: [{ type: "toolCall", id: "c3", name: "edit", arguments: { path: "/a.ts" } }, { type: "toolCall", id: "c4", name: "write", arguments: { path: "/a.ts" } }],
			},
			6,
		),
		entry({ role: "bashExecution", command: "ls -la", output: "", exitCode: 0, timestamp: 7 }, 7),
	];
	const a = analyze(entries);
	expect(a.requests.map((r) => [r.n, r.context, r.output, r.stop])).toEqual([[1, 1000, 10, "toolUse"], [2, 50, 5, "stop"]]);
	expect(a.totals).toEqual({ input: 150, output: 15, cacheRead: 900, cacheWrite: 0, cost: 0.75 });
	expect(a.userInputs).toBe(1);
	expect(a.toolCalls).toBe(4);
	expect(a.toolErrors).toBe(1);
	expect(a.events.map((e) => [e.kind, e.detail])).toEqual([["model", "p/m1"], ["compaction", "12.3k tokens before compaction"]]);
	expect(a.files).toEqual([
		{ path: "/skills/x/SKILL.md", reads: 1, writes: 0, edits: 0 },
		{ path: "/a.ts", reads: 0, writes: 1, edits: 1 },
	]);
	expect(a.commands.map((c) => [c.program, c.ok])).toEqual([["git", false], ["ls", true]]);
});

test("programOf skips env assignments and sudo", () => {
	expect(programOf("sudo A=1 ./bin/tool --x")).toBe("tool");
	expect(programOf("")).toBe("");
	expect(programOf("cd /x && FOO=1 git status | head")).toBe("git");
	expect(programOf("s=$(grep -n x f); echo $s")).toBe("grep");
	expect(programOf("cd /x")).toBe("cd");
});

test("applyAffixes joins non-empty values only", () => {
	expect(applyAffixes("P", {})).toBe("P");
	expect(applyAffixes("P", { systemPromptPrefix: "A", systemPromptSuffix: " " })).toBe("A\n\nP");
	expect(applyAffixes("P", { systemPromptPrefix: "A", systemPromptSuffix: "Z" })).toBe("A\n\nP\n\nZ");
});

test("config round-trips and tolerates a missing file", () => {
	const path = join(mkdtempSync(join(tmpdir(), "pi-context-")), "c.json");
	expect(loadConfig(path)).toEqual({});
	saveConfig(path, { systemPromptPrefix: "A" });
	expect(loadConfig(path)).toEqual({ systemPromptPrefix: "A" });
});

test("format helpers", () => {
	expect(fmtTokens(999)).toBe("999");
	expect(fmtTokens(84200)).toBe("84.2k");
	expect(fmtTokens(1250000)).toBe("1.3M");
	expect(fmtTokens(2.5e9)).toBe("2.5B");
	expect(fmtTokens(null)).toBe("?");
	expect(fmtDay(new Date(2026, 0, 5, 23, 59).getTime())).toBe("2026-01-05");
	expect(fmtDuration(59000)).toBe("59s");
	expect(fmtDuration(723000)).toBe("12m3s");
	expect(bar(0.5, 4)).toBe("██░░");
	expect(bar(Number.NaN, 2)).toBe("░░");
	expect(sparkline([1, 2, 4, 8], 9)).toBe("▁▂▄█");
	expect(sparkline([1, 2, 4, 8, 0], 2)).toBe("▂█");
	expect(sparkline([], 4)).toBe("");
});

const view = (entries: any[]): ViewData => ({
	analysis: analyze(entries),
	current: rowsOf(messages),
	usage: { tokens: 84200, contextWindow: 200000, percent: 42.1 },
	model: "m1",
	declared: ["codemode", "read"],
	factor: 1,
	hints: [],
	dropped: [],
	config: {},
	agents: [],
	running: false,
	reconstruct: () => [],
});

test("report lists usage, composition and largest items", () => {
	const text = report(view([]));
	expect(text).toContain("Context: 84.2k / 200.0k tokens (42%)");
	expect(text).toContain("System prompt");
	expect(text).toContain("Skill injections");
	expect(text).toContain("Largest items:");
});
const HOUR = 3_600_000;
const at = (message: any, parentId?: string) => ({ type: "message", parentId, timestamp: new Date(message.timestamp).toISOString(), message });
const assistant = (timestamp: number, content: any[] = [], cost = 0.5) => ({
	role: "assistant",
	model: "m1",
	stopReason: "stop",
	timestamp,
	usage: usage(100, 10, 900, cost),
	content,
});
/** A session: one skill read and one failed command, then a script that reads the skill again and edits by anchor. */
const session = (start: number, id = "s1") => [
	{ type: "session", id, timestamp: new Date(start).toISOString(), cwd: "/work/proj" },
	at({ role: "user", content: "hi", timestamp: start }),
	at({ ...assistant(start + 1000, messages[3].content as any[]) }, "p1"),
	at({ ...messages[4], timestamp: start + 2000 }),
	at({ ...messages[5], timestamp: start + 3000 }),
	at(assistant(start + HOUR, [{ type: "toolCall", id: "c5", name: "codemode", arguments: { code: "x".repeat(91) } }], 0.25), "p2"),
	at({
		role: "toolResult",
		toolCallId: "c5",
		toolName: "codemode",
		content: [{ type: "text", text: "o".repeat(80) }],
		isError: false,
		timestamp: start + HOUR + 1000,
		nestedCalls: {
			complete: true,
			calls: [
				{ id: "c5/1", name: "read", status: "ok", arguments: { path: "/skills/x/SKILL.md" } },
				{ id: "c5/2", name: "replace", status: "ok", arguments: { remove_from: "abcde", remove_to: "abcde", text: "" } },
				{ id: "c5/3", name: "insert", status: "ok", arguments: { anchor: "fghij", direction: "after", text: "" } },
				{ id: "c5/4", name: "insert", status: "error", arguments: { anchor: "zzzzz", direction: "after", text: "" } },
			],
		},
	}),
	{ type: "session_info", name: "Named" },
];

test("analyze reports tools and skills", () => {
	const a = analyze(session(0));
	const tool = (name: string) => a.tools.find((t) => t.name === name);
	expect(tool("read")).toMatchObject({ calls: 1, nested: 1, errors: 0, resultTokens: 100 });
	expect(tool("bash")).toMatchObject({ calls: 1, nested: 0, errors: 1, resultTokens: 10 });
	expect(tool("codemode")).toMatchObject({ calls: 1, callTokens: 28, resultTokens: 20 });
	expect(tool("insert")).toMatchObject({ calls: 0, nested: 2, errors: 1, callTokens: 0 });
	expect(a.skills).toEqual([{ path: "/skills/x/SKILL.md", name: "x", loads: 2, tokens: 100 }]);
});

test("analyze counts a /skill invocation as a load of the skill", () => {
	const block = `<skill name="x" location="/skills/x/SKILL.md">\n${"k".repeat(400)}\n</skill>`;
	const at = new Date(0).toISOString();
	const a = analyze([
		{ type: "message", timestamp: at, message: { role: "user", content: `${block}\n\nfix   the bug`, timestamp: 1 } },
		{ type: "message", timestamp: at, message: { role: "user", content: block, timestamp: 2 } },
	]);
	expect(a.skills).toEqual([{ path: "/skills/x/SKILL.md", name: "x", loads: 2, tokens: Math.ceil(block.length / 4) }]);
	expect(a.inputs.map((input) => input.preview)).toEqual(["/skill:x fix the bug", "/skill:x"]);
});

test("analyze applies the turn records pi-context saved", () => {
	const sums = sumByCategory(rowsOf(messages));
	const turn = (data: any) => ({ type: "custom", customType: TURN_ENTRY, data });
	const entries = [
		...session(0),
		turn({ time: 1000, ms: 4000, toolMs: 500, activeMs: 5000, sums }),
		turn({ time: HOUR, ms: 2000, toolMs: 1000, activeMs: 4000, sums, paths: { "c5/2": "/a.ts" } }),
	];
	const a = analyze(entries);
	expect(a.timing).toEqual({ activeMs: 9000, modelMs: 6000, toolMs: 1500 });
	expect(a.requests.map((r) => [r.ms, r.sums?.system, r.parentId])).toEqual([[4000, 100, "p1"], [2000, 100, "p2"]]);
	expect(a.files.find((f) => f.path === "/a.ts")).toEqual({ path: "/a.ts", reads: 0, writes: 0, edits: 1 });
	// c5/3 succeeded but no record names its file; the failed c5/4 changed nothing.
	expect(a.unresolvedEdits).toBe(1);
	expect(analyze(session(0)).unresolvedEdits).toBe(2);
	expect(analyze(session(0)).requests[0].ms).toBeUndefined();
});

test("analyze keeps the last saved record of each subagent", () => {
	const record = (data: any) => ({ type: "custom", customType: "subagents:record", data });
	const a = analyze([
		record({ id: "a1", type: "Explore", description: "look", status: "error", startedAt: 1, completedAt: 2, error: "boom" }),
		record({ id: "a1", type: "Explore", description: "look", status: "completed", startedAt: 5, completedAt: 9, sessionFile: "/s.jsonl" }),
		record({ type: "broken" }),
	]);
	expect(a.agents).toEqual([
		{ id: "a1", type: "Explore", description: "look", status: "completed", startedAt: 5, completedAt: 9, sessionFile: "/s.jsonl", error: undefined },
	]);
});

test("summarize and aggregate build the cross-session figures", () => {
	const now = new Date(2026, 5, 10, 12).getTime(); // a Wednesday
	const recent = summarize(session(now - 26 * HOUR, "recent"));
	const old = summarize(session(now - 40 * 24 * HOUR, "old"));
	expect(recent).toMatchObject({ id: "recent", cwd: "/work/proj", name: "Named", requests: 2, userInputs: 1, toolCalls: 7, tokens: 2020, cost: 0.75 });
	expect(recent.end).toBe(now - 25 * HOUR);
	expect(Object.values(recent.models.m1)).toEqual([[1, 1010, 0.5], [1, 1010, 0.25]]);
	expect(recent.tools).toMatchObject({ read: 2, insert: 2, codemode: 1 });
	expect(recent.programs).toEqual({ git: 1 });
	expect(recent.skills).toEqual({ x: 2 });

	const insights = aggregate([old, recent], now, 30);
	expect(insights.sessions.map((s) => s.id)).toEqual(["recent"]);
	expect(insights).toMatchObject({ requests: 2, tokens: 2020, cost: 0.75, activeDays: 1 });
	expect(insights.week).toHaveLength(7);
	expect(insights.week[6]).toEqual({ day: "2026-06-10", requests: 0, tokens: 0, cost: 0 });
	expect(insights.week[5]).toEqual({ day: "2026-06-09", requests: 2, tokens: 2020, cost: 0.75 });
	// 26 and 25 hours before Wednesday noon: Tuesday 10:00 and 11:00.
	expect(insights.heat[1].slice(9, 13)).toEqual([0, 1, 1, 0]);
	expect(insights.tools[0]).toEqual(["read", 2]);
	expect(insights.skills).toEqual([["x", 2]]);
	expect(insights.models).toEqual([["m1", 2, 2020, 0.75]]);
});

test("aggregate filters by project, sorts sessions and counts models in the period only", () => {
	const now = 100 * 24 * HOUR;
	const summary = (id: string, cwd: string, cost: number, models: Record<string, Record<string, [number, number, number]>>) => ({
		...summarize([]),
		id,
		cwd,
		cost,
		tokens: 1000 - cost,
		end: now - cost * HOUR,
		models,
	});
	const inPeriod = String(now / HOUR - 2);
	const before = String(now / HOUR - 10 * 24);
	const a = summary("a", "/work/proj", 1, { m1: { [inPeriod]: [1, 100, 1] }, old: { [before]: [5, 500, 5] } });
	const b = summary("b", "/work/proj/sub", 3, { m2: { [inPeriod]: [2, 50, 3] } });
	const c = summary("c", "/work/project2", 2, { m1: { [inPeriod]: [1, 10, 2] } });
	const ids = (filter?: Parameters<typeof aggregate>[3]) => aggregate([a, b, c], now, 7, filter).sessions.map((s) => s.id);
	expect(ids()).toEqual(["a", "c", "b"]);
	expect(ids({ sort: "cost" })).toEqual(["b", "c", "a"]);
	expect(ids({ sort: "tokens" })).toEqual(["a", "c", "b"]);
	expect(ids({ cwd: "/work/proj" })).toEqual(["a", "b"]);
	const week = aggregate([a, b, c], now, 7);
	expect(week.models).toEqual([["m1", 2, 110, 3], ["m2", 2, 50, 3]]);
	expect(week).toMatchObject({ requests: 4, cost: 6 });
	expect(aggregate([a, b, c], now, 30).models.map((m) => m[0])).toEqual(["old", "m1", "m2"]);
});

test("parseEntries skips broken lines", () => {
	expect(parseEntries('{"a":1}\n\n{"b":\n{"c":3}')).toEqual([{ a: 1 }, { c: 3 }]);
});

test("scan reads changed session files and reuses cached summaries", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-context-"));
	const cache = join(root, "cache.json");
	const dir = join(root, "sessions", "--work-proj--");
	mkdirSync(dir, { recursive: true });
	const file = (name: string, id: string) => {
		writeFileSync(join(dir, name), session(0, id).map((entry) => JSON.stringify(entry)).join("\n"));
		return join(dir, name);
	};
	const a = file("a.jsonl", "a");
	file("b.jsonl", "b");
	utimesSync(file("old.jsonl", "old"), 1, 1);
	writeFileSync(join(dir, "notes.txt"), "x");
	const progress: number[][] = [];
	const ids = async () => (await scan(join(root, "sessions"), cache, 1000_000, (done, total) => progress.push([done, total]))).map((s) => s.id).sort();
	expect(await ids()).toEqual(["a", "b"]);
	expect(progress).toEqual([[1, 2], [2, 2]]);

	// An unchanged file comes from the cache; a changed one is read again.
	const saved = JSON.parse(readFileSync(cache, "utf8"));
	for (const entry of Object.values<any>(saved.files)) entry.summary.id += "-cached";
	writeFileSync(cache, JSON.stringify(saved));
	writeFileSync(a, `${readFileSync(a, "utf8")}\n`);
	expect(await ids()).toEqual(["a", "b-cached"]);
	expect(await scan(join(root, "missing"), cache, 0)).toEqual([]);
});

test("scan keeps cached summaries of files older than the period", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-context-"));
	const cache = join(root, "cache.json");
	const dir = join(root, "sessions", "--work-proj--");
	mkdirSync(dir, { recursive: true });
	const day = 24 * HOUR;
	const file = (name: string, ageDays: number) => {
		writeFileSync(join(dir, name), session(0, name).map((entry) => JSON.stringify(entry)).join("\n"));
		const time = (Date.now() - ageDays * day) / 1000;
		utimesSync(join(dir, name), time, time);
	};
	file("new.jsonl", 0);
	file("older.jsonl", 20);
	file("ancient.jsonl", 200);
	const cached = () => Object.keys(JSON.parse(readFileSync(cache, "utf8")).files).map((path) => path.split("/").pop()).sort();
	expect(await scan(join(root, "sessions"), cache, 0)).toHaveLength(3);
	expect((await scan(join(root, "sessions"), cache, Date.now() - 7 * day)).map((s) => s.id)).toEqual(["new.jsonl"]);
	expect(cached()).toEqual(["new.jsonl", "older.jsonl"]);
});

test("exportMarkdown writes every section", () => {
	const data = view(session(0));
	data.agents = [{ id: "a1", type: "Explore", description: "look | see", status: "completed", startedAt: 1000, completedAt: 61000, requests: 3, tokens: 1200, cost: 0.1 }];
	const text = exportMarkdown(data, aggregate([summarize(session(0))], HOUR, 30));
	for (const heading of ["Stats", "Current context", "Hints", "Requests", "Events", "Files", "Commands", "Tools", "Fleet", "Insights: last 30 days, all projects"]) {
		expect(text).toContain(`## ${heading}`);
	}
	expect(text).toContain("| read | 1 | 1 | 0 | ≈9 | ≈100 |  |");
	// "bash" was called directly but is not declared; "insert" was only called from a script.
	expect(text).toContain("| bash | 1 | 0 | 1 | ≈11 | ≈10 | direct calls while not declared: 1 |");
	expect(text).toContain("| m1 | 2 | 2.0k | 20 | $0.7500 |");
	expect(text).toContain("90% of the tokens sent were read from the cache; 0 misses");
	data.factor = 2;
	expect(exportMarkdown(data, aggregate([], HOUR, 30))).toContain("| bash | 1 | 0 | 1 | ≈22 | ≈20 |");
	expect(text).toContain("| insert | 0 | 2 | 1 |  |  |  |");
	expect(text).toContain("| x | 2 | ≈100 | /skills/x/SKILL.md |");
	expect(text).toContain("| a1 | Explore | look \\| see | completed | 1m0s | 3 | 1.2k | $0.1000 |");
	expect(text).toContain("2 anchor-based edits are not listed");
	expect(text).toContain("- Top programs: git ×1");
	expect(text).toContain("Tokens sent, by category (0 of 2 requests recorded by pi-context):");
	expect(text).toContain("## Events\n\nNone.");
});
test("declaredTools reads the declarations of each provider payload shape", () => {
	const size = (value: unknown) => JSON.stringify(value).length;
	const anthropic = { name: "codemode", description: "d", input_schema: {} };
	const chat = { type: "function", function: { name: "codemode", description: "d", parameters: {} } };
	const google = { functionDeclarations: [{ name: "a", description: "d" }, { name: "b", description: "dd" }] };
	const bedrock = { toolSpec: { name: "codemode", description: "d", inputSchema: {} } };
	expect(declaredTools({ tools: [anthropic, { type: "web_search_20250305", name: "web_search" }] })).toEqual({
		codemode: size(anthropic),
		web_search: size({ type: "web_search_20250305", name: "web_search" }),
	});
	expect(declaredTools({ tools: [chat] })).toEqual({ codemode: size(chat) });
	expect(declaredTools({ config: { tools: [google] } })).toEqual({ a: size(google.functionDeclarations[0]), b: size(google.functionDeclarations[1]) });
	expect(declaredTools({ toolConfig: { tools: [bedrock] } })).toEqual({ codemode: size(bedrock) });
	expect(declaredTools({ tools: [] })).toEqual({});
	expect(declaredTools({ messages: [] })).toBeUndefined();
	expect(declaredTools(undefined)).toBeUndefined();
});

test("rowsOf counts the declarations a request carries, not every active tool", () => {
	// The transcript declares both tools, but the request hides "read" and sends a longer description of "codemode".
	const transcript = [
		{ role: "system", content: "s".repeat(40), toolsAdded: [{ name: "read", description: "r".repeat(400) }, { name: "codemode", description: "c" }] },
		{ role: "user", content: "hi" },
	];
	const tools = (declared?: Record<string, number>) => rowsOf(transcript, declared).filter((row) => row.cat === "tools");
	expect(tools()[0].label).toBe("2 tool schemas");
	expect(tools({ codemode: 200 })).toEqual([{ cat: "tools", tokens: 50, label: "1 tool schemas", preview: "codemode" }]);
	expect(tools({})).toEqual([]);
	// Before a request is seen, the hidden names are all that is known.
	expect(rowsOf(transcript, undefined, ["read"]).filter((row) => row.cat === "tools")).toMatchObject([{ label: "1 tool schemas", preview: "codemode" }]);
	expect(tools({ codemode: 200 })).toEqual(rowsOf(transcript, { codemode: 200 }, ["codemode"]).filter((row) => row.cat === "tools"));
	expect(rowsOf([{ role: "user", content: "hi" }], { codemode: 200 }).map((row) => row.cat)).toEqual(["tools", "user"]);
});

test("recordedDeclarations returns the last declarations saved on the branch", () => {
	const turn = (data: any) => ({ type: "custom", customType: TURN_ENTRY, data });
	expect(recordedDeclarations([turn({ declared: { a: 1 } }), turn({ declared: { b: 2 } }), turn({ time: 3 })])).toEqual({ b: 2 });
	expect(recordedDeclarations([turn({ time: 3 }), { type: "custom", customType: "other", data: { declared: { x: 1 } } }])).toBeUndefined();
});
test("schemasOf lists the tool schemas a request carries", () => {
	const transcript = [
		{ role: "system", content: "", toolsAdded: [{ name: "read" }, { name: "codemode" }, { name: "gone" }] },
		{ role: "user", content: "hi" },
		{ role: "system", content: "", toolsRemoved: [{ name: "gone" }] },
	];
	expect([...schemasOf(transcript).keys()]).toEqual(["read", "codemode"]);
	expect([...schemasOf(transcript, undefined, ["read"]).keys()]).toEqual(["codemode"]);
	expect([...schemasOf(transcript, { other: 5 }, ["other"])]).toEqual([["other", 5]]);
});

test("undeclared flags direct calls to tools the model was not given", () => {
	const tool = (name: string, calls: number) => ({ name, calls, nested: 3, errors: 0, callTokens: 0, resultTokens: 0, undeclared: 0, unchecked: calls });
	expect(undeclared(tool("write", 2), ["codemode"])).toBe(2);
	expect(undeclared(tool("Write", 1), ["codemode", "write"])).toBe(1);
	expect(undeclared(tool("codemode", 9), ["codemode"])).toBe(0);
	expect(undeclared(tool("bash", 0), ["codemode"])).toBe(0);
});

test("analyze judges a direct call by the declarations recorded when it was made", () => {
	const call = (time: number) => at({ ...assistant(time, [{ type: "toolCall", id: `w${time}`, name: "write", arguments: { path: "/a", content: "" } }]) });
	const turn = (time: number, declared: Record<string, number>) => ({ type: "custom", customType: TURN_ENTRY, data: { time, ms: 0, toolMs: 0, activeMs: 0, sums: {}, declared } });
	const entries = [
		call(1000),
		call(2000),
		turn(2000, { codemode: 10 }),
		call(3000),
		turn(3000, { codemode: 10, write: 5 }),
		call(4000),
	];
	const write = analyze(entries).tools.find((t) => t.name === "write");
	// 1000: nothing recorded yet. 2000: not declared. 3000 and 4000: declared.
	expect(write).toMatchObject({ calls: 4, undeclared: 1, unchecked: 1 });
	expect(undeclared(write!, ["write"])).toBe(1);
	expect(undeclared(write!, ["codemode"])).toBe(2);
});

test("analyze flags cache misses and sums requests by model", () => {
	const request = (time: number, model: string, input: number, cacheRead: number, cacheWrite: number, cost: Record<string, number>) =>
		at({ role: "assistant", model, stopReason: "stop", timestamp: time, content: [], usage: { input, output: 5, cacheRead, cacheWrite, cost: { total: 1, ...cost } } });
	const a = analyze([
		request(1000, "m1", 10, 0, 2000, { cacheWrite: 0.025 }),
		request(2000, "m1", 50, 2010, 0, { cacheRead: 0.00201 }),
		// Reads nothing of the 2060 tokens of the previous request.
		request(602_000, "m1", 10, 0, 2100, { input: 0.0001, cacheWrite: 0.02625 }),
		// Another model has its own cache, and a compaction starts a new context.
		request(603_000, "m2", 10, 0, 3000, {}),
		{ type: "compaction", timestamp: new Date(604_000).toISOString(), tokensBefore: 3000 },
		request(605_000, "m2", 10, 0, 3000, {}),
		request(606_000, "m2", 10, 3010, 0, {}),
	]);
	expect(a.requests.map((r) => r.miss?.tokens)).toEqual([undefined, undefined, 2060, undefined, undefined, undefined]);
	expect(a.requests[2].miss?.idleMs).toBe(600_000);
	// 2060 tokens at the rate paid (0.02635 / 2110) less the cache read rate (0.000001).
	expect(a.requests[2].miss?.cost).toBeCloseTo(2060 * (0.02635 / 2110 - 0.000001), 6);
	expect(a.models).toEqual([
		{ model: "m1", requests: 3, sent: 6180, output: 15, cost: 3 },
		{ model: "m2", requests: 3, sent: 9040, output: 15, cost: 3 },
	]);
	const stats = cacheStats(a);
	expect(stats).toMatchObject({ misses: 1, tokens: 2060 });
	expect(stats.rate).toBeCloseTo(5020 / 15220, 6);
	// A model that never used the cache has no misses.
	expect(analyze([request(1000, "m3", 5000, 0, 0, {}), request(2000, "m3", 6000, 0, 0, {})]).requests[1].miss).toBeUndefined();
});

test("rowsOf keeps the whole content only when asked", () => {
	expect(rowsOf(messages).every((row) => row.text === undefined)).toBe(true);
	const rows = rowsOf([{ role: "system", content: "", sections: { rules: "be brief" }, toolsAdded: messages[0].toolsAdded }, ...messages.slice(2)], undefined, [], true);
	const text = (label: string) => rows.find((row) => row.label === label)?.text;
	expect(text("system")).toBe("[rules]\nbe brief");
	expect(text("2 tool schemas")).toContain("read");
	expect(text("result read")).toBe("k".repeat(400));
	expect(text("bash")).toBe(`ls\n${"x".repeat(38)}`);
});

test("scaleOf scales estimates to the provider-reported figure", () => {
	expect(scaleOf(100, 250)).toBe(2.5);
	expect(scaleOf(0, 250)).toBe(1);
	expect(scaleOf(100, null)).toBe(1);
	const data = view([]);
	expect(report(data)).toContain("System prompt     ≈   100");
	data.factor = 2.5;
	expect(report(data)).toContain("System prompt     ≈   250");
	expect(report(data)).toContain("scaled ×2.50");
});

test("hintsOf lists superseded reads, repeated skills and large old results", () => {
	const read = (id: string, args: object) => ({ type: "toolCall", id, name: "read", arguments: args });
	const result = (toolCallId: string, toolName: string, chars: number, isError = false) => ({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "z".repeat(chars) }], isError });
	const hints = hintsOf([
		{ role: "user", content: "go" },
		{
			role: "assistant",
			content: [
				read("r1", { path: "/a.ts" }),
				read("r2", { path: "/a.ts" }),
				read("r3", { path: "/a.ts", offset: 100 }),
				read("s1", { path: "/skills/x/SKILL.md" }),
				read("s2", { path: "/skills/x/SKILL.md" }),
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } },
				{ type: "toolCall", id: "b2", name: "bash", arguments: { command: "false" } },
			],
		},
		result("r1", "read", 800),
		result("r2", "read", 1200),
		result("r3", "read", 6000),
		result("s1", "read", 400),
		result("s2", "read", 400),
		result("b1", "bash", 8000),
		result("b2", "bash", 8000, true),
		{ role: "user", content: "more" },
		{ role: "assistant", content: [{ type: "toolCall", id: "b3", name: "bash", arguments: { command: "ls" } }] },
		result("b3", "bash", 9000),
	]);
	expect(hints.map((hint) => [hint.kind, hint.tokens, hint.label])).toEqual([
		["result", 2000, "result bash"],
		// A read of another range is not superseded, but it is a large old result.
		["result", 1500, "result read"],
		["reread", 200, "read /a.ts ×2"],
		["skill", 100, "skill x ×2"],
	]);
	expect(hintsOf([{ role: "user", content: "go" }])).toEqual([]);
});

test("report returns one section when asked", () => {
	const data = view(session(0));
	expect(report(data, "composition")).toStartWith("Current context composition");
	expect(report(data, "requests")).toContain("#2 ");
	expect(report(data, "requests")).toContain("m1: 2 requests, sent 2.0k, output 20, $0.7500");
	expect(report(data, "tools")).toContain("bash: 1 direct, 0 nested, 1 errors, calls ≈11, results ≈10, direct calls while not declared: 1");
	expect(report(data, "tools")).toContain("x ×2 ≈100  /skills/x/SKILL.md");
	expect(report(data, "files")).toContain("2 0 0  /skills/x/SKILL.md");
	expect(report(data, "commands")).toContain("Programs: git ×1");
	expect(report(data, "hints")).toContain("Nothing stands out");
	data.hints = [{ kind: "result", tokens: 2000, label: "result bash", detail: "zzz" }];
	expect(report(data, "hints")).toContain("≈  2.0k  result bash: zzz");
});
test("analyze groups the work by human input", () => {
	const start = 10 * HOUR;
	const entries = [...session(start), at({ role: "user", content: "second\n input", timestamp: start + 2 * HOUR })];
	const { inputs } = analyze(entries);
	expect(inputs).toEqual([
		{ n: 1, time: start, preview: "hi", first: 0, requests: 2, toolCalls: 7, sent: 2000, output: 20, cost: 0.75, ms: HOUR + 1000 },
		{ n: 2, time: start + 2 * HOUR, preview: "second input", first: -1, requests: 0, toolCalls: 0, sent: 0, output: 0, cost: 0, ms: 0 },
	]);
	// A request before any input still belongs to a row.
	expect(analyze([at(assistant(1000))]).inputs).toMatchObject([{ n: 1, preview: "", first: 0, requests: 1 }]);
});

test("analyze sums the recorded compositions, scaled to what each request sent", () => {
	const sums = { ...sumByCategory([]), system: 300, user: 100 };
	const turn = { type: "custom", customType: TURN_ENTRY, data: { time: 1000, ms: 1, toolMs: 0, activeMs: 1, sums } };
	const analysis = analyze([at(assistant(1000)), turn, at(assistant(2000))]);
	expect(analysis.billedRequests).toBe(1);
	expect(analysis.billed).toMatchObject({ system: 750, user: 250, answers: 0 });
});

test("trendBars gives one bar for each request or human input, as totals or as changes", () => {
	const reply = (timestamp: number, sent: number) => at({ ...assistant(timestamp), usage: usage(sent, 10) });
	const turn = (time: number, sums: object) => ({ type: "custom", customType: TURN_ENTRY, data: { time, ms: 1, toolMs: 0, activeMs: 1, sums: { ...sumByCategory([]), ...sums } } });
	const analysis = analyze([
		at({ role: "user", content: "one", timestamp: 1 }),
		reply(10, 1000),
		turn(10, { system: 300, user: 100 }),
		reply(20, 2000),
		turn(20, { system: 300, user: 100, toolResults: 400 }),
		at({ role: "user", content: "two", timestamp: 30 }),
		reply(40, 500),
		turn(40, { system: 300, user: 200 }),
		reply(50, 800),
		at({ role: "user", content: "three", timestamp: 60 }),
	]);
	const bars = (byTurn: boolean, delta: boolean) => trendBars(analysis, byTurn, delta).map(({ index, n, value }) => [index, n, value]);
	expect(bars(false, false)).toEqual([[0, 1, 1000], [1, 2, 2000], [2, 3, 500], [3, 4, 800]]);
	expect(bars(false, true)).toEqual([[0, 1, 1000], [1, 2, 1000], [2, 3, -1500], [3, 4, 300]]);
	// A human input shows its last request. An input without a request has no bar.
	expect(bars(true, false)).toEqual([[1, 1, 2000], [3, 2, 800]]);
	expect(bars(true, true)).toEqual([[1, 1, 2000], [3, 2, -1200]]);
	// The recorded composition is scaled to the size the provider reported. A request without a record has none.
	const parts = (delta: boolean) => trendBars(analysis, false, delta).map(({ parts }) => parts && [parts.system, parts.user, parts.toolResults]);
	expect(parts(false)).toEqual([[750, 250, 0], [750, 250, 1000], [300, 200, 0], undefined]);
	expect(parts(true)).toEqual([[750, 250, 0], [0, 0, 1000], [-450, -50, -1000], undefined]);
	expect(trendBars(analysis, true, true).map(({ parts }) => parts?.toolResults)).toEqual([1000, undefined]);
});

test("briefOf tells what a request or a human input did: the input, what entered the context, and the answer", () => {
	const call = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: {} });
	const result = (toolCallId: string, toolName: string, timestamp: number) => ({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "r".repeat(400) }], timestamp });
	const analysis = analyze([
		at({ role: "user", content: "u".repeat(40), timestamp: 1 }),
		at(assistant(10, [call("c1", "read"), call("c2", "read"), call("c3", "bash")])),
		at(result("c1", "read", 11)),
		at(result("c2", "read", 12)),
		at(result("c3", "bash", 13)),
		at(assistant(20, [{ type: "thinking", thinking: "hm" }, { type: "text", text: "Two\nfiles." }])),
		{ type: "compaction", timestamp: new Date(25).toISOString(), summary: "s".repeat(4000), tokensBefore: 5000 },
		at({ role: "user", content: "next", timestamp: 30 }),
		at({ ...assistant(40), stopReason: "error" }),
	]);
	expect(analysis.requests[1].added).toEqual([{ label: "result read", tokens: 100 }, { label: "result read", tokens: 100 }, { label: "result bash", tokens: 100 }]);
	expect(briefOf(analysis, 0)).toEqual({ first: 0, user: `#1 ${"u".repeat(40)}`, added: "user message ≈10", reply: "calls read ×2, bash" });
	expect(briefOf(analysis, 1)).toEqual({ first: 0, user: `#1 ${"u".repeat(40)}`, added: "result read ×2 ≈200 · result bash ≈100", reply: "Two files." });
	// Of a human input: all that entered the context and all the calls, with the last answer.
	expect(briefOf(analysis, 1, true)).toMatchObject({ added: "user message ≈10 · result read ×2 ≈200 · result bash ≈100", reply: "calls read ×2, bash · Two files." });
	expect(briefOf(analysis, 2)).toEqual({ first: 2, user: "#2 next", added: "compaction summary ≈1.0k · user message ≈1", reply: "nothing (error)" });
	expect(briefOf(analysis, 3)).toBeUndefined();
});

test("analyze estimates when the prompt cache expires", () => {
	expect(analyze([at(assistant(1000))]).cacheUntil).toBe(1000 + 5 * 60_000);
	const long = { ...assistant(1000), usage: { ...usage(100, 10, 900), cacheWrite1h: 50 } };
	expect(analyze([at(long), at(assistant(2000))]).cacheUntil).toBe(2000 + HOUR);
	const uncached = { ...assistant(1000), usage: usage(100, 10) };
	expect(analyze([at(uncached)]).cacheUntil).toBeUndefined();
	expect(analyze([at(assistant(1000)), { type: "compaction", tokensBefore: 5 }]).cacheUntil).toBeUndefined();
});

test("diffRows marks what a request added, changed and removed", () => {
	const row = (cat: any, tokens: number, label: string, id?: string) => ({ cat, tokens, label, preview: label, ...(id ? { id } : {}) });
	const previous = [row("system", 100, "system"), row("tools", 50, "2 tool schemas"), row("user", 5, "user"), row("toolResults", 50, "result read", "r1"), row("answers", 8, "answer")];
	const rows = [row("system", 120, "system"), row("tools", 50, "2 tool schemas"), row("user", 5, "user"), row("toolResults", 5, "result read", "r1"), row("toolCalls", 7, "call bash")];
	const diff = diffRows(previous, rows);
	expect(diff.marks).toEqual(["~", "", "", "~", "+"]);
	expect(diff.removed.map((r) => r.label)).toEqual(["answer"]);
	expect(diff.delta).toMatchObject({ system: 20, tools: 0, toolResults: -45, toolCalls: 7, answers: -8 });
	// Equal rows are matched one to one.
	expect(diffRows([row("user", 5, "user")], [row("user", 5, "user"), row("user", 5, "user")]).marks).toEqual(["", "+"]);
});

test("prune replaces dropped tool results with a stub", () => {
	const result = (toolCallId: string, chars: number) => ({ role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text: "z".repeat(chars) }], isError: false });
	const list = [{ role: "user", content: "go" }, result("c1", 800), result("c2", 400)];
	const ids = new Set(["c1"]);
	const pruned = prune(list, ids);
	expect(pruned[0]).toBe(list[0]);
	expect(pruned[2]).toBe(list[2]);
	expect((pruned[1] as any).content[0].text).toContain("(800 characters)");
	expect(pruned[1]).toMatchObject({ toolCallId: "c1", toolName: "read", isError: false });
	expect(isStub(pruned[1])).toBe(true);
	expect(isStub(list[1])).toBe(false);
	// Pruning again changes nothing, so the request prefix stays the same.
	expect(prune(pruned, ids)).toEqual(pruned);
	expect(prune(list, new Set())).toBe(list);
	expect(droppedOf(list, ids)).toMatchObject([{ cat: "toolResults", tokens: 200, label: "result read", id: "c1" }]);
	expect(rowsOf(list).map((r) => r.id)).toEqual([undefined, "c1", "c2"]);

	const entry = (data: any) => ({ type: "custom", customType: PRUNE_ENTRY, data });
	expect([...prunedOf([entry({ ids: ["a"] }), entry({ ids: ["b", "c"] })])]).toEqual(["b", "c"]);
	expect(prunedOf([]).size).toBe(0);
});

test("hintsOf names the results to drop, skips dropped ones and lists repeated reads in scripts", () => {
	const read = (id: string, args: object) => ({ type: "toolCall", id, name: "read", arguments: args });
	const result = (toolCallId: string, toolName: string, chars: number, extra = {}) => ({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "z".repeat(chars) }], isError: false, ...extra });
	const nestedCalls = {
		complete: true,
		calls: [
			{ id: "k1/1", name: "read", status: "ok", arguments: { path: "big.ts" } },
			{ id: "k1/2", name: "read", status: "ok", arguments: { path: "big.ts", offset: 5 } },
			{ id: "k1/3", name: "read", status: "error", arguments: { path: "big.ts" } },
			{ id: "k1/4", name: "read", status: "ok", arguments: { path: "once.ts" } },
		],
	};
	const list = [
		{ role: "user", content: "go" },
		{ role: "assistant", content: [read("r1", { path: "/a.ts" }), read("r2", { path: "/a.ts" }), { type: "toolCall", id: "k1", name: "codemode", arguments: {} }] },
		result("r1", "read", 800),
		result("r2", "read", 1200),
		result("k1", "codemode", 8000, { nestedCalls }),
		{ role: "user", content: "more" },
	];
	const hints = hintsOf(list, (path) => (path === "big.ts" ? 4000 : undefined));
	expect(hints.map((hint) => [hint.kind, hint.tokens, hint.label, hint.ids])).toEqual([
		["result", 2000, "result codemode", ["k1"]],
		["nested", 1000, "read big.ts ×2 in scripts", undefined],
		["reread", 200, "read /a.ts ×2", ["r1"]],
	]);
	expect(hintTotal(hints)).toBe(2200);
	// Without a size, the read is still listed.
	expect(hintsOf(list).find((hint) => hint.kind === "nested")?.tokens).toBe(0);
	// Dropped results are not hinted again, and the reads of a dropped script result do not count.
	expect(hintsOf(prune(list, new Set(["r1", "k1"])))).toEqual([]);
});

test("footerText shows the configured items that have data", () => {
	const now = 1_000_000;
	const stats = { usage: { tokens: 84200, contextWindow: 200000, percent: 42.1 }, cost: 1.5, requests: 3, cacheRate: 0.874, cacheUntil: now + 125_000 };
	expect(footerText({}, stats, now)).toBe("ctx 42% 84.2k/200.0k");
	expect(footerText({ footer: ["cost", "context", "cache", "ttl"] }, stats, now)).toBe("$1.50 · ctx 42% 84.2k/200.0k · cache 87% · ttl 2m5s");
	expect(footerText({ footer: ["ttl"] }, stats, now + 200_000)).toBe("ttl expired");
	// A budget adds the cost.
	expect(footerItems({ budget: 5 })).toEqual(["context", "cost"]);
	expect(footerText({ budget: 5 }, stats, now)).toBe("ctx 42% 84.2k/200.0k · $1.50/$5.00");
	expect(footerText({ footer: ["context", "cache", "ttl"] }, { cost: 0, requests: 0, cacheRate: 0 }, now)).toBe("");
});

test("aggregate sums the period by project", () => {
	const now = new Date(2026, 5, 10, 12).getTime();
	const a = summarize(session(now - 26 * HOUR, "a"));
	const b = { ...summarize(session(now - 30 * HOUR, "b")), cwd: "/work/other", cost: 9 };
	const old = { ...summarize(session(now - 40 * 24 * HOUR, "old")), cwd: "/work/old" };
	expect(aggregate([a, a, b, old], now, 30).projects).toEqual([
		["/work/proj", 2, 4, 4040, 1.5],
		["/work/other", 1, 2, 2020, 0.75],
	]);
});

test("branchOf follows the parents of the leaf", () => {
	const entries = [{ id: "a" }, { id: "b", parentId: "a" }, { id: "c", parentId: "b" }, { id: "d", parentId: "b" }];
	expect(branchOf(entries, "d").map((entry) => entry.id)).toEqual(["a", "b", "d"]);
	expect(branchOf(entries, undefined)).toEqual([]);
});

test("scan names the file of each summary", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-context-"));
	mkdirSync(join(root, "proj"));
	const file = join(root, "proj", "one.jsonl");
	writeFileSync(file, session(Date.now()).map((entry) => JSON.stringify(entry)).join("\n"));
	const cache = join(root, "cache.json");
	expect((await scan(root, cache, 0)).map((summary) => summary.file)).toEqual([file]);
	// The cached summary does not hold the path, but a scan that uses the cache still returns it.
	expect(readFileSync(cache, "utf8")).not.toContain('"file"');
	expect((await scan(root, cache, 0))[0].file).toBe(file);
});

test("the exports cover turns, dropped results and projects", () => {
	const data = view(session(10 * HOUR));
	data.dropped = [{ cat: "toolResults", tokens: 200, label: "result read", preview: "zzz", id: "c1" }];
	data.current = rowsOf(messages, undefined, [], true);
	const insights = aggregate([summarize(session(10 * HOUR))], 11 * HOUR, 30);
	const text = exportMarkdown(data, insights);
	expect(text).toContain("## Turns");
	expect(text).toContain("| 2 | 7 | 2.0k | 20 | $0.7500 | 1h0m | hi |");
	expect(text).toContain("| ≈200 | result read: zzz |");
	expect(text).toContain("| /work/proj | 1 | 2 | 2.0k | $0.7500 |");
	expect(text).toContain("0 of 2 requests recorded by pi-context");

	const json = JSON.parse(exportJson(data, insights));
	expect(json).toMatchObject({ model: "m1", factor: 1, inputs: [{ n: 1, requests: 2 }], dropped: [{ id: "c1" }], insights: { projects: [["/work/proj", 1, 2, 2020, 0.75]] } });
	expect(json.requests).toHaveLength(2);
	expect(json.current.length).toBeGreaterThan(0);
	expect(JSON.stringify(json.current)).not.toContain('"text"');
});

test("rowsOf keeps the time of each message, and introducedAt names the first request that carried a row", () => {
	const rows = rowsOf([
		{ role: "system", content: "s".repeat(40) },
		{ role: "user", content: "go", timestamp: 1000 },
		{ role: "assistant", timestamp: 2000, content: [{ type: "text", text: "ok" }, { type: "toolCall", id: "c1", name: "bash", arguments: {} }] },
		{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "out" }], timestamp: 2500 },
		{ role: "user", content: "more", timestamp: 9000 },
	]);
	expect(rows.map((row) => row.time)).toEqual([undefined, 1000, 2000, 2000, 2500, 9000]);
	const requests: any[] = [{ n: 1, time: 2000 }, { n: 2, time: 3000 }];
	// An answer is first sent by the request after the one that produced it.
	expect(rows.map((row) => introducedAt(row, requests))).toEqual([undefined, 1, 2, 2, 2, undefined]);
});

test("diffRows counts the items each category gained or lost", () => {
	const row = (cat: any, label: string) => ({ cat, tokens: 5, label, preview: label });
	const diff = diffRows([row("user", "a"), row("answers", "b"), row("answers", "c")], [row("user", "a"), row("user", "d"), row("toolCalls", "e")]);
	expect(diff.items).toMatchObject({ user: 1, answers: -2, toolCalls: 1, system: 0 });
});

test("bands maps the reading order to cells in proportion to the tokens", () => {
	const row = (cat: any, tokens: number) => ({ cat, tokens, label: cat, preview: "" });
	expect(bands([row("system", 50), row("user", 25), row("answers", 25)], 8)).toEqual(["system", "system", "system", "system", "user", "user", "answers", "answers"]);
	// An item smaller than a cell can be hidden; the cells always cover the whole width.
	expect(bands([row("system", 1), row("user", 99)], 4)).toEqual(["user", "user", "user", "user"]);
	expect(bands([], 4)).toEqual([]);
	expect(bands([row("user", 0)], 4)).toEqual([]);
});

test("aggregate lists every day of the period and narrows the figures to one day", () => {
	const now = new Date(2026, 5, 10, 12).getTime(); // a Wednesday
	const monday = summarize(session(now - 50 * HOUR, "monday"));
	const tuesday = { ...summarize(session(now - 26 * HOUR, "tuesday")), cwd: "/work/other" };
	const insights = aggregate([monday, tuesday], now, 7);
	// The period starts at noon, so it touches eight days.
	expect(insights.daily.map((stat) => stat.day)).toEqual(["2026-06-03", "2026-06-04", "2026-06-05", "2026-06-06", "2026-06-07", "2026-06-08", "2026-06-09", "2026-06-10"]);
	expect(insights.daily.map((stat) => stat.requests)).toEqual([0, 0, 0, 0, 0, 2, 2, 0]);
	expect(insights.day).toBeUndefined();
	expect(insights.requests).toBe(4);

	const day = aggregate([monday, tuesday], now, 7, { day: "2026-06-09" });
	expect(day).toMatchObject({ day: "2026-06-09", requests: 2, tokens: 2020, cost: 0.75 });
	expect(day.sessions.map((s) => s.id)).toEqual(["tuesday"]);
	expect(day.projects).toEqual([["/work/other", 1, 2, 2020, 0.75]]);
	expect(day.models).toEqual([["m1", 2, 2020, 0.75]]);
	expect(day.heat[1].slice(9, 13)).toEqual([0, 1, 1, 0]);
	expect(day.heat[0].every((n) => n === 0)).toBe(true);
	// The days and the week stay those of the period, so that another day can be chosen.
	expect(day.daily).toEqual(insights.daily);
	expect(day.week).toEqual(insights.week);
	expect(day.activeDays).toBe(2);
});

test("aggregate covers every session when the period has no start", () => {
	const now = new Date(2026, 5, 10, 12).getTime();
	const recent = summarize(session(now - 26 * HOUR, "recent"));
	const old = summarize(session(now - 40 * 24 * HOUR, "old"));
	const all = aggregate([old, recent], now, Number.POSITIVE_INFINITY);
	expect(all.sessions.map((s) => s.id)).toEqual(["recent", "old"]);
	expect(all.requests).toBe(4);
	// From the first day with a request to today.
	expect(all.daily).toHaveLength(41);
	expect(all.daily[0]).toMatchObject({ day: "2026-05-01", requests: 2 });
	expect(all.daily.at(-1)?.day).toBe("2026-06-10");
	expect(aggregate([], now, Number.POSITIVE_INFINITY).daily.map((stat) => stat.day)).toEqual(["2026-06-10"]);
	// The days go back 53 weeks at most; the totals still count what is older.
	const ancient = summarize(session(now - 500 * 24 * HOUR, "ancient"));
	const long = aggregate([ancient, recent], now, Number.POSITIVE_INFINITY);
	expect(long.daily).toHaveLength(371);
	expect(long.requests).toBe(4);
});

test("summarize keeps the recorded composition by hour, and aggregate sums it for the period", () => {
	const now = new Date(2026, 5, 10, 12).getTime();
	const start = now - 26 * HOUR;
	const turn = { type: "custom", customType: TURN_ENTRY, data: { time: start + 1000, ms: 10, toolMs: 0, activeMs: 10, sums: { system: 300, user: 100 } } };
	const summary = summarize([...session(start), turn]);
	// One of the two requests was recorded. Its estimate of 400 tokens is scaled to the 1000 tokens that the request sent.
	expect(Object.values(summary.composition)).toEqual([[1, 750, 0, 250, 0, 0, 0, 0, 0, 0]]);
	const insights = aggregate([summary, summary], now, 7);
	expect(insights.composition.requests).toBe(2);
	expect(insights.composition.sums).toMatchObject({ system: 1500, user: 500, tools: 0 });
	expect(aggregate([summary], now, 7, { day: "2026-06-10" }).composition.requests).toBe(0);
	// A summary cached by an older version has no composition.
	const { composition, ...legacy } = summary;
	expect(aggregate([legacy as any], now, 7).composition.requests).toBe(0);
});

test("calendar lays the days out by weekday and week", () => {
	const now = new Date(2026, 5, 10, 12).getTime(); // a Wednesday
	const rows = calendar(aggregate([], now, 7).daily);
	const days = (row: number) => rows[row].map((stat) => stat?.day.slice(5));
	expect(rows).toHaveLength(7);
	expect(days(0)).toEqual([undefined, "06-08"]);
	expect(days(2)).toEqual(["06-03", "06-10"]);
	expect(days(3)).toEqual(["06-04", undefined]);
	expect(days(6)).toEqual(["06-07", undefined]);
	expect(calendar([]).every((row) => row.length === 0)).toBe(true);
});

test("analyze places each event among the requests and estimates what it changed", () => {
	const stamp = (ms: number) => new Date(ms).toISOString();
	const result = (id: string, chars: number, timestamp: number) =>
		at({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "z".repeat(chars) }], isError: false, timestamp });
	const entries = [
		at({ role: "user", content: "hi", timestamp: 1000 }),
		at(assistant(2000)),
		result("r1", 800, 3000),
		result("r2", 400, 3500),
		{ type: "custom", customType: PRUNE_ENTRY, timestamp: stamp(4000), data: { ids: ["r1", "r2"] } },
		{ type: "custom", customType: PRUNE_ENTRY, timestamp: stamp(4500), data: { ids: ["r2"] } },
		{ type: "compaction", timestamp: stamp(5000), tokensBefore: 5000 },
		{ type: "branch_summary", timestamp: stamp(5500), summary: "s".repeat(400) },
		at(assistant(6000)),
		{ type: "model_change", timestamp: stamp(7000), provider: "p", modelId: "m2" },
		{ type: "compaction", timestamp: stamp(8000), tokensBefore: 7000 },
	];
	const events = analyze(entries).events;
	// A compaction is measured by the request after it: 5000 tokens before, 1000 sent after. The last one has no such request.
	expect(events.map((e) => [e.kind, e.after, e.delta])).toEqual([
		["drop", 1, -300],
		["restore", 1, 200],
		["compaction", 1, -4000],
		["branch summary", 1, 100],
		["model", 2, undefined],
		["compaction", 2, undefined],
	]);
	expect(events[0].detail).toBe("2 tool results, ≈300 tokens");
	expect(events[1].detail).toBe("1 tool result, ≈200 tokens");
	expect(eventKinds(events)).toEqual([["drop", 1], ["restore", 1], ["compaction", 2], ["branch summary", 1], ["model", 1]]);
});

test("expiryWarnAt gives the time of the cache expiry warning", () => {
	const now = 1_000_000;
	const stats = { usage: { tokens: 84200, contextWindow: 200000, percent: 42.1 }, cost: 0, requests: 3, cacheRate: 0.9, cacheUntil: now + 300_000 };
	expect(expiryWarnAt({}, stats, now)).toBeUndefined();
	expect(expiryWarnAt({ expiryWarnSeconds: 60 }, stats, now)).toBe(now + 240_000);
	// Less time is left than the setting asks for: the warning is due now.
	expect(expiryWarnAt({ expiryWarnSeconds: 600 }, stats, now)).toBe(now);
	expect(expiryWarnAt({ expiryWarnSeconds: 60 }, stats, now + 300_000)).toBeUndefined();
	expect(expiryWarnAt({ expiryWarnSeconds: 60 }, { ...stats, cacheUntil: undefined }, now)).toBeUndefined();
	expect(expiryText(stats, now + 240_000)).toBe("The prompt cache expires in about 1m0s. A request after that sends the 84.2k tokens of the context without the cache.");
	expect(expiryText({ ...stats, usage: undefined }, now + 240_000)).toBe("The prompt cache expires in about 1m0s. A request after that sends the whole context without the cache.");
});

test("exportMarkdown lists the request that each event followed and what the event changed", () => {
	const entries = [...session(0), { type: "compaction", timestamp: new Date(2 * HOUR).toISOString(), tokensBefore: 5000 }, at(assistant(3 * HOUR))];
	const text = exportMarkdown(view(entries), aggregate([], HOUR, 30));
	expect(text).toContain("| 2 | compaction | ≈−4.0k | 5.0k tokens before compaction |");
});
