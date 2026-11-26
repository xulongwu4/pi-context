import { analyze, resultText, rowsOf, type RequestRec, type ViewData } from "../src/analyze.ts";

const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { total: 0.01 } });
export const assistant = (timestamp: number, input: number, content: any[]) => ({ role: "assistant", model: "m1", stopReason: "stop", timestamp, usage: usage(input, 10), content });
export const call = (id: string, name: string, args: object) => ({ type: "toolCall", id, name, arguments: args });
export const result = (timestamp: number, id: string, name: string, text: string, isError = false) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp });

/** The dashboard data of a session that told `messages`, with nothing recorded by pi-context. `extra` replaces fields. */
export function viewOf(messages: any[], extra: Partial<ViewData> = {}): ViewData {
	const entries = messages.map((message, i) => ({ type: "message", id: `e${i}`, parentId: i ? `e${i - 1}` : null, timestamp: new Date(message.timestamp).toISOString(), message }));
	const analysis = analyze(entries);
	return {
		analysis,
		current: rowsOf(messages, undefined, [], true),
		usage: { tokens: analysis.requests.at(-1)?.context ?? 0, contextWindow: 1000, percent: 16 },
		model: "m1",
		declared: [],
		schemas: {},
		sources: {},
		factor: 1,
		hints: [],
		dropped: [],
		config: { budget: 5 },
		agents: [],
		timeline: [],
		tasks: [],
		running: false,
		rates: {},
		toolDoc: () => undefined,
		resultText: (id) => resultText(entries, id),
		reconstruct: () => [],
		...extra,
	};
}

/**
 * What rebuilds the requests of a session that told `messages`, for {@link viewOf}: the context of a request is the messages before its answer.
 */
export function rebuilt(messages: any[]): Pick<ViewData, "reconstruct" | "source"> {
	const before = (request: RequestRec) => messages.slice(0, messages.findIndex((message) => message.role === "assistant" && message.timestamp === request.time));
	return {
		reconstruct: (request) => rowsOf(before(request), undefined, [], true),
		source: { messages: before, rows: (list) => rowsOf(list) },
	};
}
