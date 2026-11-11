import { argPath, contentChars, contentText, estimate, fileOp, isSkillRead } from "./analyze.ts";

/** Something that could be dropped from the context. */
export interface Hint {
	kind: "reread" | "skill" | "result";
	/** Estimated tokens that dropping it would free. */
	tokens: number;
	label: string;
	detail: string;
}

const MIN_RESULT_TOKENS = 1000;
const MAX_RESULTS = 10;

/**
 * What could be dropped from the context of `messages`: reads that a later identical read supersedes,
 * skills loaded more than once, and the largest tool results of earlier turns. Largest first.
 *
 * Only direct tool calls are considered. The result of a call made inside another tool is part of that tool's result.
 */
export function hintsOf(messages: any[]): Hint[] {
	const reads = new Map<string, { kind: "reread" | "skill"; path: string; key: string }>();
	const groups = new Map<string, { kind: "reread" | "skill"; path: string; sizes: number[] }>();
	const results: { index: number; tokens: number; label: string; detail: string; key?: string }[] = [];
	messages.forEach((m, index) => {
		if (m?.role === "assistant") {
			for (const call of Array.isArray(m.content) ? m.content : []) {
				const path = call?.type === "toolCall" ? argPath(call.arguments) : undefined;
				if (!path) continue;
				const kind = isSkillRead(call) ? "skill" : fileOp(call.name) === "reads" ? "reread" : undefined;
				// Reads of different ranges of a file do not supersede each other.
				if (kind) reads.set(call.id, { kind, path, key: JSON.stringify(call.arguments) });
			}
		} else if (m?.role === "toolResult" && !m.isError) {
			const tokens = estimate(contentChars(m.content));
			const read = reads.get(m.toolCallId);
			if (read) {
				const group = groups.get(read.key) ?? { kind: read.kind, path: read.path, sizes: [] };
				group.sizes.push(tokens);
				groups.set(read.key, group);
			}
			const detail = contentText(m.content).slice(0, 480).replace(/\s+/g, " ").trim().slice(0, 120);
			results.push({ index, tokens, label: `result ${m.toolName}`, detail, key: read?.key });
		}
	});
	const hints: Hint[] = [];
	for (const [key, group] of groups) {
		if (group.sizes.length < 2) groups.delete(key);
		else {
			const skill = group.kind === "skill";
			hints.push({
				kind: group.kind,
				tokens: group.sizes.slice(0, -1).reduce((total, size) => total + size, 0),
				label: `${skill ? `skill ${group.path.split("/").at(-2) ?? group.path}` : `read ${group.path}`} ×${group.sizes.length}`,
				detail: skill ? "The skill was loaded more than once. Only one copy is needed." : "The last read supersedes the earlier ones.",
			});
		}
	}
	const lastUser = messages.findLastIndex((m) => m?.role === "user");
	const old = results
		.filter((result) => result.index < lastUser && result.tokens >= MIN_RESULT_TOKENS && !(result.key && groups.has(result.key)))
		.sort((a, b) => b.tokens - a.tokens)
		.slice(0, MAX_RESULTS);
	for (const { tokens, label, detail } of old) hints.push({ kind: "result", tokens, label, detail });
	return hints.sort((a, b) => b.tokens - a.tokens);
}
