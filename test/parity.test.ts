import { expect, test } from "bun:test";
import {
	analyze,
	attentionOf,
	commandShape,
	familyTotals,
	fileRows,
	filesUpTo,
	isSlow,
	MARK_KINDS,
	paramsOf,
	placeOf,
	programRanks,
	programsOf,
	tokensPerSecond,
	trendBars,
	TURN_ENTRY,
} from "../src/analyze.ts";
import { CHOICES, choiceOf, setChoice } from "../src/config.ts";
import { agentDetail, boardOf, chainOf, fleetSummary, readiness, type FleetEvent, type TaskRec } from "../src/fleet.ts";
import { fmtDay } from "../src/format.ts";
import { aggregate, skillSource, summarize } from "../src/insights.ts";
import { StreamClock } from "../src/stream.ts";

const HOUR = 3_600_000;
const usage = (input: number, output = 10) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { total: 0.01 } });
let seq = 0;
const at = (message: any, more: any = {}) => ({ type: "message", id: "e" + ++seq, timestamp: new Date(message.timestamp ?? 0).toISOString(), message, ...more });
const user = (timestamp: number, content = "do it") => at({ role: "user", content, timestamp });
const call = (id: string, name: string, args: any = {}) => ({ type: "toolCall", id, name, arguments: args });
const assistant = (timestamp: number, input: number, content: any[] = [{ type: "text", text: "ok" }]) =>
	at({ role: "assistant", model: "m1", stopReason: "stop", timestamp, usage: usage(input), content });
const result = (id: string, toolName: string, timestamp: number, more: any = {}) =>
	at({ role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text: "done" }], isError: false, timestamp, ...more });
const turn = (time: number, ms: number, more: any = {}) => ({ type: "custom", customType: TURN_ENTRY, data: { time, ms, toolMs: 0, activeMs: ms, sums: {}, ...more } });

test("programsOf lists every program of a pipeline, without cd and without wrappers", () => {
	expect(programsOf("cd x && sudo env A=1 npm test | tee log")).toEqual(["npm", "tee"]);
	expect(programsOf("timeout -k 5 30 ./bin/tool --x; nohup nice -n 5 make")).toEqual(["tool", "make"]);
	expect(programsOf("FOO=1 git status || time git diff")).toEqual(["git", "git"]);
	expect(programsOf("cd /x")).toEqual(["cd"]);
	expect(programsOf("")).toEqual([]);
});

test("analyze keeps all programs of a command, and programRanks counts uses and runs", () => {
	const a = analyze([
		user(1),
		assistant(2, 10, [call("b1", "bash", { command: "git status | head" }), call("b2", "bash", { command: "git add . && git commit -m x" })]),
	]);
	expect(a.commands.map((c) => [c.program, c.programs])).toEqual([["git", ["git", "head"]], ["git", ["git", "git"]]]);
	// git ran three times, in two commands.
	expect(programRanks(a.commands)).toEqual([{ program: "git", uses: 3, runs: 2 }, { program: "head", uses: 1, runs: 1 }]);
});

test("attentionOf names the slowest run, the program that failed most and the command repeated most", () => {
	const commands: any[] = [
		{ command: "bun test", program: "bun", programs: ["bun"], ok: false, ms: 400 },
		{ command: "bun test", program: "bun", programs: ["bun"], ok: false, ms: 12_000 },
		{ command: "ls", program: "ls", programs: ["ls"], ok: false },
		{ command: "bun test", program: "bun", programs: ["bun"], ok: true, ms: 900 },
	];
	expect(attentionOf(commands)).toEqual({ slowest: 1, failing: { program: "bun", count: 2 }, repeated: { command: "bun test", count: 3 } });
	expect(commands.map(isSlow)).toEqual([false, true, false, false]);
	// A run under one second is not worth a look; one failure and no repeat give nothing.
	expect(attentionOf([{ command: "ls", program: "ls", programs: ["ls"], ok: true, ms: 300 } as any])).toEqual({});
});

