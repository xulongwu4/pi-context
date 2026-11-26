import { expect, test } from "bun:test";
import { type RequestRec, type Row, type RowSource, rowsOf } from "../src/analyze.ts";
import { Dna, listOf, runsOf } from "../src/dna.ts";

const assistant = (timestamp: number, content: any[]) => ({ role: "assistant", timestamp, content });
const result = (timestamp: number, toolCallId: string, toolName: string, text: string) => ({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp });
const tool = (name: string) => ({ name, description: "Does " + name, parameters: { type: "object" } });

const messages: any[] = [
	{ role: "user", content: "start", timestamp: 1000 },
	{ role: "system", content: "You are an agent.", sections: { rules: "Be brief." }, toolsAdded: [tool("bash"), tool("read")] },
	assistant(2000, [
		{ type: "thinking", thinking: "I read the skill." },
		{ type: "toolCall", id: "s1", name: "read", arguments: { path: "/skills/tdd/SKILL.md" } },
	]),
	result(3000, "s1", "read", "Write the test first."),
	{ role: "custom", customType: "note", content: "a note for the model", display: true, timestamp: 3500 },
	assistant(4000, [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }]),
	result(5000, "c1", "bash", "a.txt\nb.txt"),
	{ role: "system", content: " More rules.", toolsRemoved: ["read"] },
	assistant(6000, [{ type: "text", text: "Two files." }]),
];
/** Messages that each request is sent with. */
const sent = [2, 5, 7, 8];
const requests = sent.map((_, i) => ({ n: i + 1, time: 2000 + i * 1000, context: 100 + i * 50 }) as unknown as RequestRec);
const source: RowSource = { messages: (request) => messages.slice(0, sent[request.n - 1]), rows: (list) => rowsOf(list) };

const item = (row: Row) => [row.cat, row.tokens, row.label, row.preview.slice(0, 100)];
/** The items of a bar, without the note about their line. */
const itemsOf = (dna: Dna, runs: number[]) => listOf(runs).map((number) => dna.items[number].slice(0, 4));

test("runs hold item numbers in order", () => {
	expect(runsOf([3, 4, 5, 9, 0, 1])).toEqual([3, 3, 9, 1, 0, 2]);
	expect(listOf([3, 3, 9, 1, 0, 2])).toEqual([3, 4, 5, 9, 0, 1]);
	expect(runsOf([])).toEqual([]);
});

test("a strand holds the rows of its request, read message by message", async () => {
	const dna = new Dna();
	const bars = await dna.bars(requests, source);
	expect(bars.map((bar) => bar.n)).toEqual([1, 2, 3, 4]);
	for (const [i, bar] of bars.entries()) {
		const rows = rowsOf(messages.slice(0, sent[i]));
		expect(rows.length).toBeGreaterThan(2);
		expect(itemsOf(dna, bar.runs)).toEqual(rows.map(item));
		expect(bar.scale).toBeCloseTo(requests[i].context / rows.reduce((total, row) => total + row.tokens, 0), 6);
	}
	// The result of a skill read counts as a skill, also when its message is read alone.
	expect(itemsOf(dna, bars[1].runs).map((each) => each[0])).toContain("skills");
});

test("the same item has the same number in every request, and a changed tool list is another size of the same item", async () => {
	const dna = new Dna();
	const bars = await dna.bars(requests, source);
	const lists = bars.map((bar) => listOf(bar.runs));
	// Requests 1 to 3 start alike: user, system, tool schemas.
	expect(lists[1].slice(0, lists[0].length)).toEqual(lists[0]);
	expect(lists[2].slice(0, lists[1].length)).toEqual(lists[1]);
	const tools = (list: number[]) => list.find((number) => dna.items[number][0] === "tools") as number;
	expect(tools(lists[3])).not.toBe(tools(lists[2]));
	expect(dna.items[tools(lists[3])][4]).toBe(tools(lists[0]));
	expect(dna.items[tools(lists[0])][4]).toBeUndefined();
	// A later call numbers no item again.
	const count = dna.items.length;
	expect(await dna.bars(requests, source)).toEqual(bars);
	expect(dna.items.length).toBe(count);
});

