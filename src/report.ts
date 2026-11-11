import { CATEGORIES, LABELS, sumByCategory, type ViewData } from "./analyze.ts";
import { fmtCost, fmtPercent, fmtTokens } from "./format.ts";

/** Plain-text context report, used by the context_insight tool and outside the TUI. */
export function report(data: ViewData): string {
	const { analysis, current, usage } = data;
	const lines: string[] = [];
	if (usage) {
		const percent = usage.percent == null ? "?" : `${Math.round(usage.percent)}%`;
		lines.push(`Context: ${fmtTokens(usage.tokens)} / ${fmtTokens(usage.contextWindow)} tokens (${percent})`);
	}
	if (data.model) lines.push(`Model: ${data.model}`);
	const t = analysis.totals;
	lines.push(
		`Session totals (provider-reported): input ${fmtTokens(t.input)}, cache read ${fmtTokens(t.cacheRead)}, cache write ${fmtTokens(t.cacheWrite)}, output ${fmtTokens(t.output)}, cost ${fmtCost(t.cost)}`,
		`Requests: ${analysis.requests.length}, human inputs: ${analysis.userInputs}, tool calls: ${analysis.toolCalls} (${analysis.toolErrors} errors), compactions: ${analysis.events.filter((e) => e.kind === "compaction").length}`,
		"",
		"Current context composition (estimates at 4 chars per token; the sum can differ from the provider-reported total):",
	);
	const sums = sumByCategory(current);
	const total = current.reduce((sum, row) => sum + row.tokens, 0);
	for (const cat of CATEGORIES) {
		if (sums[cat] > 0) lines.push(`  ${LABELS[cat].padEnd(17)} ≈${fmtTokens(sums[cat]).padStart(6)}  ${fmtPercent(sums[cat], total)}`);
	}
	lines.push("", "Largest items:");
	for (const row of [...current].sort((a, b) => b.tokens - a.tokens).slice(0, 8)) {
		lines.push(`  ≈${fmtTokens(row.tokens).padStart(6)}  ${row.label}: ${row.preview.slice(0, 80)}`);
	}
	return lines.join("\n");
}
