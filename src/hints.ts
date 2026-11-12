import { argPath, contentChars, contentText, estimate, fileOp, isSkillRead } from "./analyze.ts";
import { isStub } from "./prune.ts";

/** Something that could be dropped from the context. */
export interface Hint {
	/** `nested`: a file that scripts read more than once. Its result is part of the scripts' results and cannot be dropped alone. */
	kind: "reread" | "skill" | "result" | "nested";
	/** Estimated tokens that dropping it would free. For `nested`, an upper bound. */
	tokens: number;
	label: string;
	detail: string;
	/** Tool call ids of the results that dropping it would replace. */
	ids?: string[];
}

/** Estimated tokens that dropping all hinted results would free. */
export const hintTotal = (hints: Hint[]) => hints.reduce((total, hint) => total + (hint.kind === "nested" ? 0 : hint.tokens), 0);

const MIN_RESULT_TOKENS = 1000;
const MAX_RESULTS = 10;

/**
 * What could be dropped from the context of `messages`: reads that a later identical read supersedes,
 * skills loaded more than once, and the largest tool results of earlier turns. Largest first.
 *
 * The result of a call made inside another tool is part of that tool's result. For such calls, the hints only name
 * the files read more than once; `sizeOf` gives the size of a file in characters.
 */
export function hintsOf(messages: any[], sizeOf?: (path: string) => number | undefined): Hint[] {
	const reads = new Map<string, { kind: "reread" | "skill"; path: string; key: string }>();
	const groups = new Map<string, { kind: "reread" | "skill"; path: string; sizes: number[]; ids: string[] }>();
	const results: { index: number; tokens: number; label: string; detail: string; id: string; key?: string }[] = [];
	const nested = new Map<string, number>();
	messages.forEach((m, index) => {
		if (m?.role === "assistant") {
			for (const call of Array.isArray(m.content) ? m.content : []) {
				const path = call?.type === "toolCall" ? argPath(call.arguments) : undefined;
				if (!path) continue;
				const kind = isSkillRead(call) ? "skill" : fileOp(call.name) === "reads" ? "reread" : undefined;
				// Reads of different ranges of a file do not supersede each other.
				if (kind) reads.set(call.id, { kind, path, key: JSON.stringify(call.arguments) });
			}
		} else if (m?.role === "toolResult" && !m.isError && !isStub(m)) {
			const tokens = estimate(contentChars(m.content));
			const read = reads.get(m.toolCallId);
			if (read) {
				const group = groups.get(read.key) ?? { kind: read.kind, path: read.path, sizes: [], ids: [] };
				group.sizes.push(tokens);
				group.ids.push(m.toolCallId);
				groups.set(read.key, group);
			}
			const detail = contentText(m.content).slice(0, 480).replace(/\s+/g, " ").trim().slice(0, 120);
			results.push({ index, tokens, label: `result ${m.toolName}`, detail, id: m.toolCallId, key: read?.key });
			for (const call of m.nestedCalls?.calls ?? []) {
				const path = call.status === "ok" && fileOp(call.name) === "reads" ? argPath(call.arguments) : undefined;
				if (path) nested.set(path, (nested.get(path) ?? 0) + 1);
			}
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
				ids: group.ids.slice(0, -1),
			});
		}
	}
	const lastUser = messages.findLastIndex((m) => m?.role === "user");
	const old = results
		.filter((result) => result.index < lastUser && result.tokens >= MIN_RESULT_TOKENS && !(result.key && groups.has(result.key)))
		.sort((a, b) => b.tokens - a.tokens)
		.slice(0, MAX_RESULTS);
	for (const { tokens, label, detail, id } of old) hints.push({ kind: "result", tokens, label, detail, ids: [id] });
	for (const [path, count] of nested) {
		if (count < 2) continue;
		hints.push({
			kind: "nested",
			tokens: estimate(sizeOf?.(path) ?? 0) * (count - 1),
			label: `read ${path} ×${count} in scripts`,
			detail: "Upper bound: a script may return only part of what it reads.",
		});
	}
	return hints.sort((a, b) => b.tokens - a.tokens);
}