test("commandShape tells the lines of a command, and whether it holds a heredoc or an inline script", () => {
	expect(commandShape("cat <<'EOF' > f\nhello\nEOF")).toEqual({ lines: 3, heredoc: true, inline: false });
	expect(commandShape("python3 -c 'print(1)'")).toEqual({ lines: 1, heredoc: false, inline: true });
	expect(commandShape("ls -la")).toEqual({ lines: 1, heredoc: false, inline: false });
});

test("analyze logs questions, delegations and tasks as events", () => {
	const a = analyze([
		user(1),
		assistant(2, 10, [
			call("q", "ask_user_question", { questions: [{ question: "Which one?" }, { question: "How many?" }] }),
			call("a", "Agent", { subagent_type: "Explore", description: "find it", prompt: "p" }),
			call("t", "TaskCreate", { subject: "Write tests", description: "d" }),
		]),
		result("s", "codemode", 3, { nestedCalls: { calls: [{ id: "s/1", name: "TaskUpdate", status: "ok", arguments: { taskId: "4", status: "completed" } }, { id: "s/2", name: "TaskUpdate", status: "ok", arguments: { taskId: "5", status: "in_progress" } }] } }),
	]);
	expect(a.events.map((e) => [e.kind, e.detail, e.after])).toEqual([
		["question", "2 questions: Which one?", 1],
		["delegation", "Explore: find it", 1],
		["task", "Write tests", 1],
		["task done", "#4", 1],
	]);
});

test("analyze counts the messages that a compaction summarized", () => {
	const entries = [user(1), assistant(2, 10), user(3), assistant(4, 20), user(5), assistant(6, 30)];
	const kept = entries[4].id;
	const a = analyze([...entries, { type: "compaction", timestamp: new Date(7).toISOString(), tokensBefore: 900, firstKeptEntryId: kept }, user(8), assistant(9, 5), { type: "compaction", timestamp: new Date(10).toISOString(), tokensBefore: 500 }]);
	// The first summary replaced the four messages before the kept one; the second names no kept entry and replaced the four that were left.
	expect(a.events.filter((e) => e.kind === "compaction").map((e) => e.replaced)).toEqual([4, 4]);
});

test("analyze sets the time that an input waited for the user apart", () => {
	const a = analyze([
		user(1000),
		assistant(2000, 10, [call("q", "ask_user_question", { questions: [{ question: "Which?" }] }), call("b", "bash", { command: "ls" })]),
		result("q", "ask_user_question", 60_000, { durationMs: 50_000 }),
		result("b", "bash", 61_000, { durationMs: 700 }),
		assistant(62_000, 20),
	]);
	expect(a.inputs.map((i) => [i.ms, i.waitMs])).toEqual([[61_000, 50_000]]);
});

test("StreamClock times the first token and the blocks of a reply", () => {
	const clock = new StreamClock(1000);
	clock.note("start", 1100);
	clock.note("thinking_start", 1400);
	clock.note("thinking_delta", 1500);
	clock.note("thinking_end", 2000);
	clock.note("text_start", 2000);
	clock.note("text_end", 2300);
	clock.note("toolcall_start", 2300);
	clock.note("toolcall_end", 2400);
	clock.note("toolcall_start", 2400);
	// The last block has no end: it ends with the reply.
	expect(clock.result(2700)).toEqual({ ttft: 400, spans: { reasoning: [600, 1], answers: [300, 1], toolCalls: [400, 2] } });
	// A reply that came without stream events has no split.
	expect(new StreamClock(0).result(50)).toEqual({});
});