test("a message is read once for all the requests that hold it", async () => {
	let read = 0;
	const counted = messages.map((message) =>
		message.role === "system"
			? message
			: new Proxy(message, {
					get(target, key) {
						if (key === "content") read++;
						return target[key];
					},
				}),
	);
	const told: RowSource = { ...source, messages: (request) => counted.slice(0, sent[request.n - 1]) };
	// The last request holds every message.
	await new Dna().bars(requests.slice(3), told);
	const once = read;
	expect(once).toBeGreaterThan(5);
	read = 0;
	await new Dna().bars(requests, told);
	expect(read).toBe(once);
});

test("a request takes the rows that were recorded for it", async () => {
	const rows: Row[] = [
		{ cat: "system", tokens: 40, label: "system", preview: "edited before the request" },
		{ cat: "user", tokens: 2, label: "user", preview: "start", time: 1000 },
	];
	const dna = new Dna();
	const [first, second] = await dna.bars([{ ...requests[0], rows }, requests[1]], source);
	expect(itemsOf(dna, first.runs)).toEqual(rows.map(item));
	expect(first.scale).toBeCloseTo(100 / 42, 6);
	// The user message is the item that the session tells as well.
	expect(listOf(second.runs)).toContain(listOf(first.runs)[1]);
	// Only the items that were read from the session are marked as rebuilt.
	expect(first.rebuilt).toBeUndefined();
	expect(second.rebuilt).toBe(true);
	// The items of a request stay those of its rows when the rows are gone.
	expect((await dna.bars([requests[0]], source))[0]).toEqual(first);
	// Without rows and without a session to read, the items are not known.
	expect((await new Dna().bars(requests.slice(0, 1), undefined))[0]).toEqual({ n: 1, time: 2000, runs: [], scale: 1 });
});

test("changes tell the items that came and grew, and those that left and shrank", async () => {
	const dna = new Dna();
	const first = { ...requests[3], n: 9, time: 9000 };
	const bars = await dna.bars(requests, source, true);
	const pairs = (list: number[] = []) => Array.from({ length: list.length / 2 }, (_, i) => [dna.items[list[i * 2]][2], list[i * 2 + 1]]);
	// The first bar is new as a whole.
	expect(pairs(bars[0].up)).toEqual(itemsOf(dna, bars[0].runs).map((each) => [each[2], each[1]]));
	expect(bars[0].down).toEqual([]);
	// Request 2 adds what came after request 1.
	expect(listOf(runsOf((bars[1].up ?? []).filter((_, i) => i % 2 === 0)))).toEqual(listOf(bars[1].runs).slice(listOf(bars[0].runs).length));
	expect(bars[1].down).toEqual([]);
	// Request 4 has a longer system prompt and one tool schema less: each is one item that changed its size.
	const sizes = (n: number) => Object.fromEntries(itemsOf(dna, bars[n].runs).map((each) => [each[0], each[1] as number]));
	const before = sizes(2);
	const after = sizes(3);
	expect(after.system).toBeGreaterThan(before.system);
	expect(after.tools).toBeLessThan(before.tools);
	expect(pairs(bars[3].up)).toEqual([["system", after.system - before.system]]);
	expect(pairs(bars[3].down)).toEqual([["1 tool schemas", before.tools - after.tools]]);
	// With a request before the first bar, the first bar tells its change since that request.
	const [only] = await dna.bars([requests[0]], { ...source, messages: (request) => messages.slice(0, request.n === 9 ? 8 : 2) }, true, first);
	expect(pairs(only.up)).toEqual([["2 tool schemas", before.tools - after.tools]]);
	expect(pairs(only.down).length).toBeGreaterThan(3);
});
