import { type Category, isSkillRead, type RequestRec, type Row, type RowSource, rowsOf, scaleOf } from "./analyze.ts";

/** Longest time that the reading of the strands keeps other work waiting. */
const SLICE_MS = 20;
/** Characters of a preview that the page gets. */
const PREVIEW_CHARS = 100;

/** An item as the page gets it: category, estimated tokens, label, preview, and for another size of an earlier item the number of that item. */
export type DnaItem = [cat: Category, tokens: number, label: string, preview: string, same?: number];

/** The items of one bar of the trend. */
export interface DnaBar {
	/** Number and time of the request. */
	n: number;
	time: number;
	/** The items in the order the model reads them, as runs of item numbers: first number, count, first number, count. Empty when the items are not known. */
	runs: number[];
	/** Scales the estimates of the items to the size that the provider reported. */
	scale: number;
	/** The items are rebuilt from the session: pi-context has no record of what the request sent. */
	rebuilt?: true;
	/** With changes: the items that are new or grew since the bar before, and those that left or shrank, as item number, tokens, item number, tokens. */
	up?: number[];
	down?: number[];
}

/** The item that changes its size and stays the same item: the system prompt, the tool schemas, the skill catalog. */
const lineOf = (row: Row) => (row.cat === "system" || row.cat === "tools" ? row.cat : row.label === "skill catalog" ? row.label : undefined);

/** The item numbers as runs: first number, count. */
export function runsOf(list: number[]): number[] {
	const runs: number[] = [];
	for (const item of list) {
		const end = runs.length - 2;
		if (end >= 0 && runs[end] + runs[end + 1] === item) runs[end + 1]++;
		else runs.push(item, 1);
	}
	return runs;
}

/** The item numbers of runs. */
export function listOf(runs: number[]): number[] {
	const list: number[] = [];
	for (let r = 0; r < runs.length; r += 2) {
		for (let i = 0; i < runs[r + 1]; i++) list.push(runs[r] + i);
	}
	return list;
}

/**
 * The items of the requests of one session, for the DNA trend: each item has a number, and the same item has the same number in every request.
 * A request takes the rows that pi-context recorded for it. Without them, its rows are rebuilt from the session:
 * each message is read once, so a session of many requests does not cost the rows of every request.
 */
export class Dna {
	/** Tells the page which numbering its items have. */
	readonly id = Math.random().toString(36).slice(2);
	readonly items: DnaItem[] = [];
	private numbers = new Map<string, number>();
	/** First item of each line of {@link lineOf}. */
	private lines = new Map<string, number>();
	private byMessage = new WeakMap<object, number[]>();
	private skillCalls = new Set<string>();
	/** The runs of each request, by the time of the request. */
	private strands = new Map<number, number[]>();
	/** The requests whose runs were rebuilt from the session, by their time. */
	private rebuilt = new Set<number>();
	private changes = new Map<string, { up: number[]; down: number[] }>();
	/** The requests are read one after the other, also when two pages ask at once. */
	private queue: Promise<unknown> = Promise.resolve();

	private number(row: Row): number {
		const key = [row.cat, row.label, row.tokens, row.time ?? "", row.id ?? "", row.preview].join("\n");
		let number = this.numbers.get(key);
		if (number === undefined) {
			number = this.items.length;
			this.numbers.set(key, number);
			const item: DnaItem = [row.cat, row.tokens, row.label, row.preview.slice(0, PREVIEW_CHARS)];
			const line = lineOf(row);
			if (line !== undefined) {
				const first = this.lines.get(line);
				if (first === undefined) this.lines.set(line, number);
				else item.push(first);
			}
			this.items.push(item);
		}
		return number;
	}

