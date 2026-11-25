import type { ReplyKind } from "./analyze.ts";

const KINDS: Record<string, ReplyKind> = { thinking: "reasoning", text: "answers", toolcall: "toolCalls" };

/** Times the stream of one reply: the wait for its first token, and the blocks of reasoning, text and tool calls. */
export class StreamClock {
	private first?: number;
	private open?: { kind: ReplyKind; at: number };
	private spans: Partial<Record<ReplyKind, [ms: number, blocks: number]>> = {};
	private start: number;

	/** `start`: the time at which the request was sent. */
	constructor(start: number) {
		this.start = start;
	}

	private close(now: number) {
		if (!this.open) return;
		const span = (this.spans[this.open.kind] ??= [0, 0]);
		span[0] += Math.max(0, now - this.open.at);
		span[1]++;
		this.open = undefined;
	}

	/** Takes the type of a stream event of the assistant message, such as "text_start" or "toolcall_end". */
	note(type: string, now: number) {
		const found = /^(text|thinking|toolcall)_(start|delta|end)$/.exec(type);
		if (!found) return;
		this.first ??= now;
		if (found[2] === "delta") return;
		this.close(now);
		if (found[2] === "start") this.open = { kind: KINDS[found[1]], at: now };
	}

	/** The times, with the reply ending at `end`. Empty when the reply came without stream events. */
	result(end: number): { ttft?: number; spans?: Partial<Record<ReplyKind, [ms: number, blocks: number]>> } {
		this.close(end);
		if (this.first === undefined) return {};
		const ttft = Math.max(0, this.first - this.start);
		return Object.keys(this.spans).length > 0 ? { ttft, spans: this.spans } : { ttft };
	}
}
