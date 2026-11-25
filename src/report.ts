import { cacheStats, CATEGORIES, FILE_KINDS, familyTotals, fileRows, LABELS, programRanks, sumByCategory, undeclared, type ViewData } from "./analyze.ts";
import { fmtCost, fmtPercent, fmtTime, fmtTokens } from "./format.ts";
import { hintTotal } from "./hints.ts";

export const SECTIONS = ["summary", "composition", "requests", "tools", "files", "commands", "hints"] as const;
export type Section = (typeof SECTIONS)[number];

/** Rows of a list that the report shows at most. */
const MAX_ROWS = 30;

const tail = <T>(list: T[]) => (list.length > MAX_ROWS ? list.slice(-MAX_ROWS) : list);
const none = (lines: string[], text: string) => (lines.length > 0 ? lines : [`  ${text}`]);

/** Plain-text context report, used by the context_insight tool and outside the TUI. */
export function report(data: ViewData, section: Section = "summary"): string {
	const { analysis, current, usage, factor } = data;
	const approx = (tokens: number) => `≈${fmtTokens(tokens * factor)}`;
	const size = (tokens: number) => `≈${fmtTokens(tokens * factor).padStart(6)}`;
	const scale =
		factor === 1
			? "estimates at 4 chars per token; the sum can differ from the provider-reported total"
			: `sizes at 4 chars per token, scaled ×${factor.toFixed(2)} to the provider-reported total`;
	const composition = (largest: number) => {
		const sums = sumByCategory(current);
		const total = current.reduce((sum, row) => sum + row.tokens, 0);
		const lines = [`Current context composition (${scale}):`];
		for (const cat of CATEGORIES) {
			if (sums[cat] > 0) lines.push(`  ${LABELS[cat].padEnd(17)} ${size(sums[cat])}  ${fmtPercent(sums[cat], total)}`);
		}
		lines.push("", "Largest items:");
		for (const row of [...current].sort((a, b) => b.tokens - a.tokens).slice(0, largest)) {
			lines.push(`  ${size(row.tokens)}  ${row.label}: ${row.preview.slice(0, 80)}`);
		}
		return lines;
	};
	switch (section) {
		case "composition":
			return composition(20).join("\n");
		case "requests": {
			const cache = cacheStats(analysis);
			return [
				`Requests: ${analysis.requests.length}. Cache hit rate ${fmtPercent(cache.rate, 1)}, ${cache.misses} cache misses (≈${fmtTokens(cache.tokens)} tokens billed again, ≈${fmtCost(cache.cost)}).`,
				...analysis.models.map((m) => `  ${m.model}: ${m.requests} requests, sent ${fmtTokens(m.sent)}, output ${fmtTokens(m.output)}, ${fmtCost(m.cost)}`),
				"",
				`Last ${Math.min(MAX_ROWS, analysis.requests.length)} requests (tokens sent, output, share read from the cache, cost):`,
				...tail(analysis.requests).map(
					(r) =>
						`  #${r.n} ${fmtTime(r.time)} sent ${fmtTokens(r.context)}, out ${fmtTokens(r.output)}, cache ${fmtPercent(r.cacheRead, r.context)}, ${fmtCost(r.cost)}${
							r.miss ? `, cache miss: ${fmtTokens(r.miss.tokens)} billed again` : ""
						}${r.stop === "stop" || r.stop === "toolUse" ? "" : `, ${r.stop}`}`,
				),
			].join("\n");
		}
		case "tools":
			return [
				"Tools (direct calls, calls nested in another tool, errors, estimated tokens of calls and results):",
				...none(
					[...analysis.tools]
						.sort((a, b) => b.calls + b.nested - (a.calls + a.nested))
						.map((tool) => {
							const flagged = undeclared(tool, data.declared);
							return `  ${tool.name}: ${tool.calls} direct, ${tool.nested} nested, ${tool.errors} errors, calls ${approx(tool.callTokens)}, results ${approx(tool.resultTokens)}${
								flagged ? `, direct calls while not declared: ${flagged}` : ""
							}`;
						}),
					"None.",
				),
				"",
				"Skills loaded:",
				...none(
					analysis.skills.map((skill) => `  ${skill.name} ×${skill.loads} ${approx(skill.tokens)}  ${skill.path}`),
					"None.",
				),
			].join("\n");
		case "files":
			return [
				"Files (reads, writes, edits, searches, images):",
				...none(
					fileRows(analysis.files)
						.slice(0, MAX_ROWS)
						.map((file) => `  ${FILE_KINDS.map((kind) => file[kind]).join(" ")}  ${file.path}`),
					"None.",
				),
			].join("\n");
		case "commands": {
			const top = programRanks(analysis.commands).slice(0, 10);
			return [
				`Commands: ${analysis.commands.length}. Programs: ${top.map(({ program, uses }) => `${program} ×${uses}`).join(", ") || "none"}`,
				...tail(analysis.commands).map(
					(c) => `  ${c.ok === undefined ? "?" : c.ok ? "ok" : "failed"} ${fmtTime(c.time)}  ${c.command.replace(/\s+/g, " ").slice(0, 160)}`,
				),
			].join("\n");
		}
		case "hints": {
			return [
				`Could be dropped from the context: ${approx(hintTotal(data.hints))} tokens.`,
				...none(
					data.hints.map((hint) => `  ${size(hint.tokens)}  ${hint.label}: ${hint.detail}`),
					"Nothing stands out: no repeated reads, no repeated skill loads, no large tool results from earlier turns.",
				),
			].join("\n");
		}
	}
	const lines: string[] = [];
	if (usage) {
		const percent = usage.percent == null ? "?" : `${Math.round(usage.percent)}%`;
		lines.push(`Context: ${fmtTokens(usage.tokens)} / ${fmtTokens(usage.contextWindow)} tokens (${percent})`);
	}
	if (data.model) lines.push(`Model: ${data.model}`);
	const t = analysis.totals;
	const family = familyTotals(t, data.agents);
	lines.push(
		`Session totals (provider-reported): input ${fmtTokens(t.input)}, cache read ${fmtTokens(t.cacheRead)}, cache write ${fmtTokens(t.cacheWrite)}, output ${fmtTokens(t.output)}, cost ${fmtCost(t.cost)}`,
		`Requests: ${analysis.requests.length}, human inputs: ${analysis.userInputs}, tool calls: ${analysis.toolCalls} (${analysis.toolErrors} errors), compactions: ${analysis.events.filter((e) => e.kind === "compaction").length}`,
		...(data.agents.length > 0 ? [`With ${data.agents.length} subagents: ${fmtTokens(family.tokens)} tokens, cost ${fmtCost(family.cost)}`] : []),
		"",
		...composition(8),
	);
	return lines.join("\n");
}