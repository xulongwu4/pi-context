import { cacheStats, CATEGORIES, type Category, LABELS, scaleOf, sumByCategory, undeclared, type ViewData } from "./analyze.ts";
import { fmtCost, fmtDay, fmtDuration, fmtPercent, fmtTime, fmtTokens } from "./format.ts";
import type { Insights } from "./insights.ts";

type Cell = string | number;

const stamp = (ms: number) => `${fmtDay(ms)} ${fmtTime(ms)}`;
const approx = (tokens: number, factor = 1) => (tokens ? `≈${fmtTokens(tokens * factor)}` : "");

function table(head: string[], rows: Cell[][]): string[] {
	if (rows.length === 0) return ["None.", ""];
	const line = (cells: Cell[]) => `| ${cells.map((cell) => String(cell).replace(/\s+/g, " ").replace(/\|/g, "\\|")).join(" | ")} |`;
	return [line(head), line(head.map(() => "---")), ...rows.map(line), ""];
}

function composition(sums: Record<Category, number>, reported?: number | null): string[] {
	const total = CATEGORIES.reduce((sum, cat) => sum + sums[cat], 0);
	const factor = scaleOf(total, reported);
	return table(
		["Category", "Tokens", "Share"],
		CATEGORIES.filter((cat) => sums[cat] > 0).map((cat) => [LABELS[cat], approx(sums[cat], factor), fmtPercent(sums[cat], total)]),
	);
}

const top = (list: [string, number][]) => list.map(([name, n]) => `${name} ×${n}`).join(", ") || "None.";

