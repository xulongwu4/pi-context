import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { type AgentRec, CATEGORIES, type Category, LABELS, type Row, sumByCategory, undeclared, type ViewData } from "./analyze.ts";
import { bar, fmtCost, fmtDay, fmtDuration, fmtPercent, fmtTime, fmtTokens } from "./format.ts";
import type { Insights } from "./insights.ts";

const TABS = ["Stats", "Current", "Trend", "Browser", "Events", "Files", "Commands", "Tools", "Fleet", "Insights"];
const TREND = 2;
const BROWSER = 3;
const INSIGHTS = 9;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SHADES = "░▒▓█";

export type LoadInsights = (onProgress: (done: number, total: number) => void) => Promise<Insights>;

interface Body {
	lines: string[];
	/** Line that must stay visible. */
	cursor?: number;
}

function pad(line: string, width: number): string {
	const cut = truncateToWidth(line, width);
	return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

export class ContextOverlay {
	private tui: TUI;
	private theme: Theme;
	private data: ViewData;
	private refresh: () => ViewData;
	private loadInsights: LoadInsights;
	private done: () => void;
	private tab = 0;
	private scroll = 0;
	private request: number;
	/** Compositions rebuilt for requests without a snapshot, by request number. */
	private rebuilt = new Map<number, Row[]>();
	private insights?: Insights;
	private loading = false;
	private progress = "";
	/** Width of the body, as of the last render. */
	private width = 80;

	constructor(tui: TUI, theme: Theme, data: ViewData, refresh: () => ViewData, loadInsights: LoadInsights, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.data = data;
		this.refresh = refresh;
		this.loadInsights = loadInsights;
		this.done = done;
		this.request = data.analysis.requests.length - 1;
	}

	invalidate(): void {}

	handleInput(key: string): void {
		if (matchesKey(key, "escape") || key === "q") {
			this.done();
			return;
		}
		const page = this.bodyHeight() - 1;
		if (matchesKey(key, "right") || matchesKey(key, "tab")) this.setTab((this.tab + 1) % TABS.length);
		else if (matchesKey(key, "left") || matchesKey(key, "shift+tab")) this.setTab((this.tab + TABS.length - 1) % TABS.length);
		else if (matchesKey(key, "up")) this.move(-1);
		else if (matchesKey(key, "down")) this.move(1);
		else if (matchesKey(key, "pageUp")) this.move(-page);
		else if (matchesKey(key, "pageDown")) this.move(page);
		else if (matchesKey(key, "enter") && this.tab === TREND) this.setTab(BROWSER);
		else if (key === "[") this.selectRequest(this.request - 1);
		else if (key === "]") this.selectRequest(this.request + 1);
		else if (key === "r") {
			this.data = this.refresh();
			this.rebuilt.clear();
			this.selectRequest(this.request);
			if (this.tab === INSIGHTS) this.readInsights();
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const t = this.theme;
		const inner = Math.max(10, width - 4);
		const height = this.bodyHeight();
		this.width = inner;
		const { lines, cursor } = this.body();
		if (cursor !== undefined) {
			if (cursor < this.scroll) this.scroll = cursor;
			if (cursor >= this.scroll + height) this.scroll = cursor - height + 1;
		}
		this.scroll = Math.max(0, Math.min(this.scroll, lines.length - height));
		const visible = lines.slice(this.scroll, this.scroll + height);
		while (visible.length < height) visible.push("");

		// When the tab bar is too wide, drop leading tabs until the active one fits.
		let first = 0;
		const span = (from: number) => TABS.slice(from, this.tab + 1).join(" │ ").length + (from > 0 ? 2 : 0);
		while (first < this.tab && span(first) > inner) first++;
		const tabs =
			(first > 0 ? t.fg("dim", "… ") : "") +
			TABS.slice(first)
				.map((name, i) => (i + first === this.tab ? t.bold(t.fg("accent", name)) : t.fg("muted", name)))
				.join(t.fg("dim", " │ "));
		const position =
			lines.length > height ? `  ${this.scroll + 1}-${this.scroll + height}/${lines.length}` : "";
		const hint = `←/→ tab  ↑/↓ ${this.tab === TREND ? "select  enter browse" : "scroll"}${
			this.tab === BROWSER ? "  [ ] request" : ""
		}  r refresh  q close${position}`;
		const border = (s: string) => t.fg("dim", s);
		const frame = (line: string) => `${border("│")} ${pad(line, inner)} ${border("│")}`;
		const title = " Context ";
		return [
			border(`╭─${title}${"─".repeat(Math.max(0, width - 3 - title.length))}╮`),
			frame(tabs),
			border(`├${"─".repeat(Math.max(0, width - 2))}┤`),
			...visible.map(frame),
			frame(t.fg("dim", hint)),
			border(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
		];
	}

	private bodyHeight(): number {
		return Math.max(6, Math.floor(this.tui.terminal.rows * 0.85) - 5);
	}

	private setTab(tab: number): void {
		this.tab = tab;
		this.scroll = 0;
		if (tab === INSIGHTS && !this.insights) this.readInsights();
	}

	private readInsights(): void {
		if (this.loading) return;
		this.loading = true;
		this.insights = undefined;
		this.progress = "Reading sessions…";
		this.loadInsights((done, total) => {
			if (done % 20 !== 0) return;
			this.progress = `Reading sessions… ${done}/${total}`;
			this.tui.requestRender();
		})
			.then(
				(insights) => {
					this.insights = insights;
				},
				(error) => {
					this.progress = `Could not read sessions: ${error?.message ?? error}`;
				},
			)
			.finally(() => {
				this.loading = false;
				this.tui.requestRender();
			});
	}

	private selectRequest(index: number): void {
		this.request = Math.max(0, Math.min(this.data.analysis.requests.length - 1, index));
	}

	private move(delta: number): void {
		if (this.tab === TREND) this.selectRequest(this.request + delta);
		else this.scroll = Math.max(0, this.scroll + delta);
	}

	private head(text: string): string {
		return this.theme.bold(this.theme.fg("accent", text));
	}

	/** Packs the items into lines that fit the body. */
	private wrap(items: string[], indent = "  "): string[] {
		const lines: string[] = [];
		let line = "";
		for (const item of items) {
			const longer = line ? `${line}   ${item}` : indent + item;
			if (line && visibleWidth(longer) > this.width) {
				lines.push(line);
				line = indent + item;
			} else line = longer;
		}
		lines.push(line || `${indent}None.`);
		return lines;
	}

	private pairs(pairs: [string, string | number][]): string {
		return `  ${pairs.map(([key, value]) => `${this.theme.fg("muted", key)} ${value}`).join("   ")}`;
	}

	private body(): Body {
		switch (this.tab) {
			case 0:
				return { lines: this.stats() };
			case 1:
				return { lines: this.current() };
			case TREND:
				return this.trend();
			case BROWSER:
				return { lines: this.browser() };
			case 4:
				return { lines: this.events() };
			case 5:
				return { lines: this.files() };
			case 6:
				return { lines: this.commands() };
			case 7:
				return { lines: this.tools() };
			case 8:
				return { lines: this.fleet() };
			default:
				return { lines: this.insightsTab() };
		}
	}

	private stats(): string[] {
		const { analysis, usage, model } = this.data;
		const timing = analysis.timing;
		const totals = analysis.totals;
		const overhead = Math.max(0, timing.activeMs - timing.modelMs - timing.toolMs);
		const share = (ms: number) => `${fmtDuration(ms)} (${fmtPercent(ms, timing.activeMs)})`;
		const window = usage
			? `  ${bar((usage.percent ?? 0) / 100, 30)} ${fmtTokens(usage.tokens)} / ${fmtTokens(usage.contextWindow)} (${
					usage.percent == null ? "?" : `${Math.round(usage.percent)}%`
				})`
			: "  unknown";
		return [
			this.head("Context window"),
			window,
			this.pairs([["Model", model ?? "?"]]),
			"",
			this.head("Session"),
			this.pairs([
				["Human inputs", analysis.userInputs],
				["Requests", analysis.requests.length],
				["Tool calls", `${analysis.toolCalls} (${analysis.toolErrors} errors)`],
				["Cost", fmtCost(totals.cost)],
			]),
			"",
			this.head("Tokens (provider-reported)"),
			this.pairs([
				["Input", fmtTokens(totals.input)],
				["Cache read", fmtTokens(totals.cacheRead)],
				["Cache write", fmtTokens(totals.cacheWrite)],
				["Output", fmtTokens(totals.output)],
			]),
			"",
			this.head("Timing (turns recorded by pi-context)"),
			this.pairs([
				["Active", fmtDuration(timing.activeMs)],
				["Model calls", share(timing.modelMs)],
				["Tool runs", share(timing.toolMs)],
				["Overhead", share(overhead)],
			]),
		];
	}

	private composition(sums: Record<Category, number>): string[] {
		const total = CATEGORIES.reduce((sum, cat) => sum + sums[cat], 0);
		const lines = CATEGORIES.filter((cat) => sums[cat] > 0).map(
			(cat) =>
				`  ${LABELS[cat].padEnd(17)} ${this.theme.fg("accent", bar(sums[cat] / total, 24))} ≈${fmtTokens(sums[cat]).padStart(6)}  ${fmtPercent(sums[cat], total)}`,
		);
		lines.push(`  ${"Estimated total".padEnd(17)} ${" ".repeat(24)} ≈${fmtTokens(total).padStart(6)}`);
		return lines;
	}

	private rowLine(row: Row): string {
		return `  ${this.theme.fg("muted", LABELS[row.cat].padEnd(17))} ≈${fmtTokens(row.tokens).padStart(6)}  ${row.label}: ${this.theme.fg("dim", row.preview)}`;
	}

	private current(): string[] {
		const { current, usage } = this.data;
		return [
			this.head("Composition (≈ estimates at 4 chars per token)"),
			...this.composition(sumByCategory(current)),
			this.pairs([["Provider-reported total", fmtTokens(usage?.tokens)]]),
			"",
			this.head("Largest items"),
			...[...current]
				.sort((a, b) => b.tokens - a.tokens)
				.slice(0, 12)
				.map((row) => this.rowLine(row)),
		];
	}

	private trend(): Body {
		const requests = this.data.analysis.requests;
		if (requests.length === 0) return { lines: ["No requests yet."] };
		const max = Math.max(...requests.map((r) => r.context), 1);
		const lines = [this.head("Tokens sent per request (provider-reported)")];
		requests.forEach((r, i) => {
			const stop = r.stop === "stop" || r.stop === "toolUse" ? "" : `  ${this.theme.fg("warning", r.stop)}`;
			const line = `#${String(r.n).padStart(3)} ${fmtTime(r.time)} ${bar(r.context / max, 24)} ${fmtTokens(r.context).padStart(6)}  out ${fmtTokens(r.output).padStart(6)}  ${fmtCost(r.cost)}${stop}`;
			lines.push(i === this.request ? this.theme.fg("accent", `▶ ${line}`) : `  ${line}`);
		});
		return { lines, cursor: this.request + 1 };
	}

	private browser(): string[] {
		const request = this.data.analysis.requests[this.request];
		if (!request) return ["No requests yet."];
		const lines = [
			this.head(`Request #${request.n} of ${this.data.analysis.requests.length}`),
			this.pairs([
				["Time", fmtTime(request.time)],
				["Model", request.model],
				["Sent", fmtTokens(request.context)],
				["Output", fmtTokens(request.output)],
				["Took", request.ms == null ? "?" : fmtDuration(request.ms)],
			]),
			"",
		];
		let rows = request.rows;
		if (!rows) {
			rows = this.rebuilt.get(request.n) ?? this.data.reconstruct(request);
			this.rebuilt.set(request.n, rows);
		}
		const sums = request.rows ? sumByCategory(rows) : (request.sums ?? sumByCategory(rows));
		if (rows.length === 0 && !request.sums) return [...lines, "The context of this request cannot be rebuilt from the session."];
		const rebuilt = " (rebuilt from the session)";
		return [
			...lines,
			this.head(`Composition, ≈ estimates${request.rows || request.sums ? "" : rebuilt}`),
			...this.composition(sums),
			"",
			this.head(`Assembled from${request.rows ? "" : rebuilt}`),
			...rows.map((row) => this.rowLine(row)),
		];
	}

	private events(): string[] {
		const events = this.data.analysis.events;
		if (events.length === 0) return ["No compaction, model or branch events on this branch."];
		return events.map((e) => `  ${fmtTime(e.time)}  ${this.theme.fg("accent", e.kind.padEnd(14))} ${e.detail}`);
	}

	private files(): string[] {
		const files = [...this.data.analysis.files].sort(
			(a, b) => b.reads + b.writes + b.edits - (a.reads + a.writes + a.edits),
		);
		const unresolved = this.data.analysis.unresolvedEdits;
		const note = unresolved
			? [this.theme.fg("dim", `  ${unresolved} anchor-based edits are not listed: they were made before pi-context recorded their file.`)]
			: [];
		if (files.length === 0) return ["No file activity yet.", ...note];
		const count = (n: number) => String(n).padStart(5);
		return [
			this.head(` ${"read".padStart(6)}${"write".padStart(6)}${"edit".padStart(6)}  path`),
			...files.map((f) => `  ${count(f.reads)} ${count(f.writes)} ${count(f.edits)}  ${f.path}`),
			...note,
		];
	}

	private commands(): string[] {
		const commands = this.data.analysis.commands;
		if (commands.length === 0) return ["No commands yet."];
		const counts = new Map<string, number>();
		for (const c of commands) counts.set(c.program, (counts.get(c.program) ?? 0) + 1);
		const programs = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10);
		const mark = (ok?: boolean) =>
			ok === undefined ? this.theme.fg("dim", "…") : ok ? this.theme.fg("success", "✓") : this.theme.fg("error", "✗");
		return [
			this.head("Programs"),
			`  ${programs.map(([name, n]) => `${name} ×${n}`).join("   ")}`,
			"",
			this.head("Executions (newest first)"),
			...[...commands].reverse().map((c) => `  ${mark(c.ok)} ${fmtTime(c.time)}  ${c.command.replace(/\s+/g, " ")}`),
		];
	}

	private tools(): string[] {
		const { tools, skills } = this.data.analysis;
		if (tools.length === 0) return ["No tool calls yet."];
		const flagged = tools.some((tool) => undeclared(tool, this.data.declared));
		const count = (n: number) => String(n).padStart(7);
		const size = (tokens: number) => (tokens ? `≈${fmtTokens(tokens)}` : "–").padStart(9);
		const lines = [
			this.head(`${"calls".padStart(9)}${"nested".padStart(8)}${"errors".padStart(8)}${"call".padStart(10)}${"result".padStart(10)}  tool`),
			...[...tools]
				.sort((a, b) => b.calls + b.nested - (a.calls + a.nested))
				.map(
					(tool) =>
						`  ${count(tool.calls)} ${count(tool.nested)} ${tool.errors ? this.theme.fg("error", count(tool.errors)) : count(0)} ${size(tool.callTokens)} ${size(tool.resultTokens)}  ${
							undeclared(tool, this.data.declared) ? this.theme.fg("warning", `${tool.name} !`) : tool.name
						}`,
				),
			...(flagged ? [this.theme.fg("warning", "  ! The model called this tool directly, but the tool is not declared to it now.")] : []),
			this.theme.fg("dim", "  Session totals; token figures are estimates."),
			this.theme.fg("dim", "  A nested call is made by another tool and occupies that tool's tokens."),
			"",
			this.head("Skills loaded"),
		];
		if (skills.length === 0) lines.push("  None.");
		for (const skill of skills) {
			lines.push(`  ${`×${skill.loads}`.padStart(5)} ${size(skill.tokens)}  ${skill.name}  ${this.theme.fg("dim", skill.path)}`);
		}
		return lines;
	}

	private agentLines(agent: AgentRec): string[] {
		const t = this.theme;
		const mark =
			agent.status === "running"
				? t.fg("accent", "●")
				: agent.status === "completed"
					? t.fg("success", "✓")
					: agent.status === "queued" || agent.status === "nested"
						? t.fg("dim", "○")
						: t.fg("error", "✗");
		const details: string[] = [];
		const detail = (key: string, value: string | number) => details.push(`${t.fg("muted", key)} ${value}`);
		detail("Status", agent.status);
		if (agent.startedAt) detail("Time", fmtDuration((agent.completedAt ?? Date.now()) - agent.startedAt));
		if (agent.model) detail("Model", agent.model);
		if (agent.requests != null) detail("Requests", agent.requests);
		if (agent.tokens != null) detail("Tokens", fmtTokens(agent.tokens));
		if (agent.cost != null) detail("Cost", fmtCost(agent.cost));
		if (agent.toolUses != null) detail("Tool uses", agent.toolUses);
		if (agent.compactions) detail("Compactions", agent.compactions);
		const indent = agent.parent ? "    " : "  ";
		const lines = [
			`${indent}${agent.parent ? "↳ " : ""}${mark} ${t.bold(agent.type)}  ${agent.description}  ${t.fg("dim", agent.id)}`,
			...this.wrap(details, `${indent}  `),
		];
		if (agent.error) lines.push(`${indent}  ${t.fg("error", agent.error.replace(/\s+/g, " "))}`);
		return lines;
	}

	private fleet(): string[] {
		const { analysis, agents, usage, model, running, parentSession } = this.data;
		const t = this.theme;
		const context =
			usage?.percent == null ? "?" : `${Math.round(usage.percent)}% ${fmtTokens(usage.tokens)}/${fmtTokens(usage.contextWindow)}`;
		const lines = [
			this.head("Main agent"),
			`  ${running ? t.fg("accent", "●") : t.fg("dim", "○")} ${t.bold(model ?? "?")}  ${running ? "running" : "idle"}`,
			`  ${this.pairs([
				["Context", context],
				["Requests", analysis.requests.length],
				["Cost", fmtCost(analysis.totals.cost)],
			])}`,
		];
		if (parentSession) lines.push(`  ${this.pairs([["Parent session", parentSession]])}`);
		lines.push("", this.head(`Subagents (${agents.length})`));
		if (agents.length === 0) lines.push("  None on this branch.");
		for (const agent of agents) lines.push(...this.agentLines(agent));
		return lines;
	}

	private insightsTab(): string[] {
		const s = this.insights;
		if (!s) return [this.progress];
		const t = this.theme;
		const top = (list: [string, number][]) => this.wrap(list.map(([name, n]) => `${name} ×${n}`));
		const max = Math.max(...s.week.map((day) => day.tokens), 1);
		const peak = Math.max(...s.heat.flat(), 1);
		return [
			this.head(`Last ${s.days} days, all projects`),
			this.pairs([
				["Sessions", s.sessions.length],
				["Requests", s.requests],
				["Tokens", fmtTokens(s.tokens)],
				["Cost", fmtCost(s.cost)],
				["Active days", s.activeDays],
			]),
			"",
			this.head("Last 7 days"),
			...s.week.map(
				(day) =>
					`  ${day.day.slice(5)} ${t.fg("accent", bar(day.tokens / max, 24))} ${fmtTokens(day.tokens).padStart(7)}  ${fmtCost(day.cost).padStart(9)}  ${day.requests} requests`,
			),
			"",
			this.head("Requests by weekday and hour"),
			t.fg("muted", `      ${[0, 6, 12, 18].map((hour) => String(hour).padEnd(12)).join("")}`),
			...s.heat.map(
				(row, i) =>
					`  ${WEEKDAYS[i]} ${row.map((n) => (n ? t.fg("accent", SHADES[Math.min(3, Math.floor((n / peak) * 4))].repeat(2)) : t.fg("dim", "· "))).join("")}`,
			),
			"",
			this.head("Top tools"),
			...top(s.tools),
			this.head("Top programs"),
			...top(s.programs),
			this.head("Top skills"),
			...top(s.skills),
			"",
			this.head("Sessions (newest first)"),
			...s.sessions.map(
				(session) =>
					`  ${fmtDay(session.end).slice(5)} ${fmtTime(session.end).slice(0, 5)}  ${basename(session.cwd).slice(0, 24).padEnd(24)} ${String(session.requests).padStart(5)} req ${fmtTokens(session.tokens).padStart(7)}  ${fmtCost(session.cost).padStart(9)}  ${t.fg("dim", session.name)}`,
			),
		];
	}
}