test("analyze sums the stream times of the recorded turns and tells the output speed", () => {
	const a = analyze([
		user(1),
		assistant(10, 100),
		turn(10, 3000, { ttft: 1000, spans: { reasoning: [500, 1], answers: [1500, 2] } }),
		assistant(20, 200),
		turn(20, 2000, { ttft: 500, spans: { answers: [500, 1], toolCalls: [1000, 3] } }),
		assistant(30, 300),
		turn(30, 4000),
	]);
	expect(a.requests.map((r) => r.ttft)).toEqual([1000, 500, undefined]);
	expect(a.timing).toEqual({
		activeMs: 9000,
		modelMs: 9000,
		toolMs: 0,
		ttftMs: 1500,
		streamMs: 3500,
		streamed: 2,
		streamOutput: 20,
		spans: { reasoning: [500, 1], toolCalls: [1000, 3], answers: [2000, 3] },
	});
	// 20 output tokens in 3.5 seconds after the first token.
	expect(tokensPerSecond(a.timing)).toBeCloseTo(20 / 3.5);
	expect(tokensPerSecond(analyze([user(1), assistant(2, 5)]).timing)).toBeUndefined();
});

test("trendBars flag workflow events, the longest request and the largest growth, in the order of MARK_KINDS", () => {
	const a = analyze([
		user(1),
		assistant(10, 100, [call("a", "Agent", { subagent_type: "Explore", description: "x" })]),
		turn(10, 300),
		{ type: "custom_message", customType: "subagent-notification", timestamp: new Date(12).toISOString(), content: "done", details: { id: "a1" } },
		{ type: "model_change", timestamp: new Date(13).toISOString(), provider: "p", modelId: "m2" },
		assistant(20, 900),
		turn(20, 800),
		{ type: "custom_message", customType: "note", timestamp: new Date(22).toISOString(), content: "n" },
		user(25, '<skill name="x" location="/s/x/SKILL.md">\nbody\n</skill>\n\ngo'),
		assistant(30, 950, [call("t", "TaskCreate", { subject: "s" }), call("u", "TaskUpdate", { taskId: "1", status: "completed" })]),
		turn(30, 100),
		assistant(40, 400),
	]);
	expect(trendBars(a, false, false).map((bar) => bar.marks)).toEqual([
		undefined,
		// The second request is the longest and grew most; the delegation, the notification and the model change came before it.
		["longest", "growth", "delegation", "agent", "model"],
		// An injection by another extension is no flag.
		["skill"],
		["task done", "task"],
	]);
	expect([...MARK_KINDS]).toEqual(["compaction", "drop", "restore", "task done", "task", "question", "longest", "growth", "delegation", "agent", "skill", "model"]);
	// By human input: the first input ends at request 2, the second at request 4.
	expect(trendBars(a, true, false).map((bar) => bar.marks)).toEqual([["longest", "delegation", "agent", "model"], ["task done", "task", "skill"]]);
});

test("filesUpTo keeps the operations made up to a request, and the files can be ordered by changed lines", () => {
	const a = analyze([
		user(1),
		assistant(2, 10, [call("r", "read", { path: "/a.ts", offset: 20, limit: 30 }), call("w", "write", { path: "/b.ts", content: "1\n2\n3\n4\n" })]),
		assistant(3, 20, [call("e", "edit", { path: "/a.ts", oldText: "x\ny", newText: "x\nz\nw" }), call("r2", "read", { path: "/c.ts" })]),
	]);
	const read = a.files.find((f) => f.path === "/a.ts")?.ops[0];
	expect(read?.range).toEqual([20, 30]);
	expect(a.files.find((f) => f.path === "/c.ts")?.ops[0].range).toBeUndefined();
	expect(filesUpTo(a.files, 1).map((f) => [f.path, f.reads, f.edits, f.added, f.removed, f.ops.length])).toEqual([["/a.ts", 1, 0, 0, 0, 1], ["/b.ts", 0, 0, 4, 0, 1]]);
	expect(filesUpTo(a.files, 2)).toEqual(a.files);
	expect(fileRows(a.files, "lines").map((f) => f.path)).toEqual(["/b.ts", "/a.ts", "/c.ts"]);
});