/** The whole dashboard as a Markdown document. */
export function exportMarkdown(data: ViewData, insights: Insights): string {
	const { analysis, current, usage, agents, factor, hints } = data;
	const { totals, timing } = analysis;
	const cache = cacheStats(analysis);
	const programs = new Map<string, number>();
	for (const command of analysis.commands) programs.set(command.program, (programs.get(command.program) ?? 0) + 1);
	const percent = usage?.percent == null ? "?" : `${Math.round(usage.percent)}%`;
	return [
		"# pi-context report",
		"",
		`Generated ${stamp(Date.now())}. Totals are provider-reported. Figures marked ≈ are sizes at 4 characters per token${
			factor === 1 ? "" : `, scaled ×${factor.toFixed(2)} to the provider-reported size of the context`
		}.`,
		"",
		"## Stats",
		"",
		`- Context window: ${fmtTokens(usage?.tokens)} / ${fmtTokens(usage?.contextWindow)} (${percent})`,
		`- Model: ${data.model ?? "?"}`,
		`- Human inputs: ${analysis.userInputs}`,
		`- Requests: ${analysis.requests.length}`,
		`- Tool calls: ${analysis.toolCalls} (${analysis.toolErrors} errors)`,
		`- Cost: ${fmtCost(totals.cost)}`,
		`- Tokens: input ${fmtTokens(totals.input)}, cache read ${fmtTokens(totals.cacheRead)}, cache write ${fmtTokens(totals.cacheWrite)}, output ${fmtTokens(totals.output)}`,
		`- Timing of the recorded turns: active ${fmtDuration(timing.activeMs)}, model calls ${fmtDuration(timing.modelMs)}, tool runs ${fmtDuration(timing.toolMs)}`,
		`- Prompt cache: ${fmtPercent(cache.rate, 1)} of the tokens sent were read from the cache; ${cache.misses} misses, ≈${fmtTokens(cache.tokens)} tokens billed again (≈${fmtCost(cache.cost)} extra)`,
		"",
		...table(
			["Model", "Requests", "Sent", "Output", "Cost"],
			analysis.models.map((m) => [m.model, m.requests, fmtTokens(m.sent), fmtTokens(m.output), fmtCost(m.cost)]),
		),
		"## Current context",
		"",
		...composition(sumByCategory(current), usage?.tokens),
		"Largest items:",
		"",
		...table(
			["Category", "Tokens", "Item"],
			[...current]
				.sort((a, b) => b.tokens - a.tokens)
				.slice(0, 12)
				.map((row) => [LABELS[row.cat], approx(row.tokens, factor), `${row.label}: ${row.preview}`]),
		),
		"## Hints",
		"",
		"What could be dropped from the context:",
		"",
		...table(
			["Tokens", "Item", "Why"],
			hints.map((hint) => [approx(hint.tokens, factor), hint.label, hint.detail]),
		),
		"## Requests",
		"",
		...table(
			["#", "Time", "Model", "Sent", "From cache", "Output", "Cost", "Took", "Stop", "Cache miss"],
			analysis.requests.map((r) => [
				r.n,
				stamp(r.time),
				r.model,
				fmtTokens(r.context),
				fmtPercent(r.cacheRead, r.context),
				fmtTokens(r.output),
				fmtCost(r.cost),
				r.ms == null ? "" : fmtDuration(r.ms),
				r.stop,
				r.miss ? `≈${fmtTokens(r.miss.tokens)} billed again, ≈${fmtCost(r.miss.cost)} extra` : "",
			]),
		),
		"## Events",
		"",
		...table(
			["Time", "Event", "Detail"],
			analysis.events.map((event) => [stamp(event.time), event.kind, event.detail]),
		),
		"## Files",
		"",
		...table(
			["Path", "Reads", "Writes", "Edits"],
			analysis.files.map((file) => [file.path, file.reads, file.writes, file.edits]),
		),
		...(analysis.unresolvedEdits ? [`${analysis.unresolvedEdits} anchor-based edits are not listed: their file was not recorded.`, ""] : []),
		"## Commands",
		"",
		`Programs: ${top([...programs].sort((a, b) => b[1] - a[1]))}`,
		"",
		...table(
			["Time", "Result", "Command"],
			analysis.commands.map((c) => [stamp(c.time), c.ok === undefined ? "" : c.ok ? "ok" : "failed", `\`${c.command}\``]),
		),
		"## Tools",
		"",
		...table(
			["Tool", "Calls", "Nested calls", "Errors", "Call tokens", "Result tokens", "Note"],
			analysis.tools.map((tool) => {
				const calls = undeclared(tool, data.declared);
				return [
					tool.name,
					tool.calls,
					tool.nested,
					tool.errors,
					approx(tool.callTokens, factor),
					approx(tool.resultTokens, factor),
					calls ? `direct calls while not declared: ${calls}` : "",
				];
			}),
		),
		"Skills loaded:",
		"",
		...table(
			["Skill", "Loads", "Tokens", "Path"],
			analysis.skills.map((skill) => [skill.name, skill.loads, approx(skill.tokens, factor), skill.path]),
		),
		"## Fleet",
		"",
		...table(
			["Agent", "Type", "Description", "Status", "Time", "Requests", "Tokens", "Cost"],
			agents.map((agent) => [
				agent.id,
				agent.type,
				agent.description,
				agent.status,
				agent.startedAt && agent.completedAt ? fmtDuration(agent.completedAt - agent.startedAt) : "",
				agent.requests ?? "",
				agent.tokens == null ? "" : fmtTokens(agent.tokens),
				agent.cost == null ? "" : fmtCost(agent.cost),
			]),
		),
		`## Insights: last ${insights.days} days, all projects`,
		"",
		`- Sessions: ${insights.sessions.length}`,
		`- Requests: ${insights.requests}`,
		`- Tokens: ${fmtTokens(insights.tokens)}`,
		`- Cost: ${fmtCost(insights.cost)}`,
		`- Active days: ${insights.activeDays}`,
		`- Top tools: ${top(insights.tools)}`,
		`- Top programs: ${top(insights.programs)}`,
		`- Top skills: ${top(insights.skills)}`,
		"",
		...table(
			["Model", "Requests", "Tokens", "Cost"],
			insights.models.map(([name, requests, tokens, cost]) => [name, requests, fmtTokens(tokens), fmtCost(cost)]),
		),
		...table(
			["Day", "Requests", "Tokens", "Cost"],
			insights.week.map((day) => [day.day, day.requests, fmtTokens(day.tokens), fmtCost(day.cost)]),
		),
		...table(
			["Last request", "Project", "Session", "Requests", "Tokens", "Cost"],
			insights.sessions.map((s) => [stamp(s.end), s.cwd, s.name, s.requests, fmtTokens(s.tokens), fmtCost(s.cost)]),
		),
	].join("\n");
}