import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, programOf, rowsOf, sumByCategory } from "../src/analyze.ts";
import { applyAffixes, loadConfig, saveConfig } from "../src/config.ts";
import { bar, fmtDuration, fmtTokens } from "../src/format.ts";
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
	expect(fmtTokens(null)).toBe("?");
	expect(fmtDuration(59000)).toBe("59s");
	expect(fmtDuration(723000)).toBe("12m3s");
	expect(bar(0.5, 4)).toBe("██░░");
	expect(bar(Number.NaN, 2)).toBe("░░");
});

test("report lists usage, composition and largest items", () => {
	const text = report({
		analysis: analyze([]),
		current: rowsOf(messages),
		usage: { tokens: 84200, contextWindow: 200000, percent: 42.1 },
		model: "m1",
		timing: { activeMs: 0, modelMs: 0, toolMs: 0 },
	});
	expect(text).toContain("Context: 84.2k / 200.0k tokens (42%)");
	expect(text).toContain("System prompt");
	expect(text).toContain("Skill injections");
	expect(text).toContain("Largest items:");
});