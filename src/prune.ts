import { contentChars, contentText, type Row, rowsOf } from "./analyze.ts";

/** Session entry type that lists the tool calls whose results the user dropped. The last entry on the branch applies. */
export const PRUNE_ENTRY = "pi-context:prune";

const STUB = "[pi-context: the user dropped this tool result from the context";

/** Whether the tool result holds the stub and not its own content. */
export const isStub = (message: any) => contentText(message?.content).startsWith(STUB);

/** Ids of the tool calls whose results are dropped on the branch. */
export function prunedOf(entries: any[]): Set<string> {
	const entry = entries.findLast((e) => e.type === "custom" && e.customType === PRUNE_ENTRY);
	return new Set<string>(Array.isArray(entry?.data?.ids) ? entry.data.ids : []);
}

/** Replaces the content of the dropped tool results with a one-line stub. The other messages are returned as they are. */
export function prune<T>(messages: T[], ids: Set<string>): T[] {
	if (ids.size === 0) return messages;
	return messages.map((m: any) =>
		m?.role === "toolResult" && ids.has(m.toolCallId) && !isStub(m)
			? { ...m, content: [{ type: "text", text: `${STUB} (${contentChars(m.content)} characters). Call the tool again if you need it.]` }] }
			: m,
	);
}

/** The dropped tool results that `messages` hold, with their original sizes. `messages` must not be pruned. */
export function droppedOf(messages: any[], ids: Set<string>): Row[] {
	if (ids.size === 0) return [];
	return rowsOf(
		messages.filter((m) => m?.role === "toolResult" && ids.has(m.toolCallId)),
		{},
	);
}
