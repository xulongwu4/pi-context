import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { CATEGORIES, LABELS, type Row, sumByCategory, type ViewData } from "./analyze.ts";
import { bar, fmtCost, fmtDuration, fmtPercent, fmtTime, fmtTokens } from "./format.ts";

const TABS = ["Stats", "Current", "Trend", "Browser", "Events", "Files", "Commands"];
const TREND = 2;
const BROWSER = 3;

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
	private done: () => void;
	private tab = 0;
	private scroll = 0;
	private request: number;

	constructor(tui: TUI, theme: Theme, data: ViewData, refresh: () => ViewData, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.data = data;
		this.refresh = refresh;
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
			this.selectRequest(this.request);
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const t = this.theme;
		const inner = Math.max(10, width - 4);
		const height = this.bodyHeight();
		const { lines, cursor } = this.body();
		if (cursor !== undefined) {
			if (cursor < this.scroll) this.scroll = cursor;
			if (cursor >= this.scroll + height) this.scroll = cursor - height + 1;
		}
		this.scroll = Math.max(0, Math.min(this.scroll, lines.length - height));
		const visible = lines.slice(this.scroll, this.scroll + height);
		while (visible.length < height) visible.push("");

		const tabs = TABS.map((name, i) => (i === this.tab ? t.bold(t.fg("accent", name)) : t.fg("muted", name))).join(
			t.fg("dim", " │ "),
		);
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
			default:
				return { lines: this.commands() };
		}
	}

	private stats(): string[] {
		const { analysis, usage, timing, model } = this.data;
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
			this.head("Timing (since pi-context loaded)"),
			this.pairs([
				["Active", fmtDuration(timing.activeMs)],
				["Model calls", share(timing.modelMs)],
				["Tool runs", share(timing.toolMs)],
				["Overhead", share(overhead)],
			]),
		];
	}

	private composition(rows: Row[]): string[] {
		const sums = sumByCategory(rows);
		const total = rows.reduce((sum, row) => sum + row.tokens, 0);
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
			...this.composition(current),
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
		if (!request.rows) return [...lines, "No snapshot: this request was made before pi-context was loaded."];
		return [
			...lines,
			this.head("Composition (≈ estimates)"),
			...this.composition(request.rows),
			"",
			this.head("Assembled from"),
			...request.rows.map((row) => this.rowLine(row)),
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
		if (files.length === 0) return ["No file activity yet."];
		const count = (n: number) => String(n).padStart(5);
		return [
			this.head(` ${"read".padStart(6)}${"write".padStart(6)}${"edit".padStart(6)}  path`),
			...files.map((f) => `  ${count(f.reads)} ${count(f.writes)} ${count(f.edits)}  ${f.path}`),
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
}
