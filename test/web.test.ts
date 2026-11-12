import { afterAll, expect, test } from "bun:test";
import { analyze, rowsOf, type ViewData } from "../src/analyze.ts";
import type { SessionSummary } from "../src/insights.ts";
import { type Outcome, startWeb } from "../src/web.ts";

const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { total: 0.01 } });
const assistant = (timestamp: number, input: number, content: any[]) => ({ role: "assistant", model: "m1", stopReason: "stop", timestamp, usage: usage(input, 10), content });
const messages = [
	{ role: "user", content: "list the files", timestamp: 1000 },
	assistant(2000, 100, [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }]),
	{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "a.txt\nb.txt" }], isError: false, timestamp: 3000 },
	assistant(4000, 150, [{ type: "text", text: "Two files." }]),
];
const entries = messages.map((message, i) => ({ type: "message", id: `e${i}`, parentId: i ? `e${i - 1}` : null, timestamp: new Date(message.timestamp).toISOString(), message }));

const view = (other?: string): ViewData => ({
	analysis: analyze(entries),
	current: rowsOf(messages, undefined, [], true),
	usage: { tokens: 160, contextWindow: 1000, percent: 16 },
	model: "m1",
	declared: ["bash"],
	factor: 1,
	hints: [],
	dropped: [],
	config: { budget: 5 },
	agents: [],
	running: false,
	other,
	// The context of a request: the messages before its answer.
	reconstruct: (request) => rowsOf(messages.slice(0, request.n === 1 ? 1 : 3), undefined, [], true),
});

const summary: SessionSummary = {
	id: "s1",
	cwd: "/work/proj",
	name: "Saved one",
	start: Date.now() - 2000,
	end: Date.now() - 1000,
	requests: 2,
	userInputs: 1,
	toolCalls: 1,
	tokens: 270,
	cost: 0.02,
	models: { m1: { [Math.floor(Date.now() / 3_600_000)]: [2, 270, 0.02] } },
	tools: { bash: 1 },
	programs: { ls: 1 },
	skills: {},
	composition: {},
	file: "/sessions/s1.jsonl",
};

const dropped: [string[], boolean][] = [];
const settings: [string, string][] = [];
let collected = 0;
const server = await startWeb({
	collect() {
		collected++;
		return view();
	},
	isLive: () => true,
	loadSummaries: async () => [summary],
	openSession: (_file, title) => view(title),
	setDropped: (ids, on) => void dropped.push([ids, on]),
	cwd: "/work/proj",
	title: () => "Current one",
	changeSetting(setting, value): Outcome {
		settings.push([setting, value]);
		return { message: "Saved.", level: "info" };
	},
});
afterAll(() => server.close());

const token = new URL(server.url).searchParams.get("t") ?? "";
const address = (path: string, query: Record<string, string | number> = {}) =>
	new URL(`${path}?${new URLSearchParams({ t: token, ...query } as Record<string, string>)}`, server.url).href;
const get = async (name: string, query: Record<string, string | number> = {}) => {
	const response = await fetch(address(`api/${name}`, query));
	return { status: response.status, body: (await response.json()) as any };
};
const post = async (name: string, body: unknown) => {
	const response = await fetch(address(`api/${name}`), { method: "POST", body: JSON.stringify(body) });
	return { status: response.status, body: (await response.json()) as any };
};

test("web serves the page to anyone and the data only with the token", async () => {
	expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}$/);
	const page = await fetch(server.url);
	expect(page.headers.get("content-type")).toContain("text/html");
	expect(await page.text()).toContain('<script src="app.js">');
	for (const asset of ["app.js", "style.css"]) expect((await fetch(new URL(asset, server.url))).status).toBe(200);
	expect((await fetch(new URL("api/data", server.url))).status).toBe(403);
	expect((await fetch(new URL("api/data?t=wrong", server.url))).status).toBe(403);
	expect((await get("nothing")).status).toBe(404);
	// A name that every object inherits is not a route.
	expect((await get("constructor")).status).toBe(404);
	expect((await fetch(new URL("../src/web.ts", server.url))).status).toBe(404);
});

