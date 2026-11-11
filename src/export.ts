import { CATEGORIES, type Category, LABELS, sumByCategory, undeclared, type ViewData } from "./analyze.ts";
import { fmtCost, fmtDay, fmtDuration, fmtPercent, fmtTime, fmtTokens } from "./format.ts";
import type { Insights } from "./insights.ts";

type Cell = string | number;

const stamp = (ms: number) => `${fmtDay(ms)} ${fmtTime(ms)}`;
const approx = (tokens: number) => (tokens ? `≈${fmtTokens(tokens)}` : "");

function table(head: string[], rows: Cell[][]): string[] {
	if (rows.length === 0) return ["None.", ""];
	const line = (cells: Cell[]) => `| ${cells.map((cell) => String(cell).replace(/\s+/g, " ").replace(/\|/g, "\\|")).join(" | ")} |`;
	return [line(head), line(head.map(() => "---")), ...rows.map(line), ""];
}

function composition(sums: Record<Category, number>): string[] {
	const total = CATEGORIES.reduce((sum, cat) => sum + sums[cat], 0);
	return table(
		["Category", "Tokens", "Share"],
		CATEGORIES.filter((cat) => sums[cat] > 0).map((cat) => [LABELS[cat], approx(sums[cat]), fmtPercent(sums[cat], total)]),
	);
}

const top = (list: [string, number][]) => list.map(([name, n]) => `${name} ×${n}`).join(", ") || "None.";

/** The whole dashboard as a Markdown document. */
export function exportMarkdown(data: ViewData, insights: Insights): string {
	const { analysis, current, usage, agents } = data;
	const { totals, timing } = analysis;
	const programs = new Map<string, number>();
	for (const command of analysis.commands) programs.set(command.program, (programs.get(command.program) ?? 0) + 1);
	const percent = usage?.percent == null ? "?" : `${Math.round(usage.percent)}%`;
	return [
		"# pi-context report",
		"",
		`Generated ${stamp(Date.now())}. Totals are provider-reported. Figures marked ≈ are estimates at 4 characters per token.`,
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
		"",
		"## Current context",
		"",
		...composition(sumByCategory(current)),
		"Largest items:",
		"",
		...table(
			["Category", "Tokens", "Item"],
			[...current]
				.sort((a, b) => b.tokens - a.tokens)
				.slice(0, 12)
				.map((row) => [LABELS[row.cat], approx(row.tokens), `${row.label}: ${row.preview}`]),
		),
		"## Requests",
		"",
		...table(
			["#", "Time", "Model", "Sent", "Output", "Cost", "Took", "Stop"],
			analysis.requests.map((r) => [
				r.n,
				stamp(r.time),
				r.model,
				fmtTokens(r.context),
				fmtTokens(r.output),
				fmtCost(r.cost),
				r.ms == null ? "" : fmtDuration(r.ms),
				r.stop,
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
			analysis.tools.map((tool) => [
				tool.name,
				tool.calls,
				tool.nested,
				tool.errors,
				approx(tool.callTokens),
				approx(tool.resultTokens),
				undeclared(tool, data.declared) ? "direct call, not declared" : "",
			]),
		),
		"Skills loaded:",
		"",
		...table(
			["Skill", "Loads", "Tokens", "Path"],
			analysis.skills.map((skill) => [skill.name, skill.loads, approx(skill.tokens), skill.path]),
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
			["Day", "Requests", "Tokens", "Cost"],
			insights.week.map((day) => [day.day, day.requests, fmtTokens(day.tokens), fmtCost(day.cost)]),
		),
		...table(
			["Last request", "Project", "Session", "Requests", "Tokens", "Cost"],
			insights.sessions.map((s) => [stamp(s.end), s.cwd, s.name, s.requests, fmtTokens(s.tokens), fmtCost(s.cost)]),
		),
	].join("\n");
}