test("familyTotals sets the session apart from its subagents", () => {
	const totals = { input: 100, output: 20, cacheRead: 300, cacheWrite: 80, cost: 1.5 };
	const agents: any[] = [{ id: "a", tokens: 1000, cost: 0.5 }, { id: "b", parent: "a", tokens: 200, cost: 0.25 }, { id: "c" }];
	expect(familyTotals(totals, agents)).toEqual({ own: { tokens: 500, cost: 1.5 }, agents: { count: 3, tokens: 1200, cost: 0.75 }, tokens: 1700, cost: 2.25 });
});

test("placeOf tells the human input of a request and its place among the requests of the input", () => {
	const a = analyze([user(1), assistant(2, 10), assistant(3, 10), user(4), assistant(5, 10)]);
	expect([0, 1, 2].map((i) => placeOf(a, i))).toEqual([{ input: 1, step: 1, steps: 2 }, { input: 1, step: 2, steps: 2 }, { input: 2, step: 1, steps: 1 }]);
	expect(placeOf(a, 9)).toBeUndefined();
});

test("paramsOf lists the parameters of a tool schema with their types", () => {
	const schema = {
		type: "object",
		required: ["path"],
		properties: {
			path: { type: "string", description: "File to read" },
			mode: { type: "string", enum: ["a", "b"] },
			lines: { type: "array", items: { type: "number" } },
			where: { anyOf: [{ type: "string" }, { type: "object", properties: { a: {}, b: {} } }] },
		},
	};
	const rows = [
		{ name: "path", type: "string", required: true, description: "File to read" },
		{ name: "mode", type: "string (enum)", required: false, description: "" },
		{ name: "lines", type: "array<number>", required: false, description: "" },
		{ name: "where", type: "string | object{2}", required: false, description: "" },
	];
	expect(paramsOf(schema)).toEqual(rows);
	// A declaration holds its schema under one of three names.
	expect(paramsOf({ name: "read", input_schema: schema })).toEqual(rows);
	expect(paramsOf({ function: { name: "read", parameters: schema } })).toEqual(rows);
	expect(paramsOf(undefined)).toEqual([]);
});

test("the fleet summary, the detail of an agent, the chain of blockers and the readiness of a task", () => {
	const agents: any[] = [
		{ id: "a1", type: "Explore", description: "find it", status: "running" },
		{ id: "a2", type: "Plan", description: "plan it", status: "completed", result: "the plan" },
	];
	const timeline: FleetEvent[] = [
		{ time: 1, kind: "delegation", agent: "a1", title: "Explore: find it", body: "look everywhere" },
		{ time: 2, kind: "steer", agent: "a1", title: "message to the agent", body: "faster" },
		{ time: 3, kind: "delegation", agent: "a2", title: "Plan: plan it", body: "make a plan" },
		{ time: 4, kind: "notification", agent: "a2", title: "plan it — completed" },
		{ time: 5, kind: "task", title: "task created: x" },
	];
	const tasks: TaskRec[] = [
		{ id: "1", subject: "one", status: "completed", blocks: [], blockedBy: [] },
		{ id: "2", subject: "two", status: "pending", owner: "Plan", blocks: [], blockedBy: ["1"] },
		{ id: "3", subject: "three", status: "pending", blocks: [], blockedBy: ["2"] },
		{ id: "4", subject: "four", status: "in_progress", blocks: [], blockedBy: ["3", "1"] },
	];
	const board = boardOf(tasks, agents);
	// Four tasks and two delegations; a steer and a notification are messages.
	expect(fleetSummary(agents, timeline, board)).toEqual({ agents: 2, running: 1, items: 6, messages: 2 });
	expect(agentDetail(agents[1], timeline, board)).toEqual({
		prompt: "make a plan",
		reply: "the plan",
		tasks: [expect.objectContaining({ id: "2", subject: "two" })],
		events: [timeline[2], timeline[3]],
	});
	expect(agentDetail(agents[0], timeline, board)).toMatchObject({ prompt: "look everywhere", reply: undefined, tasks: [] });
	expect(chainOf(tasks, "4")).toEqual(["3", "1", "2"]);
	expect(chainOf(tasks, "1")).toEqual([]);
	const items = board.flatMap((group) => group.items);
	// Task 1 is done, so task 2 is ready; task 3 waits for task 2. A task in progress and a delegation have no readiness.
	expect(items.map((item) => [item.id, readiness(item)])).toEqual([["1", undefined], ["3", "blocked"], ["4", undefined], ["2", "ready"], ["a2", undefined], ["a1", undefined]]);
});

