import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import {
	type AgentRec,
	type CacheMiss,
	cacheStats,
	CATEGORIES,
	type Category,
	LABELS,
	type RequestRec,
	type Row,
	scaleOf,
	sumByCategory,
	sumTokens,
	undeclared,
	type ViewData,
} from "./analyze.ts";
import { DEFAULT_WARN_PERCENT } from "./config.ts";
import { bar, fmtCost, fmtDay, fmtDuration, fmtPercent, fmtTime, fmtTokens } from "./format.ts";
import { aggregate, type Insights, type SessionSort, type SessionSummary } from "./insights.ts";

const TABS = [
	"Stats",
	"Current",
	"Hints",
	"Trend",
	"Browser",
	"Events",
	"Files",
	"Commands",
	"Tools",
	"Fleet",
	"Insights",
	"Settings",
] as const;
export type Tab = (typeof TABS)[number];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SHADES = "░▒▓█";
/** Periods of the Insights tab, in days. */
const PERIODS = [7, 30, 90];
const SORTS: [SessionSort, string][] = [
	["recent", "newest first"],
	["cost", "by cost"],
	["tokens", "by tokens"],
];
export const SETTINGS = ["warn", "prefix", "suffix"] as const;
export type Setting = (typeof SETTINGS)[number];
/** Characters of an item that the inspector shows at most. */
const MAX_INSPECT_CHARS = 200_000;
const REFRESH_MS = 1000;

/** What the overlay needs from the extension. */
export interface OverlayHost {
	collect(): ViewData;
	/** Whether the agent or a subagent is running. */
	isLive(): boolean;
	/** Summaries of the sessions of the last `days` days. */
	loadSummaries(days: number, onProgress: (done: number, total: number) => void): Promise<SessionSummary[]>;
	cwd: string;
	configPath: string;
	/** Tab to open on. */
	tab?: Tab;
}

/** A setting the user asked to change. The overlay closes for the change. */
export interface SettingRequest {
	setting: Setting;
	clear: boolean;
}

interface Body {
	lines: string[];
	/** Line that must stay visible. */
	cursor?: number;
}