test("web data carries the session without the content of the items", async () => {
	const { status, body } = await get("data");
	expect(status).toBe(200);
	expect(body.title).toBe("Current one");
	expect(body.readOnly).toBe(false);
	expect(body.live).toBe(true);
	expect(body.requests.length).toBe(2);
	expect(body.requests[0].rows).toBeUndefined();
	expect(body.current.map((row: any) => row.cat)).toEqual(["user", "toolCalls", "toolResults", "answers"]);
	expect(body.current.some((row: any) => "text" in row)).toBe(false);
	expect(body.config).toEqual({ budget: 5 });
	expect(body.footer).toEqual(["context", "cost"]);
	expect(body.labels.toolResults).toBe("Tool results");
});

test("web collects the session once until it changes, and refuses the text of a changed context", async () => {
	const before = collected;
	const { body } = await get("data");
	expect((await get("text", { i: 2, v: body.version })).body.text).toBe("a.txt\nb.txt");
	expect(collected - before).toBeLessThanOrEqual(1);
	server.changed();
	const stale = await get("text", { i: 2, v: body.version });
	expect(stale.status).toBe(400);
	expect((await get("data")).body.version).toBeGreaterThan(body.version);
});

test("web shows what a request was assembled from and what changed since the request before", async () => {
	const { body } = await get("request", { n: 2 });
	expect(body.rebuilt).toBe(true);
	expect(body.since).toBe(1);
	expect(body.rows.map((row: any) => row.cat)).toEqual(["user", "toolCalls", "toolResults"]);
	expect(body.marks).toEqual(["", "+", "+"]);
	expect(body.removed).toEqual([]);
	expect(body.items).toMatchObject({ user: 0, toolCalls: 1, toolResults: 1 });
	expect(body.factor).toBeGreaterThan(1);
	expect((await get("text", { n: 2, i: 2 })).body.text).toBe("a.txt\nb.txt");
	expect((await get("request", { n: 1 })).body.marks).toBeUndefined();
	expect((await get("request", { n: 9 })).status).toBe(400);
});

test("web drops tool results and changes settings through the host", async () => {
	expect((await post("drop", { ids: ["c1"], dropped: true })).status).toBe(200);
	expect((await post("drop", { ids: ["c1"], dropped: false })).status).toBe(200);
	expect(dropped).toEqual([[["c1"], true], [["c1"], false]]);
	expect((await post("drop", { ids: [] })).status).toBe(400);
	expect((await post("setting", { setting: "warn", value: "70" })).body).toEqual({ message: "Saved.", level: "info" });
	expect(settings).toEqual([["warn", "70"]]);
	// The routes that change something do not answer a GET.
	expect((await get("drop")).status).toBe(404);
});

test("web opens only the saved sessions that Insights listed, read-only", async () => {
	expect((await get("data", { session: "/sessions/s1.jsonl" })).status).toBe(400);
	const insights = (await get("insights", { days: 7, sort: "cost" })).body;
	expect(insights.days).toBe(7);
	expect(insights.sessions).toEqual([expect.objectContaining({ name: "Saved one", file: "/sessions/s1.jsonl", requests: 2 })]);
	expect(insights.sessions[0].models).toBeUndefined();
	expect(insights.sessions[0].composition).toBeUndefined();
	expect(insights.daily).toHaveLength(8);
	// "all" has no start, and a day narrows the figures to that day.
	const today = insights.daily.at(-1).day;
	const all = (await get("insights", { days: "all", day: today })).body;
	expect(all.day).toBe(today);
	expect(all.requests).toBe(2);
	expect(all.daily.at(-1)).toMatchObject({ day: today, requests: 2 });
	expect((await get("insights", { days: "all", day: "2000-01-01" })).body.requests).toBe(0);
	expect((await get("insights", { days: 7, day: "today; drop" })).body.day).toBeUndefined();
	const saved = (await get("data", { session: "/sessions/s1.jsonl" })).body;
	expect(saved.title).toBe("Saved one");
	expect(saved.readOnly).toBe(true);
	expect(saved.live).toBe(false);
	expect((await get("data", { session: "/etc/passwd" })).status).toBe(400);
});

test("web tells an open page that the session changed", async () => {
	const response = await fetch(address("api/events"));
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let seen = decoder.decode((await reader.read()).value);
	expect(seen).toContain(": connected");
	server.changed();
	server.changed();
	while (!seen.includes("data: change")) seen += decoder.decode((await reader.read()).value);
	expect(seen.match(/data: change/g)?.length).toBe(1);
	await reader.cancel();
});
