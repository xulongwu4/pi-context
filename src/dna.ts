import { CATEGORIES, type Category, isSkillRead, type RequestRec, type Row, type RowSource, rowsOf, scaleOf } from "./analyze.ts";

/** Longest time that the reading of the strands keeps other work waiting. */
const SLICE_MS = 20;
/** Characters of a preview that the page gets. */
const PREVIEW_CHARS = 100;
/** A context that falls short of the context of the request before by more than this share of it, and by more than these tokens, shrank. */
const DROP_SHARE = 0.1;
const DROP_TOKENS = 2000;
/** Items that left may take this many times their estimate from the context: the estimate of an item is rough. */
const SHRINK_SLACK = 1.5;
/** The items of a rebuilt request may differ by this share from the size that pi-context recorded for the request, and by these estimated tokens. */
const DRIFT_SHARE = 0.1;
const DRIFT_TOKENS = 500;

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
	/**
	 * For rebuilt items that may not be those that the request sent: the number of the first request at which the context shrank
	 * without the session telling why. The items may hold some that left the context then, or later.
	 */
	since?: number;
	/** For rebuilt items that differ from the size that pi-context recorded for the request: the tokens that they hold more, or with a number below 0 less. */
	extra?: number;
	/** With changes: the items that are new or grew since the bar before, and those that left or shrank, as item number, tokens, item number, tokens. */
	up?: number[];
	down?: number[];
}

/** All the requests of the session of the bars, in order, and the indexes of those that follow a compaction. */
export interface DnaSession {
	requests: RequestRec[];
	compacted: Set<number>;
}