function pad(line: string, width: number): string {
	const cut = truncateToWidth(line, width);
	return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

/** Wraps text to the width. Tabs become spaces and other control characters are removed, so every line has a known width. */
function wrapped(text: string, width: number): string[] {
	return text
		.replace(/\t/g, "  ")
		.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
		.split("\n")
		.flatMap((line) => (line ? wrapTextWithAnsi(line, width) : [""]));
}

export class ContextOverlay {
	private tui: TUI;
	private theme: Theme;
	private host: OverlayHost;
	private done: (request?: SettingRequest) => void;
	private data: ViewData;
	private tab: number;
	private scroll = 0;
	private request: number;
	/** Selected line of the list in the Current, Browser and Settings tabs. */
	private item = 0;
	/** Rows of the list in the Current or Browser tab, as of the last render. */
	private rows: Row[] = [];
	/** Compositions rebuilt from the session, by request number. */
	private rebuilt = new Map<number, Row[]>();
	/** The item being inspected. `back` is the scroll position to return to. */
	private inspect?: { title: string; text: string; back: number; lines?: string[]; width?: number };
	private summaries?: SessionSummary[];
	/** Days that `summaries` cover. */
	private loadedDays = 0;
	private insights?: Insights;
	private period = 1;
	private projectOnly = false;
	private sort = 0;
	private loading = false;
	private progress = "";
	/** Width of the body, as of the last render. */
	private width = 80;
	private timer: ReturnType<typeof setInterval>;
	private live = false;
	/** The agent ran since the data was collected. */
	private stale = false;
	private nextRefresh = 0;

	constructor(tui: TUI, theme: Theme, host: OverlayHost, done: (request?: SettingRequest) => void) {
		this.tui = tui;
		this.theme = theme;
		this.host = host;
		this.done = done;
		this.data = host.collect();
		this.tab = Math.max(0, TABS.indexOf(host.tab ?? "Stats"));
		this.request = this.data.analysis.requests.length - 1;
		this.timer = setInterval(() => this.tick(), REFRESH_MS);
		this.timer.unref?.();
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
	}

	handleInput(key: string): void {
		const page = this.bodyHeight() - 1;
		const step = matchesKey(key, "up")
			? -1
			: matchesKey(key, "down")
				? 1
				: matchesKey(key, "pageUp")
					? -page
					: matchesKey(key, "pageDown")
						? page
						: 0;
		const close = matchesKey(key, "escape") || key === "q";
		if (this.inspect) {
			if (close || matchesKey(key, "enter") || matchesKey(key, "left")) {
				this.scroll = this.inspect.back;
				this.inspect = undefined;
			} else this.scroll = Math.max(0, this.scroll + step);
		} else if (close) {
			this.close();
			return;
		} else if (step) this.move(step);
		else if (matchesKey(key, "right") || matchesKey(key, "tab")) this.setTab((this.tab + 1) % TABS.length);
		else if (matchesKey(key, "left") || matchesKey(key, "shift+tab")) this.setTab((this.tab + TABS.length - 1) % TABS.length);
		else if (matchesKey(key, "enter")) {
			if (this.name === "Trend") this.setTab(TABS.indexOf("Browser"));
			else if (this.name === "Current" || this.name === "Browser") this.openItem();
			else if (this.name === "Settings") {
				this.close({ setting: SETTINGS[this.item], clear: false });
				return;
			}
		} else if (key === "x" && this.name === "Settings") {
			this.close({ setting: SETTINGS[this.item], clear: true });
			return;
		} else if (key === "[") this.selectRequest(this.request - 1);
		else if (key === "]") this.selectRequest(this.request + 1);
		else if (key === "r") {
			this.reload();
			this.rebuilt.clear();
			if (this.name === "Insights") this.readInsights();
		} else if (this.name === "Insights" && !this.loading) this.filter(key);
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
		// Then drop trailing tabs that do not fit.
		let end = TABS.length;
		const fits = (to: number) => TABS.slice(first, to).join(" │ ").length + (first > 0 ? 2 : 0) + (to < TABS.length ? 2 : 0) <= inner;
		while (end > this.tab + 1 && !fits(end)) end--;
		const tabs =
			(first > 0 ? t.fg("dim", "… ") : "") +
			TABS.slice(first, end)
				.map((name, i) => (i + first === this.tab ? t.bold(t.fg("accent", name)) : t.fg("muted", name)))
				.join(t.fg("dim", " │ ")) +
			(end < TABS.length ? t.fg("dim", " …") : "");
		const position = lines.length > height ? `  ${this.scroll + 1}-${this.scroll + height}/${lines.length}` : "";
		const hint = (this.live ? t.fg("accent", "● live  ") : "") + t.fg("dim", this.hint() + position);
		const border = (s: string) => t.fg("dim", s);
		const frame = (line: string) => `${border("│")} ${pad(line, inner)} ${border("│")}`;
		const title = " Context ";
		return [
			border(`╭─${title}${"─".repeat(Math.max(0, width - 3 - title.length))}╮`),
			frame(this.inspect ? t.bold(t.fg("accent", this.inspect.title)) : tabs),
			border(`├${"─".repeat(Math.max(0, width - 2))}┤`),
			...visible.map(frame),
			frame(hint),
			border(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
		];
	}

	private get name(): Tab {
		return TABS[this.tab];
	}

	private hint(): string {
		if (this.inspect) return "↑/↓ scroll  esc back";
		const keys: Partial<Record<Tab, string>> = {
			Current: "↑/↓ select  enter inspect",
			Trend: "↑/↓ select  enter browse  [ ] request",
			Browser: "↑/↓ select  enter inspect  [ ] request",
			Insights: "↑/↓ scroll  p period  a project  s sort",
			Settings: "↑/↓ select  enter edit  x clear",
		};
		return `←/→ tab  ${keys[this.name] ?? "↑/↓ scroll"}  r refresh  q close`;
	}

	private close(request?: SettingRequest): void {
		clearInterval(this.timer);
		this.done(request);
	}

	/** Refreshes the data while the agent or a subagent runs, and once more after the run ends. */
	private tick(): void {
		try {
			const live = this.host.isLive();
			if (live !== this.live) this.tui.requestRender();
			this.live = live;
			if (live) this.stale = true;
			if (!this.stale || this.inspect || Date.now() < this.nextRefresh) return;
			this.reload();
			this.stale = live;
			this.tui.requestRender();
		} catch {
			// The session is gone.
			clearInterval(this.timer);
		}
	}

	private reload(): void {
		const started = Date.now();
		const follow = this.request >= this.data.analysis.requests.length - 1;
		this.data = this.host.collect();
		this.selectRequest(follow ? Number.POSITIVE_INFINITY : this.request);
		// Collecting a long session takes time. Spend at most about a tenth of the time on it.
		this.nextRefresh = Date.now() + 9 * (Date.now() - started);
	}

	private bodyHeight(): number {
		return Math.max(6, Math.floor(this.tui.terminal.rows * 0.85) - 5);
	}

	private setTab(tab: number): void {
		this.tab = tab;
		this.scroll = 0;
		this.item = 0;
		if (this.name === "Insights" && !this.summaries) this.readInsights();
	}

	private readInsights(): void {
		if (this.loading) return;
		const days = PERIODS[this.period];
		this.loading = true;
		this.summaries = undefined;
		this.insights = undefined;
		this.progress = "Reading sessions…";
		this.host
			.loadSummaries(days, (done, total) => {
				if (done % 20 !== 0) return;
				this.progress = `Reading sessions… ${done}/${total}`;
				this.tui.requestRender();
			})
			.then(
				(summaries) => {
					this.summaries = summaries;
					this.loadedDays = days;
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

	/** Handles the keys that change what the Insights tab covers. */
	private filter(key: string): void {
		if (key === "p") this.period = (this.period + 1) % PERIODS.length;
		else if (key === "a") this.projectOnly = !this.projectOnly;
		else if (key === "s") this.sort = (this.sort + 1) % SORTS.length;
		else return;
		this.insights = undefined;
		if (PERIODS[this.period] > this.loadedDays) this.readInsights();
	}

	private selectRequest(index: number): void {
		const next = Math.max(0, Math.min(this.data.analysis.requests.length - 1, index));
		if (next !== this.request) this.item = 0;
		this.request = next;
	}

	private move(delta: number): void {
		if (this.name === "Trend") this.selectRequest(this.request + delta);
		else if (this.name === "Current" || this.name === "Browser" || this.name === "Settings") this.item = Math.max(0, this.item + delta);
		else this.scroll = Math.max(0, this.scroll + delta);
	}

	private rebuiltRows(request: RequestRec): Row[] {
		let rows = this.rebuilt.get(request.n);
		if (!rows) {
			rows = this.data.reconstruct(request);
			this.rebuilt.set(request.n, rows);
		}
		return rows;
	}

	/** Opens the selected item of the Current or Browser tab in the inspector. */
	private openItem(): void {
		const row = this.rows[this.item];
		if (!row) return;
		let text = row.text;
		const request = this.data.analysis.requests[this.request];
		if (text === undefined && this.name === "Browser" && request) {
			// A snapshot keeps no content. Find the item in the context rebuilt from the session.
			const rebuilt = this.rebuiltRows(request);
			const same = (other?: Row) => other?.cat === row.cat && other.label === row.label && other.preview === row.preview;
			const fixed = row.cat === "system" || row.cat === "tools";
			text = (same(rebuilt[this.item]) ? rebuilt[this.item] : (rebuilt.find(same) ?? (fixed ? rebuilt.find((other) => other.cat === row.cat) : undefined)))?.text;
		}
		this.inspect = {
			title: `${LABELS[row.cat]} · ${row.label}${text === undefined ? "" : ` · ${fmtTokens(text.length)} characters`}`,
			text: text ?? `${row.preview}\n\n(Only this preview is available. The item was not found in the saved session.)`,
			back: this.scroll,
		};
		this.scroll = 0;
	}

	private inspectLines(): string[] {
		const view = this.inspect;
		if (!view) return [];
		if (!view.lines || view.width !== this.width) {
			view.lines = wrapped(view.text.slice(0, MAX_INSPECT_CHARS), this.width);
			view.width = this.width;
		}
		const more = view.text.length - MAX_INSPECT_CHARS;
		return more > 0 ? [...view.lines, "", this.theme.fg("dim", `(${fmtTokens(more)} more characters are not shown.)`)] : view.lines;
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
		if (this.inspect) return { lines: this.inspectLines() };
		switch (this.name) {
			case "Stats":
				return { lines: this.stats() };
			case "Current":
				return this.current();
			case "Hints":
				return { lines: this.hintsTab() };
			case "Trend":
				return this.trend();
			case "Browser":
				return this.browser();
			case "Events":
				return { lines: this.events() };
			case "Files":
				return { lines: this.files() };
			case "Commands":
				return { lines: this.commands() };
			case "Tools":
				return { lines: this.tools() };
			case "Fleet":
				return { lines: this.fleet() };
			case "Insights":
				return { lines: this.insightsTab() };
			case "Settings":
				return { lines: this.settings() };
		}
	}

	private stats(): string[] {
		const { analysis, usage, model } = this.data;
		const timing = analysis.timing;
		const totals = analysis.totals;
		const cache = cacheStats(analysis);
		const overhead = Math.max(0, timing.activeMs - timing.modelMs - timing.toolMs);
		const share = (ms: number) => `${fmtDuration(ms)} (${fmtPercent(ms, timing.activeMs)})`;
		const cell = (value: string | number, width: number) => String(value).padStart(width);
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
			this.head("Prompt cache"),
			this.pairs([
				["Read from cache", fmtPercent(cache.rate, 1)],
				["Misses", cache.misses],
				...(cache.misses ? [["Billed again", `≈${fmtTokens(cache.tokens)} tokens (≈${fmtCost(cache.cost)} extra)`] as [string, string]] : []),
			]),
			"",
			this.head("Models"),
			this.theme.fg("muted", `  ${cell("requests", 8)} ${cell("sent", 8)} ${cell("output", 8)} ${cell("cost", 10)}  model`),
			...[...analysis.models]
				.sort((a, b) => b.cost - a.cost || b.sent - a.sent)
				.map(
					(m) =>
						`  ${cell(m.requests, 8)} ${cell(fmtTokens(m.sent), 8)} ${cell(fmtTokens(m.output), 8)} ${cell(fmtCost(m.cost), 10)}  ${m.model}`,
				),
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

	/** Shares of the categories. With `reported`, the provider-reported size, the estimates are scaled to add up to it. */
	private composition(sums: Record<Category, number>, reported?: number | null): string[] {
		const total = CATEGORIES.reduce((sum, cat) => sum + sums[cat], 0);
		const factor = scaleOf(total, reported);
		const lines = CATEGORIES.filter((cat) => sums[cat] > 0).map(
			(cat) =>
				`  ${LABELS[cat].padEnd(17)} ${this.theme.fg("accent", bar(sums[cat] / total, 24))} ≈${fmtTokens(sums[cat] * factor).padStart(6)}  ${fmtPercent(sums[cat], total)}`,
		);
		if (factor === 1) {
			lines.push(
				`  ${"Estimated total".padEnd(17)} ${" ".repeat(24)} ≈${fmtTokens(total).padStart(6)}`,
				this.theme.fg("dim", "  ≈ sizes at 4 characters per token. No provider-reported total to scale them to."),
			);
		} else {
			lines.push(
				`  ${"Provider-reported".padEnd(17)} ${" ".repeat(24)}  ${fmtTokens(reported).padStart(6)}`,
				this.theme.fg("dim", `  ≈ sizes at 4 characters per token, scaled ×${factor.toFixed(2)} to the provider-reported total.`),
			);
		}
		return lines;
	}

	/** A selectable list of rows that starts `above` lines into the tab. */
	private list(rows: Row[], factor: number, above: number): Body {
		const t = this.theme;
		this.rows = rows;
		this.item = Math.min(this.item, Math.max(0, rows.length - 1));
		const lines = rows.map((row, i) => {
			const line = `${t.fg("muted", LABELS[row.cat].padEnd(17))} ≈${fmtTokens(row.tokens * factor).padStart(6)}  ${row.label}: ${t.fg("dim", row.preview)}`;
			return i === this.item ? `${t.fg("accent", "▶")} ${line}` : `  ${line}`;
		});
		// With the first item selected, the tab shows from its top.
		return { lines, cursor: this.item === 0 ? 0 : above + this.item };
	}

	private current(): Body {
		const { current, usage, factor } = this.data;
		const top = [this.head("Composition"), ...this.composition(sumByCategory(current), usage?.tokens), "", this.head("Items, largest first")];
		const list = this.list(
			[...current].sort((a, b) => b.tokens - a.tokens),
			factor,
			top.length,
		);
		return { lines: [...top, ...list.lines], cursor: list.cursor };
	}

	private hintsTab(): string[] {
		const { hints, factor, usage } = this.data;
		if (hints.length === 0) {
			return ["Nothing stands out: no repeated reads, no repeated skill loads, and no large tool results from earlier turns."];
		}
		const total = hints.reduce((sum, hint) => sum + hint.tokens, 0) * factor;
		return [
			this.head("Could be dropped from the context"),
			this.pairs([
				["Tokens", `≈${fmtTokens(total)}`],
				["Share of the context", usage?.tokens ? fmtPercent(total, usage.tokens) : "?"],
			]),
			"",
			...hints.map(
				(hint) => `  ≈${fmtTokens(hint.tokens * factor).padStart(6)}  ${hint.label}  ${this.theme.fg("dim", hint.detail)}`,
			),
			"",
			this.theme.fg("dim", "  This list is advice. pi-context does not remove anything from the context."),
		];
	}

	private missText(miss: CacheMiss): string {
		return `≈${fmtTokens(miss.tokens)} tokens of the previous request were billed again (≈${fmtCost(miss.cost)} extra), ${fmtDuration(miss.idleMs)} after it`;
	}

	private trend(): Body {
		const requests = this.data.analysis.requests;
		if (requests.length === 0) return { lines: ["No requests yet."] };
		const max = Math.max(...requests.map((r) => r.context), 1);
		const lines = [this.head("Tokens sent per request (provider-reported), and the share read from the cache")];
		requests.forEach((r, i) => {
			const stop = r.stop === "stop" || r.stop === "toolUse" ? "" : `  ${this.theme.fg("warning", r.stop)}`;
			const miss = r.miss ? `  ${this.theme.fg("warning", `cache miss ≈${fmtTokens(r.miss.tokens)}`)}` : "";
			const line = `#${String(r.n).padStart(3)} ${fmtTime(r.time)} ${bar(r.context / max, 24)} ${fmtTokens(r.context).padStart(6)}  out ${fmtTokens(r.output).padStart(6)}  cache ${fmtPercent(r.cacheRead, r.context).padStart(4)}  ${fmtCost(r.cost)}${miss}${stop}`;
			lines.push(i === this.request ? this.theme.fg("accent", `▶ ${line}`) : `  ${line}`);
		});
		return { lines, cursor: this.request + 1 };
	}

	private browser(): Body {
		const request = this.data.analysis.requests[this.request];
		if (!request) return { lines: ["No requests yet."] };
		const top = [
			this.head(`Request #${request.n} of ${this.data.analysis.requests.length}`),
			this.pairs([
				["Time", fmtTime(request.time)],
				["Model", request.model],
				["Sent", fmtTokens(request.context)],
				["From cache", fmtPercent(request.cacheRead, request.context)],
				["Output", fmtTokens(request.output)],
				["Took", request.ms == null ? "?" : fmtDuration(request.ms)],
			]),
		];
		if (request.miss) top.push(this.theme.fg("warning", `  Cache miss: ${this.missText(request.miss)}.`));
		top.push("");
		const rows = request.rows ?? this.rebuiltRows(request);
		if (rows.length === 0 && !request.sums) {
			return { lines: [...top, "The context of this request cannot be rebuilt from the session."] };
		}
		const sums = request.rows ? sumByCategory(rows) : (request.sums ?? sumByCategory(rows));
		const rebuilt = " (rebuilt from the session)";
		top.push(
			this.head(`Composition${request.rows || request.sums ? "" : rebuilt}`),
			...this.composition(sums, request.context),
			"",
			this.head(`Assembled from${request.rows ? "" : rebuilt}`),
		);
		const list = this.list(rows, scaleOf(sumTokens(rows), request.context), top.length);
		return { lines: [...top, ...list.lines], cursor: list.cursor };
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
		const { analysis, declared, factor } = this.data;
		const { tools, skills } = analysis;
		if (tools.length === 0) return ["No tool calls yet."];
		const flagged = tools.some((tool) => undeclared(tool, declared) > 0);
		const count = (n: number) => String(n).padStart(7);
		const size = (tokens: number) => (tokens ? `≈${fmtTokens(tokens * factor)}` : "–").padStart(9);
		const name = (tool: (typeof tools)[number]) => {
			const calls = undeclared(tool, declared);
			return calls ? this.theme.fg("warning", `${tool.name}  ! ${calls} not declared`) : tool.name;
		};
		const lines = [
			this.head(`${"calls".padStart(9)}${"nested".padStart(8)}${"errors".padStart(8)}${"call".padStart(10)}${"result".padStart(10)}  tool`),
			...[...tools]
				.sort((a, b) => b.calls + b.nested - (a.calls + a.nested))
				.map(
					(tool) =>
						`  ${count(tool.calls)} ${count(tool.nested)} ${tool.errors ? this.theme.fg("error", count(tool.errors)) : count(0)} ${size(tool.callTokens)} ${size(tool.resultTokens)}  ${name(tool)}`,
				),
			...(flagged ? [this.theme.fg("warning", "  ! Direct calls that the model made while the tool was not declared to it.")] : []),
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
		if (!this.summaries) return [this.progress];
		const t = this.theme;
		const days = PERIODS[this.period];
		this.insights ??= aggregate(this.summaries, Date.now(), days, {
			cwd: this.projectOnly ? this.host.cwd : undefined,
			sort: SORTS[this.sort][0],
		});
		const s = this.insights;
		const top = (list: [string, number][]) => this.wrap(list.map(([name, n]) => `${name} ×${n}`));
		const max = Math.max(...s.week.map((day) => day.tokens), 1);
		const peak = Math.max(...s.heat.flat(), 1);
		return [
			this.head(`Last ${days} days, ${this.projectOnly ? `project ${basename(this.host.cwd)}` : "all projects"}`),
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
			this.head("Models"),
			...(s.models.length === 0 ? ["  None."] : []),
			...s.models.map(
				([name, requests, tokens, cost]) =>
					`  ${String(requests).padStart(7)} req ${fmtTokens(tokens).padStart(7)}  ${fmtCost(cost).padStart(9)}  ${name}`,
			),
			"",
			this.head("Top tools"),
			...top(s.tools),
			this.head("Top programs"),
			...top(s.programs),
			this.head("Top skills"),
			...top(s.skills),
			"",
			this.head(`Sessions (${SORTS[this.sort][1]})`),
			...s.sessions.map(
				(session) =>
					`  ${fmtDay(session.end).slice(5)} ${fmtTime(session.end).slice(0, 5)}  ${basename(session.cwd).slice(0, 24).padEnd(24)} ${String(session.requests).padStart(5)} req ${fmtTokens(session.tokens).padStart(7)}  ${fmtCost(session.cost).padStart(9)}  ${t.fg("dim", session.name)}`,
			),
		];
	}

	private settings(): string[] {
		const { config } = this.data;
		const t = this.theme;
		const affix = (text?: string) => (text ? `${text.length} characters: ${text.replace(/\s+/g, " ").slice(0, 60)}` : "disabled");
		const warn = config.warnPercent ?? DEFAULT_WARN_PERCENT;
		const items = [
			{
				name: "Context warning",
				value: config.warnPercent === undefined ? `${warn}% (default)` : warn ? `${warn}%` : "disabled",
				help: "A notification appears when context use rises to this share of the window. Clearing restores the default.",
			},
			{
				name: "System prompt prefix",
				value: affix(config.systemPromptPrefix),
				help: "Text joined to the start of the system prompt of every session. It applies from the next turn.",
				text: config.systemPromptPrefix,
			},
			{
				name: "System prompt suffix",
				value: affix(config.systemPromptSuffix),
				help: "Text joined to the end of the system prompt of every session. It applies from the next turn.",
				text: config.systemPromptSuffix,
			},
		];
		this.item = Math.min(this.item, items.length - 1);
		const selected = items[this.item];
		return [
			this.head("Settings"),
			...items.map((item, i) => `${i === this.item ? t.fg("accent", "▶") : " "} ${item.name.padEnd(22)} ${item.value}`),
			"",
			...wrapped(selected.help, this.width - 2).map((line) => t.fg("dim", `  ${line}`)),
			t.fg("dim", `  Saved in ${this.host.configPath}`),
			...(selected.text ? ["", this.head("Value"), ...wrapped(selected.text, this.width - 2).map((line) => `  ${line}`)] : []),
		];
	}
}