	/** The items of one message that is not a system message. */
	private ofMessage(message: any): number[] {
		if (typeof message !== "object" || message === null) return [];
		let items = this.byMessage.get(message);
		if (items) return items;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) if (block?.type === "toolCall" && isSkillRead(block)) this.skillCalls.add(block.id);
		}
		// Without declarations, the rows hold no tool schemas.
		const rows = rowsOf([message], {});
		if (message.role === "toolResult" && this.skillCalls.has(message.toolCallId)) for (const row of rows) row.cat = "skills";
		items = rows.map((row) => this.number(row));
		this.byMessage.set(message, items);
		return items;
	}

	/** The item numbers of a request. `head` keeps the items of the system messages of the request read before. */
	private read(request: RequestRec, source: RowSource | undefined, head: { messages: any[]; items: number[] }): number[] {
		if (request.rows) return request.rows.map((row) => this.number(row));
		if (!source) return [];
		const messages = source.messages(request);
		const system = messages.filter((message) => message?.role === "system");
		if (system.length !== head.messages.length || system.some((message, i) => message !== head.messages[i])) {
			head.messages = system;
			head.items = source.rows(system).map((row) => this.number(row));
		}
		const list: number[] = [];
		// The system prompt, the skill catalog and the tool schemas stand where the first system message is.
		let placed = false;
		for (const message of messages) {
			if (message?.role !== "system") list.push(...this.ofMessage(message));
			else if (!placed) list.push(...head.items);
			placed ||= message?.role === "system";
		}
		return placed ? list : [...head.items, ...list];
	}

	/** What changed from the items `before` to the items `after`, both as runs. */
	change(before: number[], after: number[]): { up: number[]; down: number[] } {
		const was = listOf(before);
		const now = listOf(after);
		let same = 0;
		while (same < was.length && same < now.length && was[same] === now[same]) same++;
		const old = new Set(was.slice(same));
		const kept = new Set(now.slice(same));
		const lineAt = (item: number) => this.items[item][4] ?? item;
		/** The items that left, by their line: an item of the same line that came takes the place of such an item. */
		const left = new Map<number, number>();
		for (const item of old) if (!kept.has(item)) left.set(lineAt(item), item);
		const up: number[] = [];
		/** For an item that left and whose line stayed: the item that took its place, and the tokens that the line lost. */
		const shrunk = new Map<number, [item: number, tokens: number]>();
		for (const item of kept) {
			if (old.has(item)) continue;
			const prior = left.get(lineAt(item));
			const grown = this.items[item][1] - (prior === undefined ? 0 : this.items[prior][1]);
			if (grown > 0) up.push(item, grown);
			if (prior !== undefined) shrunk.set(prior, [item, -grown]);
		}
		const down: number[] = [];
		for (const item of old) {
			if (kept.has(item)) continue;
			const [as, tokens] = shrunk.get(item) ?? [item, this.items[item][1]];
			if (tokens > 0) down.push(as, tokens);
		}
		return { up, down };
	}

	private total(runs: number[]): number {
		let total = 0;
		for (let r = 0; r < runs.length; r += 2) {
			for (let i = 0; i < runs[r + 1]; i++) total += this.items[runs[r] + i][1];
		}
		return total;
	}

	/**
	 * The bars of the requests. With `delta`, each bar tells what changed since the request before it in the list;
	 * the first one since `first`, or since an empty context.
	 * Requests that were not read before are read now. `pause` lets other work run in between.
	 */
	bars(
		requests: RequestRec[],
		source: RowSource | undefined,
		delta = false,
		first?: RequestRec,
		pause = () => new Promise<void>((resolve) => setImmediate(resolve)),
	): Promise<DnaBar[]> {
		const work = async () => {
			const head = { messages: [undefined] as any[], items: [] as number[] };
			let since = Date.now();
			const rest = async () => {
				if (Date.now() - since <= SLICE_MS) return;
				await pause();
				since = Date.now();
			};
			const strand = (request: RequestRec) => {
				let runs = this.strands.get(request.time);
				if (!runs) {
					runs = runsOf(this.read(request, source, head));
					this.strands.set(request.time, runs);
					if (!request.rows && runs.length) this.rebuilt.add(request.time);
				}
				return runs;
			};
			const bars: DnaBar[] = [];
			let before = first && { time: first.time, runs: strand(first) };
			for (const request of requests) {
				const runs = strand(request);
				const bar: DnaBar = { n: request.n, time: request.time, runs, scale: scaleOf(this.total(runs), request.context) };
				// A request that lost its recorded rows keeps the items that were read from them.
				if (this.rebuilt.has(request.time)) bar.rebuilt = true;
				if (delta) {
					const key = (before?.time ?? "") + ":" + request.time;
					let change = this.changes.get(key);
					if (!change) {
						change = this.change(before?.runs ?? [], runs);
						this.changes.set(key, change);
					}
					Object.assign(bar, change);
				}
				bars.push(bar);
				before = { time: request.time, runs };
				await rest();
			}
			return bars;
		};
		const result = this.queue.then(work);
		this.queue = result.catch(() => {});
		return result;
	}
}