const session = (start: number, id: string, cwd = "/work/proj") => [
	{ type: "session", id, timestamp: new Date(start).toISOString(), cwd },
	user(start, "first question"),
	assistant(start + 1000, 100, [call("c1", "read", { path: cwd + "/.pi/skills/local/SKILL.md" }), call("c2", "bash", { command: "git status | head" })]),
	user(start + 2000, "second question"),
	assistant(start + 3000, 100, [call("c3", "read", { path: "/home/u/.pi/agent/skills/mine/SKILL.md" }), call("c4", "read", { path: "/home/u/.pi/agent/git/github.com/o/r/skills/pack/SKILL.md" })]),
];

test("summarize keeps the last human input and where each skill comes from", () => {
	const summary = summarize(session(HOUR, "s1"));
	expect(summary.lastUser).toBe("second question");
	expect(summary.programs).toEqual({ git: 1, head: 1 });
	expect(summary.skillInfo).toEqual({
		local: ["/work/proj/.pi/skills/local/SKILL.md", "project"],
		mine: ["/home/u/.pi/agent/skills/mine/SKILL.md", "user"],
		pack: ["/home/u/.pi/agent/git/github.com/o/r/skills/pack/SKILL.md", "package"],
	});
	expect(skillSource("/x/node_modules/p/skills/a/SKILL.md", "/work")).toBe("package");
});

test("aggregate counts the sessions of each day and of each tool, and narrows the figures to a range of days", () => {
	const now = new Date(2026, 5, 10, 12).getTime();
	const day = (back: number) => fmtDay(now - back * 24 * HOUR);
	const summaries = [summarize(session(now - 2 * HOUR, "today")), summarize(session(now - 26 * HOUR, "yesterday")), summarize(session(now - 26 * HOUR, "also", "/work/other")), summarize(session(now - 74 * HOUR, "older"))];
	const insights = aggregate(summaries, now, 30);
	expect(insights.week.slice(-2)).toEqual([
		{ day: day(1), requests: 4, tokens: 440, cost: 0.04, sessions: 2 },
		{ day: day(0), requests: 2, tokens: 220, cost: 0.02, sessions: 1 },
	]);
	// Name, uses, last use, sessions.
	expect(insights.tools[0]).toEqual(["read", 12, now - 2 * HOUR + 3000, 4]);
	expect(insights.programs.map(([name, uses, , sessions]) => [name, uses, sessions])).toEqual([["git", 4, 4], ["head", 4, 4]]);
	expect(insights.skillInfo.mine).toEqual(["/home/u/.pi/agent/skills/mine/SKILL.md", "user"]);
	const range = aggregate(summaries, now, 30, { day: day(3), until: day(1) });
	expect(range).toMatchObject({ day: day(3), until: day(1), requests: 6 });
	expect(range.sessions.map((s) => s.id).sort()).toEqual(["also", "older", "yesterday"]);
	expect(aggregate(summaries, now, 30, { day: day(1) }).requests).toBe(4);
});

test("the trend fit and the file order by lines are view defaults", () => {
	const config = {};
	expect(choiceOf(config, "fit")).toBe("off");
	expect(setChoice(config, "fit", "200")).toBe(true);
	expect(choiceOf(config, "fit")).toBe("200");
	expect(setChoice(config, "fit", "50")).toBe(false);
	expect(CHOICES.files.values).toContain("lines");
});