/** What the reading of one request leaves for the next one. */
interface Head {
	/** The system messages, and their items: the system prompt, the skill catalog and the tool schemas. */
	messages: any[];
	items: number[];
	/** The messages of the request, the items of those, and whether the items of the system messages stand among them. */
	told: any[];
	body: number[];
	placed: boolean;
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

/** What pi tells of a session up to an entry: the entries that the context holds, each with its messages. */
export type Project = (entries: any[], leafId: string) => { entries: { sourceEntry: any; messages: any[] }[]; messages: any[] };

/**
 * The messages that the session tells up to an entry of the branch that ends at `leafId`, at little cost for many entries.
 * Between two entries that rewrite the context, a compaction or a context edit, each entry only adds its messages:
 * such a stretch of the branch is told once, up to its end, and an entry takes the start of that.
 */
export function projector(entries: any[], leafId: string | null | undefined, project: Project): (id: string) => any[] {
	let branch: { at: Map<string, number>; ids: string[]; starts: number[] } | undefined;
	/** The messages of each stretch, by its start, and for each entry the count of messages up to it. */
	const stretches = new Map<number, { messages: any[]; counts: Map<string, number> }>();
	const read = () => {
		const byId = new Map<string, any>(entries.map((entry) => [entry.id, entry]));
		const path: any[] = [];
		for (let entry = byId.get(leafId ?? ""); entry && path.length <= entries.length; entry = byId.get(entry.parentId)) path.push(entry);
		path.reverse();
		const starts = [0];
		path.forEach((entry, i) => {
			if (i > 0 && (entry.type === "compaction" || entry.type === "context_edit")) starts.push(i);
		});
		return { at: new Map(path.map((entry, i) => [entry.id as string, i])), ids: path.map((entry) => entry.id as string), starts };
	};
	return (id) => {
		branch ??= read();
		const i = branch.at.get(id);
		if (i === undefined) return project(entries, id).messages;
		let s = branch.starts.length - 1;
		while (branch.starts[s] > i) s--;
		const start = branch.starts[s];
		let stretch = stretches.get(start);
		if (!stretch) {
			const end = (branch.starts[s + 1] ?? branch.ids.length) - 1;
			const told = project(entries, branch.ids[end]);
			stretch = { messages: told.messages, counts: new Map() };
			let count = 0;
			// The session tells a compaction first, and after it the messages that it kept: they belong to what the session tells up to the compaction.
			let compaction: string | undefined;
			told.entries.forEach((entry, k) => {
				const source = entry.sourceEntry;
				if (compaction !== undefined && (branch?.at.get(source.id) ?? -1) > start) {
					stretch?.counts.set(compaction, count);
					compaction = undefined;
				}
				count += entry.messages.length;
				if (k === 0 && source.type === "compaction" && source.id === branch?.ids[start]) compaction = source.id;
				else stretch?.counts.set(source.id, count);
			});
			if (compaction !== undefined) stretch.counts.set(compaction, count);
			stretches.set(start, stretch);
		}
		const count = stretch.counts.get(id);
		return count === undefined ? project(entries, id).messages : stretch.messages.slice(0, count);
	};
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
	/** The estimated tokens of the items of each request, by the time of the request. */
	private sizes = new Map<number, number>();
	/** The rebuilt requests whose items may not be those that the request sent, by their time. */
	private doubts = new Map<number, Pick<DnaBar, "since" | "extra">>();
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

	/** The item numbers of a request. `head` keeps what the request read before left: a request that tells the same messages and more reads only the new ones. */
	private read(request: RequestRec, source: RowSource | undefined, head: Head): number[] {
		if (request.rows) return request.rows.map((row) => this.number(row));
		if (!source) return [];
		const messages = source.messages(request);
		const system = messages.filter((message) => message?.role === "system");
		const fresh = system.length !== head.messages.length || system.some((message, i) => message !== head.messages[i]);
		if (fresh) {
			head.messages = system;
			head.items = source.rows(system).map((row) => this.number(row));
		}
		let body: number[] = [];
		// The system prompt, the skill catalog and the tool schemas stand where the first system message is.
		let placed = false;
		let from = 0;
		if (!fresh && head.told.length <= messages.length && head.told.every((message, i) => message === messages[i])) {
			body = head.body.slice();
			placed = head.placed;
			from = head.told.length;
		}
		for (let i = from; i < messages.length; i++) {
			const message = messages[i];
			if (message?.role !== "system") body.push(...this.ofMessage(message));
			else if (!placed) body.push(...head.items);
			placed ||= message?.role === "system";
		}
		Object.assign(head, { told: messages, body, placed });
		return placed ? body : [...head.items, ...body];
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

	/**
	 * Finds the rebuilt requests whose items may not be those that the request sent. The session tells what it holds,
	 * not what an extension took out of the context before a request, or what the provider left out.
	 * Where pi-context recorded the size of a request, the items must add up to it. Elsewhere a context that shrank
	 * by more than the items that left tells of a change: the requests from there to the next compaction are in doubt.
	 */
	private judge(session: DnaSession, strandOf: (request: RequestRec) => number[]): void {
		this.doubts.clear();
		let since: number | undefined;
		let before: { context: number; size: number; model: string } | undefined;
		session.requests.forEach((request, i) => {
			if (session.compacted.has(i)) since = before = undefined;
			const runs = strandOf(request);
			if (request.context <= 0) return;
			if (!this.rebuilt.has(request.time)) {
				since = before = undefined;
				return;
			}
			let size = this.sizes.get(request.time);
			if (size === undefined) this.sizes.set(request.time, (size = this.total(runs)));
			const sent = CATEGORIES.reduce((sum, cat) => sum + (request.sums?.[cat] ?? 0), 0);
			if (sent > 0) {
				const extra = size - sent;
				if (Math.abs(extra) > Math.max(DRIFT_TOKENS, DRIFT_SHARE * sent)) this.doubts.set(request.time, { extra: Math.round((extra * request.context) / sent) });
				else since = undefined;
			} else {
				if (before && before.model === request.model && before.size > 0) {
					const left = Math.min(0, size - before.size) * (before.context / before.size) * SHRINK_SLACK;
					if (request.context < before.context + left - Math.max(DROP_TOKENS, DROP_SHARE * before.context)) since ??= request.n;
				}
				if (since !== undefined) this.doubts.set(request.time, { since });
			}
			before = { context: request.context, size, model: request.model };
		});
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
	 * With `session`, the bars of rebuilt requests tell whether their items are in doubt; for that, all the requests of the session are read.
	 */
	bars(
		requests: RequestRec[],
		source: RowSource | undefined,
		delta = false,
		first?: RequestRec,
		session?: DnaSession,
		pause = () => new Promise<void>((resolve) => setImmediate(resolve)),
	): Promise<DnaBar[]> {
		const work = async () => {
			const head: Head = { messages: [undefined], items: [], told: [], body: [], placed: false };
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
			if (session) {
				for (const request of session.requests) {
					strand(request);
					await rest();
				}
				this.judge(session, strand);
			}
			const bars: DnaBar[] = [];
			let before = first && { time: first.time, runs: strand(first) };
			for (const request of requests) {
				const runs = strand(request);
				const bar: DnaBar = { n: request.n, time: request.time, runs, scale: scaleOf(this.total(runs), request.context) };
				// A request that lost its recorded rows keeps the items that were read from them.
				if (this.rebuilt.has(request.time)) bar.rebuilt = true;
				if (session) Object.assign(bar, this.doubts.get(request.time));
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
