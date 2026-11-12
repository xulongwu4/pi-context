import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import {
	type AgentRec,
	bands,
	type CacheMiss,
	cacheStats,
	CATEGORIES,
	type Category,
	diffRows,
	eventKinds,
	introducedAt,
	LABELS,
	type RequestRec,
	type Row,
	scaleOf,
	sumByCategory,
	sumTokens,
	textOf,
	trendBars,
	undeclared,
	type ViewData,
} from "./analyze.ts";
import { DEFAULT_WARN_PERCENT } from "./config.ts";
import { footerItems } from "./footer.ts";
import { bar, fmtCost, fmtDay, fmtDuration, fmtPercent, fmtTime, fmtTokens, sparkline } from "./format.ts";
import { hintTotal } from "./hints.ts";
import { aggregate, calendar, type Insights, type SessionSort, type SessionSummary } from "./insights.ts";

const TABS = [
	"Stats",
	"Current",
	"Hints",
	"Turns",
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
/** Periods of the Insights tab, in days. The last one has no start. */
const PERIODS = [7, 30, 90, Number.POSITIVE_INFINITY];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SORTS: [SessionSort, string][] = [
	["recent", "newest first"],
	["cost", "by cost"],
	["tokens", "by tokens"],
];
export const SETTINGS = ["warn", "compact", "budget", "expiry", "footer", "prefix", "suffix"] as const;
export type Setting = (typeof SETTINGS)[number];
/** Characters of an item that the inspector shows at most. */
const MAX_INSPECT_CHARS = 200_000;
const REFRESH_MS = 1000;
/** Tabs whose lists the user can filter. */
const FILTERED: Tab[] = ["Current", "Browser", "Files", "Commands", "Tools", "Insights"];
/** Removed items that the Browser tab lists at most. */
const MAX_REMOVED = 30;
/** Cells of the Trend tab that a change takes at most, on each side of the middle. */
const HALF_BAR = 12;
/** Color of each category in the strip of the reading order. */
const COLORS: Record<Category, Parameters<Theme["fg"]>[0]> = {
	system: "syntaxKeyword",
	tools: "syntaxType",
	user: "success",
	injected: "warning",
	skills: "syntaxNumber",
	toolCalls: "syntaxFunction",
	toolResults: "accent",
	reasoning: "thinkingText",
	answers: "text",
};

/** What the overlay needs from the extension. */
export interface OverlayHost {
	collect(): ViewData;
	/** Whether the agent or a subagent is running. */
	isLive(): boolean;
	/** Summaries of the sessions of the last `days` days. */
	loadSummaries(days: number, onProgress: (done: number, total: number) => void): Promise<SessionSummary[]>;
	/** The dashboard data of a saved session. Throws when the file cannot be read. */
	openSession(file: string, title: string): ViewData;
	/** Drops tool results from the context, or restores them. */
	setDropped(ids: string[], dropped: boolean): void;
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
	/** Selected entry of the list that the tab shows. */
	private item = 0;
	/** Body line of each entry of the list in the Insights or Fleet tab, and the session it opens, as of the last render. */
	private picks: { line: number; file?: string; title: string }[] = [];
	/** Entries of the list in the Hints tab, as of the last render. */
	private hintList: { ids: string[]; dropped: boolean }[] = [];
	/** Text that the lists of the tab must contain. */
	private filterText = "";
	/** The user is typing the filter. */
	private typing = false;
	/** Shown in place of the key hints until the next key. */
	private notice = "";
	/** Where to return to when the overlay shows another session. */
	private back?: { tab: number; scroll: number; item: number };
	/** Rows of the list in the Current or Browser tab, as of the last render. */
	private rows: Row[] = [];
	/** Position in the prompt of each of \`rows\`. */
	private positions: number[] = [];
	/** The Current tab lists the items in reading order, not largest first. */
	private ordered = false;
	/** Whether the Trend tab shows one bar for each human input, and whether a bar is the change since the bar before. */
	private byTurn = false;
	private delta = false;
	/** Compositions rebuilt from the session, by request number. */
	private rebuilt = new Map<number, Row[]>();
	/** The item being inspected. `back` is the scroll position to return to. */
	private inspect?: { title: string; text: string; back: number; lines?: string[]; width?: number };
	private summaries?: SessionSummary[];
	/** Days that `summaries` cover. */
	private loadedDays = 0;
	private insights?: Insights;
	private period = 1;
	/** The kind of event that the Events tab lists. Empty: every kind. */
	private kind = "";
	/** The day that the Insights tab is narrowed to. */
	private day?: string;
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
		this.notice = "";
		if (this.typing) {
			if (matchesKey(key, "enter")) this.typing = false;
			else if (matchesKey(key, "escape")) {
				this.typing = false;
				this.filterText = "";
			} else if (matchesKey(key, "backspace")) this.filterText = this.filterText.slice(0, -1);
			else if ([...key].length === 1 && key >= " " && key !== "\x7f") this.filterText += key;
			this.item = 0;
			this.scroll = 0;
			this.tui.requestRender();
			return;
		}
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
		const escape = matchesKey(key, "escape");
		if (this.inspect) {
			if (escape || key === "q" || matchesKey(key, "enter") || matchesKey(key, "left")) {
				this.scroll = this.inspect.back;
				this.inspect = undefined;
			} else this.scroll = Math.max(0, this.scroll + step);
		} else if (escape && this.filterText) this.filterText = "";
		else if (escape && this.back) this.leaveSession();
		else if (escape || key === "q") {
			this.close();
			return;
		} else if (step) this.move(step);
		else if (matchesKey(key, "right") || matchesKey(key, "tab")) this.setTab((this.tab + 1) % TABS.length);
		else if (matchesKey(key, "left") || matchesKey(key, "shift+tab")) this.setTab((this.tab + TABS.length - 1) % TABS.length);
		else if (matchesKey(key, "enter")) {
			if (this.name === "Trend") this.setTab(TABS.indexOf("Browser"));
			else if (this.name === "Turns") this.openTurn();
			else if (this.name === "Current" || this.name === "Browser") this.openItem();
			else if (this.name === "Insights" || this.name === "Fleet") this.openSession();
			else if (this.name === "Settings") {
				this.close({ setting: SETTINGS[this.item], clear: false });
				return;
			}
		} else if (key === "x" && this.name === "Settings") {
			this.close({ setting: SETTINGS[this.item], clear: true });
			return;
		} else if (key === "/" && FILTERED.includes(this.name)) this.typing = true;
		else if ((key === "d" || key === "u") && (this.name === "Current" || this.name === "Hints")) this.drop(key === "d");
		else if (key === "k" && this.name === "Events") {
			const kinds = ["", ...eventKinds(this.data.analysis.events).map(([kind]) => kind)];
			this.kind = kinds[(kinds.indexOf(this.kind) + 1) % kinds.length];
			this.scroll = 0;
		} else if (key === "g" && this.name === "Trend") this.byTurn = !this.byTurn;
		else if (key === "m" && this.name === "Trend") this.delta = !this.delta;
		else if (key === "o" && this.name === "Current") {
			this.ordered = !this.ordered;
			this.item = 0;
			this.scroll = 0;
		}
		else if ((key === "[" || key === "]") && this.name === "Insights") this.stepDay(key === "[" ? -1 : 1);
		else if (key === "[") this.selectRequest(this.request - 1);
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
		const more = this.tab + 1 < TABS.length ? 2 : 0;
		const span = (from: number) => TABS.slice(from, this.tab + 1).join(" │ ").length + (from > 0 ? 2 : 0) + more;
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
		const hint = this.notice
			? t.fg("warning", this.notice)
			: (this.live ? t.fg("accent", "● live  ") : "") + t.fg("dim", this.hint() + position);
		const border = (s: string) => t.fg("dim", s);
		const frame = (line: string) => `${border("│")} ${pad(line, inner)} ${border("│")}`;
		const other = this.data.other?.replace(/\s+/g, " ");
		const title = other === undefined ? " Context " : ` Context · ${truncateToWidth(other, Math.max(4, width - 30))} (read-only) `;
		return [
			border(`╭─${title}${"─".repeat(Math.max(0, width - 3 - visibleWidth(title)))}╮`),
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
		if (this.typing) return `Filter: ${this.filterText}▏  enter keep  esc clear`;
		if (this.inspect) return "↑/↓ scroll  esc back";
		const keys: Partial<Record<Tab, string>> = {
			Current: "↑/↓ select  enter inspect  o order  d drop  u restore  / filter",
			Hints: "↑/↓ select  d drop  u restore",
			Turns: "↑/↓ select  enter browse",
			Trend: `↑/↓ select  enter browse  [ ] request  g ${this.byTurn ? "requests" : "inputs"}  m ${this.delta ? "totals" : "changes"}`,
			Browser: "↑/↓ select  enter inspect  [ ] request  / filter",
			Events: "↑/↓ scroll  k kind",
			Files: "↑/↓ scroll  / filter",
			Commands: "↑/↓ scroll  / filter",
			Tools: "↑/↓ scroll  / filter",
			Fleet: "↑/↓ select  enter open",
			Insights: "↑/↓ select  enter open  p period  [ ] day  a project  s sort  / filter",
			Settings: "↑/↓ select  enter edit  x clear",
		};
		const filter = this.filterText ? `filter "${this.filterText}" (esc clears)  ` : "";
		return `${filter}←/→ tab  ${keys[this.name] ?? "↑/↓ scroll"}  r refresh  ${this.back ? "esc back  " : ""}q close`;
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
			if (!this.stale || this.inspect || this.back || Date.now() < this.nextRefresh) return;
			this.reload();
			this.stale = live;
			this.tui.requestRender();
		} catch {
			// The session is gone.
			clearInterval(this.timer);
		}
	}

	private reload(): void {
		// Another session is shown as it was when it was opened.
		if (this.back) return;
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
		this.picks = [];
		this.filterText = "";
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
		if (key === "p") {
			this.period = (this.period + 1) % PERIODS.length;
			this.day = undefined;
		} else if (key === "a") this.projectOnly = !this.projectOnly;
		else if (key === "s") this.sort = (this.sort + 1) % SORTS.length;
		else return;
		this.insights = undefined;
		if (PERIODS[this.period] > this.loadedDays) this.readInsights();
	}

	/**
	 * Narrows the Insights tab to the day before or after the selected one. Without a selected day, it selects today.
	 * A step past today returns to the whole period.
	 */
	private stepDay(delta: number): void {
		const days = this.insights?.daily ?? [];
		if (days.length === 0) return;
		const index = days.findIndex((stat) => stat.day === this.day);
		const next = index < 0 ? days.length - 1 : index + delta;
		this.day = next >= days.length ? undefined : days[Math.max(0, next)].day;
		this.insights = undefined;
		this.item = 0;
	}

	/** The days of the period as a calendar: one column per week, shaded by the tokens of the day. */
	private days(s: Insights): string[] {
		const t = this.theme;
		const rows = calendar(s.daily);
		// Show the most recent weeks that fit.
		const weeks = Math.min(rows[0].length, Math.max(1, Math.floor((this.width - 6) / 2)));
		const shown = rows.map((row) => row.slice(-weeks));
		const peak = Math.max(...s.daily.map((stat) => stat.tokens), 1);
		// Name a month above the first week that starts in it.
		const months = new Array<string>(weeks * 2).fill(" ");
		let last = "";
		for (let week = 0; week < weeks; week++) {
			const month = shown.map((row) => row[week]).find((stat) => stat)?.day.slice(5, 7) ?? last;
			if (month !== last && week * 2 + 3 <= months.length) months.splice(week * 2, 3, ...MONTHS[Number(month) - 1]);
			last = month;
		}
		const cell = (stat?: { day: string; tokens: number }) =>
			!stat
				? "  "
				: stat.day === s.day
					? t.bold(t.fg("warning", "[]"))
					: stat.tokens
						? t.fg("accent", SHADES[Math.min(3, Math.floor((stat.tokens / peak) * 4))].repeat(2))
						: t.fg("dim", "· ");
		const chosen = s.daily.find((stat) => stat.day === s.day);
		const hidden = rows[0].length - weeks;
		return [
			t.fg("muted", `      ${months.join("")}`.trimEnd()),
			...shown.map((row, i) => `  ${WEEKDAYS[i]} ${row.map(cell).join("")}`),
			t.fg(
				"dim",
				chosen
					? `  [] ${chosen.day}: ${chosen.requests} requests, ${fmtTokens(chosen.tokens)} tokens, ${fmtCost(chosen.cost)}. [ ] change the day; ] on today shows the whole period.`
					: `  Shaded by the tokens of the day. [ selects today, then [ ] change the day.${hidden > 0 ? ` ${hidden} earlier weeks do not fit.` : ""}`,
			),
		];
	}

	private selectRequest(index: number): void {
		const next = Math.max(0, Math.min(this.data.analysis.requests.length - 1, index));
		if (next !== this.request) this.item = 0;
		this.request = next;
	}

	/** Position of the bar of the Trend tab that shows the selected request. */
	private barAt(bars: { index: number }[]): number {
		const at = bars.findIndex((bar) => bar.index >= this.request);
		return at < 0 ? bars.length - 1 : at;
	}
	private move(delta: number): void {
		const listed: Tab[] = ["Current", "Hints", "Turns", "Browser", "Settings"];
		if (this.name === "Trend") {
			const bars = trendBars(this.data.analysis, this.byTurn, false);
			const next = Math.max(0, Math.min(bars.length - 1, this.barAt(bars) + delta));
			this.selectRequest(bars[next]?.index ?? 0);
		}
		else if (listed.includes(this.name)) this.item = Math.max(0, this.item + delta);
		else if (this.name === "Insights" || this.name === "Fleet") this.pick(delta);
		else this.scroll = Math.max(0, this.scroll + delta);
	}

	/**
	 * Moves in a tab whose list follows other content. The tab scrolls like a page until the selected entry is in view;
	 * then the selection moves, and the tab scrolls again when the selection is at an end of the list.
	 */
	private pick(delta: number): void {
		const height = this.bodyHeight();
		const inView = (line: number | undefined) => line !== undefined && line >= this.scroll && line < this.scroll + height;
		const next = Math.max(0, Math.min(this.picks.length - 1, this.item + delta));
		if (!inView(this.picks[this.item]?.line) || next === this.item) {
			this.scroll = Math.max(0, this.scroll + delta);
			return;
		}
		this.item = next;
		const line = this.picks[next].line;
		if (line < this.scroll) this.scroll = line;
		else if (line >= this.scroll + height) this.scroll = line - height + 1;
	}

	/** Whether the text passes the filter of the tab. */
	private matches(text: string): boolean {
		return !this.filterText || text.toLowerCase().includes(this.filterText.toLowerCase());
	}

	/** Opens the first request of the selected turn in the Browser tab. */
	private openTurn(): void {
		const input = this.data.analysis.inputs.at(-1 - this.item);
		if (!input || input.first < 0) {
			this.notice = "This input caused no request.";
			return;
		}
		this.selectRequest(input.first);
		this.setTab(TABS.indexOf("Browser"));
	}

	/** Shows the session of the selected entry of the Insights or Fleet tab. */
	private openSession(): void {
		const pick = this.picks[this.item];
		if (!pick) return;
		const height = this.bodyHeight();
		if (pick.line < this.scroll || pick.line >= this.scroll + height) {
			// Do not open an entry that the user cannot see.
			this.scroll = Math.max(0, pick.line - Math.floor(height / 2));
			this.notice = "The selected entry is now in view. Press enter again to open it.";
			return;
		}
		if (!pick.file) {
			this.notice = "No saved session is known for this entry.";
			return;
		}
		try {
			const data = this.host.openSession(pick.file, pick.title);
			this.back ??= { tab: this.tab, scroll: this.scroll, item: this.item };
			this.show(data);
			this.setTab(0);
		} catch (error) {
			this.notice = `Could not open the session: ${error instanceof Error ? error.message : error}`;
		}
	}

	/** Returns from another session to the current one. */
	private leaveSession(): void {
		const back = this.back;
		if (!back) return;
		this.back = undefined;
		this.show(this.host.collect());
		this.setTab(back.tab);
		this.scroll = back.scroll;
		this.item = back.item;
	}

	private show(data: ViewData): void {
		this.data = data;
		this.rebuilt.clear();
		this.request = data.analysis.requests.length - 1;
	}

	/** Drops the selected tool result from the context, or restores it. */
	private drop(dropping: boolean): void {
		if (this.back) {
			this.notice = "Another session is read-only.";
			return;
		}
		let ids: string[] = [];
		if (this.name === "Current") {
			const row = this.rows[this.item];
			if (!row?.id) this.notice = "Only tool results can be dropped.";
			else if (!!row.dropped !== dropping) ids = [row.id];
		} else {
			const entry = this.hintList[this.item];
			if (entry && entry.dropped !== dropping) ids = entry.ids;
		}
		if (ids.length === 0) return;
		this.host.setDropped(ids, dropping);
		this.reload();
		this.notice = dropping
			? "Dropped: from the next request on, the model gets a stub. That request reads less from the prompt cache."
			: "Restored: the model gets the result again from the next request on.";
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
			text = textOf(row, this.positions[this.item], this.rebuiltRows(request));
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
				return this.hintsTab();
			case "Turns":
				return this.turns();
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
		const window = !usage
			? "  unknown"
			: usage.contextWindow > 0
				? `  ${bar((usage.percent ?? 0) / 100, 30)} ${fmtTokens(usage.tokens)} / ${fmtTokens(usage.contextWindow)} (${
						usage.percent == null ? "?" : `${Math.round(usage.percent)}%`
					})`
				: `  ${fmtTokens(usage.tokens)} tokens after the last request. The size of the window is not known.`;
		const billed = analysis.billedRequests
			? [
					"",
					this.head(`Sent over the session, by category (${analysis.billedRequests} of ${analysis.requests.length} requests recorded by pi-context)`),
					...this.shares(analysis.billed),
					this.theme.fg("dim", "  Each request sends the whole context again. A category's figure is the sum over the requests."),
				]
			: [];
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
			...billed,
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

	/** One line for each category that has tokens: a bar for its share, and its size times `factor`. */
	private shares(sums: Record<Category, number>, factor = 1): string[] {
		const total = CATEGORIES.reduce((sum, cat) => sum + sums[cat], 0);
		return CATEGORIES.filter((cat) => sums[cat] > 0).map(
			(cat) =>
				`  ${LABELS[cat].padEnd(17)} ${this.theme.fg("accent", bar(sums[cat] / total, 24))} ≈${fmtTokens(sums[cat] * factor).padStart(6)}  ${fmtPercent(sums[cat], total)}`,
		);
	}

	/** Shares of the categories. With `reported`, the provider-reported size, the estimates are scaled to add up to it. */
	private composition(sums: Record<Category, number>, reported?: number | null): string[] {
		const total = CATEGORIES.reduce((sum, cat) => sum + sums[cat], 0);
		const factor = scaleOf(total, reported);
		const lines = this.shares(sums, factor);
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

	/**
	 * A section with the rows as one strip in reading order and a legend. Each cell has the color of the category at that place of the prompt.
	 * A mark under the strip shows where the row at position `selected` is.
	 */
	private strip(rows: Row[], selected?: number): string[] {
		const t = this.theme;
		const width = Math.max(1, this.width - 2);
		const cells = bands(rows, width);
		if (cells.length === 0) return [];
		let mark = "";
		if (selected !== undefined && rows[selected]) {
			const middle = sumTokens(rows.slice(0, selected)) + rows[selected].tokens / 2;
			mark = " ".repeat(Math.min(width - 1, Math.floor((middle / sumTokens(rows)) * width))) + t.fg("accent", "▲");
		}
		const present = new Set(rows.map((row) => row.cat));
		return [
			this.head("Reading order"),
			`  ${cells.map((cat) => t.fg(COLORS[cat], "█")).join("")}`,
			`  ${mark}`,
			...this.wrap(CATEGORIES.filter((cat) => present.has(cat)).map((cat) => `${t.fg(COLORS[cat], "█")} ${t.fg("muted", LABELS[cat])}`)),
			"",
		];
	}

	/**
	 * A selectable list of the rows that pass the filter. It starts `above` lines into the tab.
	 * `marks` holds one mark for each row: "+" added, "~" changed. `positions` holds the position of each row in the prompt;
	 * without it the rows are in reading order.
	 */
	private list(rows: Row[], factor: number, above: number, marks?: string[], positions?: number[]): Body {
		const t = this.theme;
		const requests = this.data.analysis.requests;
		const shown = rows
			.map((row, i) => ({ row, mark: marks?.[i], position: positions?.[i] ?? i, from: introducedAt(row, requests) }))
			.filter(({ row }) => this.matches(`${LABELS[row.cat]} ${row.dropped ? "dropped " : ""}${row.label} ${row.preview}`));
		this.rows = shown.map(({ row }) => row);
		this.positions = shown.map(({ position }) => position);
		this.item = Math.min(this.item, Math.max(0, shown.length - 1));
		if (shown.length === 0) return { lines: [rows.length > 0 ? "  No item matches the filter." : "  None."] };
		const positionWidth = String(rows.length).length + 1;
		const fromWidth = Math.max(0, ...shown.map(({ from }) => (from === undefined ? 0 : String(from).length + 1)));
		const lines = shown.map(({ row, mark, position, from }, i) => {
			const change = mark === undefined ? "" : `${mark === "+" ? t.fg("success", "+") : mark === "~" ? t.fg("warning", "~") : " "} `;
			const state = row.dropped ? t.fg("warning", "dropped  ") : "";
			const where = t.fg("dim", `#${position + 1}`.padStart(positionWidth));
			const first = fromWidth ? ` ${t.fg("dim", (from === undefined ? "" : `@${from}`).padEnd(fromWidth))}` : "";
			const category = `${t.fg(COLORS[row.cat], "█")} ${t.fg("muted", LABELS[row.cat].padEnd(17))}`;
			const line = `${change}${where} ${category} ≈${fmtTokens(row.tokens * factor).padStart(6)}${first}  ${state}${row.label}: ${t.fg("dim", row.preview)}`;
			return i === this.item ? `${t.fg("accent", "▶")} ${line}` : `  ${line}`;
		});
		// With the first item selected, the tab shows from its top.
		return { lines, cursor: this.item === 0 ? 0 : above + this.item };
	}

	/** Explains the columns that the list of items shows before the content. */
	private legend(): string {
		return this.theme.fg("dim", "  # position in the prompt   @ first request that carried the item");
	}

	private current(): Body {
		const { current, usage, factor } = this.data;
		const top = [this.head("Composition"), ...this.composition(sumByCategory(current), usage?.tokens), ""];
		// The strip marks the selected item, which is known only after the list is built.
		const strip = (selected?: number) => [...this.strip(current, selected), this.head(this.ordered ? "Items in reading order" : "Items, largest first"), this.legend()];
		const order = current.map((_, i) => i);
		if (!this.ordered) order.sort((a, b) => current[b].tokens - current[a].tokens);
		const list = this.list(
			order.map((i) => current[i]),
			factor,
			top.length + strip().length,
			undefined,
			order,
		);
		return { lines: [...top, ...strip(this.positions[this.item]), ...list.lines], cursor: list.cursor };
	}

	private hintsTab(): Body {
		const { hints, dropped, factor, usage } = this.data;
		const t = this.theme;
		const droppable = hints.filter((hint) => hint.ids?.length);
		const nested = hints.filter((hint) => hint.kind === "nested");
		this.hintList = [
			...droppable.map((hint) => ({ ids: hint.ids ?? [], dropped: false })),
			...dropped.map((row) => ({ ids: row.id ? [row.id] : [], dropped: true })),
		];
		this.item = Math.min(this.item, Math.max(0, this.hintList.length - 1));
		const size = (tokens: number) => `≈${fmtTokens(tokens * factor).padStart(6)}`;
		const entry = (index: number, text: string) => (index === this.item ? `${t.fg("accent", "▶")} ${text}` : `  ${text}`);
		const total = hintTotal(hints) * factor;
		const lines = [
			this.head("Could be dropped from the context"),
			this.pairs([
				["Tokens", `≈${fmtTokens(total)}`],
				["Share of the context", usage?.tokens ? fmtPercent(total, usage.tokens) : "?"],
			]),
			...droppable.map((hint, i) => entry(i, `${size(hint.tokens)}  ${hint.label}  ${t.fg("dim", hint.detail)}`)),
		];
		if (droppable.length === 0) lines.push("  Nothing stands out: no repeated reads, no repeated skill loads, and no large tool results from earlier turns.");
		if (nested.length > 0) {
			lines.push(
				"",
				this.head("Read more than once inside scripts"),
				...nested.map((hint) => `  ${hint.tokens ? `up to ${size(hint.tokens)}` : "       size unknown"}  ${hint.label}`),
				t.fg("dim", "  The sizes are upper bounds and are not in the total: a script may return only part of what it reads."),
				t.fg("dim", "  These reads are part of the scripts' results and cannot be dropped alone."),
			);
		}
		if (dropped.length > 0) {
			lines.push("", this.head(`Dropped (${dropped.length})`));
			dropped.forEach((row, i) => lines.push(entry(droppable.length + i, `${size(row.tokens)}  ${row.label}: ${t.fg("dim", row.preview)}`)));
		}
		const selected = this.item < droppable.length ? 2 + this.item : lines.length - dropped.length + this.item - droppable.length;
		lines.push(
			"",
			...wrapped(
				"d drops the selected item: from the next request on, the model gets a one-line stub in its place. u restores a dropped item. The session file keeps the original.",
				this.width - 2,
			).map((line) => t.fg("dim", `  ${line}`)),
		);
		return { lines, cursor: this.item === 0 || this.hintList.length === 0 ? 0 : selected };
	}

	private turns(): Body {
		const t = this.theme;
		const inputs = [...this.data.analysis.inputs].reverse();
		if (inputs.length === 0) return { lines: ["No human inputs yet."] };
		this.item = Math.min(this.item, inputs.length - 1);
		const cells = (cells: (string | number)[]) =>
			[3, 8, 5, 5, 7, 7, 9, 7].map((width, i) => (i === 1 ? String(cells[i]).padEnd(width) : String(cells[i]).padStart(width))).join(" ");
		const top = [
			this.head("Human inputs, newest first, and the work each one caused"),
			t.fg("muted", `   ${cells(["#", "time", "reqs", "tools", "sent", "output", "cost", "took"])}  input`),
		];
		const lines = inputs.map((input, i) => {
			const line = `${cells([input.n, fmtTime(input.time), input.requests, input.toolCalls, fmtTokens(input.sent), fmtTokens(input.output), fmtCost(input.cost), fmtDuration(input.ms)])}  ${t.fg("dim", input.preview)}`;
			return i === this.item ? `${t.fg("accent", "▶")}  ${line}` : `   ${line}`;
		});
		return { lines: [...top, ...lines], cursor: this.item === 0 ? 0 : top.length + this.item };
	}

	private missText(miss: CacheMiss): string {
		return `≈${fmtTokens(miss.tokens)} tokens of the previous request were billed again (≈${fmtCost(miss.cost)} extra), ${fmtDuration(miss.idleMs)} after it`;
	}

	private trend(): Body {
		const t = this.theme;
		const { requests, inputs } = this.data.analysis;
		if (requests.length === 0) return { lines: ["No requests yet."] };
		const bars = trendBars(this.data.analysis, this.byTurn, this.delta);
		const selected = this.barAt(bars);
		const max = Math.max(...bars.map((bar) => Math.abs(bar.value)), 1);
		const what = this.byTurn ? "the last request of each human input" : "each request";
		// The whole session in one line, with a mark under the selected bar.
		const line = sparkline(bars.map((bar) => requests[bar.index].context), Math.max(1, this.width - 2));
		const lines = [
			this.head(this.delta ? `Change of the tokens sent, from one bar to the next: ${what}` : `Tokens sent by ${what} (provider-reported)`),
			`  ${t.fg("muted", line)}`,
			`  ${" ".repeat(Math.floor((selected * line.length) / bars.length))}${t.fg("accent", "▲")}`,
		];
		const above = lines.length;
		bars.forEach((entry, i) => {
			const on = i === selected;
			// The selected line has one color.
			const paint = (color: Parameters<Theme["fg"]>[0], text: string) => (on ? text : t.fg(color, text));
			const r = requests[entry.index];
			const input = this.byTurn ? inputs[entry.n - 1] : undefined;
			let size = `${bar(entry.value / max, 24)} ${fmtTokens(entry.value).padStart(6)}`;
			if (this.delta) {
				const cells = "█".repeat(Math.round((Math.abs(entry.value) / max) * HALF_BAR));
				const less = entry.value < 0 ? paint("success", cells.padStart(HALF_BAR)) : " ".repeat(HALF_BAR);
				const more = entry.value > 0 ? paint("warning", cells.padEnd(HALF_BAR)) : " ".repeat(HALF_BAR);
				size = `${less}${paint("dim", "│")}${more} ${`${entry.value < 0 ? "−" : "+"}${fmtTokens(Math.abs(entry.value))}`.padStart(7)}`;
			}
			const stop = r.stop === "stop" || r.stop === "toolUse" ? "" : `  ${paint("warning", r.stop)}`;
			const miss = r.miss ? `  ${paint("warning", `cache miss ≈${fmtTokens(r.miss.tokens)}`)}` : "";
			const figures = input
				? `reqs ${String(input.requests).padStart(3)}  out ${fmtTokens(input.output).padStart(6)}  ${fmtCost(input.cost)}  ${paint("dim", input.preview)}`
				: `out ${fmtTokens(r.output).padStart(6)}  cache ${fmtPercent(r.cacheRead, r.context).padStart(4)}  ${fmtCost(r.cost)}${miss}${stop}`;
			const row = `#${String(entry.n).padStart(3)} ${fmtTime(input?.time ?? r.time)} ${size}  ${figures}`;
			lines.push(on ? t.fg("accent", `▶ ${row}`) : `  ${row}`);
		});
		return { lines, cursor: selected === 0 ? 0 : above + selected };
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
		const factor = scaleOf(sumTokens(rows), request.context);
		const signed = (tokens: number) => `≈${tokens < 0 ? "−" : "+"}${fmtTokens(Math.abs(tokens) * factor)}`;
		top.push(this.head(`Composition${request.rows || request.sums ? "" : rebuilt}`), ...this.composition(sums, request.context), "");
		const previous = this.data.analysis.requests[this.request - 1];
		const diff = previous ? diffRows(previous.rows ?? this.rebuiltRows(previous), rows) : undefined;
		if (diff) {
			const count = (mark: string) => diff.marks.filter((m) => m === mark).length;
			top.push(
				this.head(`Since request #${previous.n}`),
				this.pairs([
					["+ added", count("+")],
					["~ changed", count("~")],
					["− removed", diff.removed.length],
				]),
				...this.wrap(
					CATEGORIES.filter((cat) => diff.delta[cat] !== 0 || diff.items[cat] !== 0).map((cat) => {
						const items = diff.items[cat];
						const count = items ? ` ${items < 0 ? "−" : "+"}${Math.abs(items)} ${Math.abs(items) === 1 ? "item" : "items"}` : "";
						return `${this.theme.fg("muted", LABELS[cat])}${count} ${signed(diff.delta[cat])}`;
					}),
				),
				"",
			);
		}
		const strip = (selected?: number) => [...this.strip(rows, selected), this.head(`Assembled from${request.rows ? "" : rebuilt}`), this.legend()];
		const above = top.length + strip().length;
		const list = this.list(rows, factor, above, diff?.marks);
		top.push(...strip(this.positions[this.item]));
		const removed = diff?.removed ?? [];
		const gone = removed.length
			? [
					"",
					this.head(`No longer in the request (${removed.length})`),
					...removed
						.slice(0, MAX_REMOVED)
						.map((row) => this.theme.fg("dim", `  − ${LABELS[row.cat].padEnd(17)} ≈${fmtTokens(row.tokens * factor).padStart(6)}  ${row.label}: ${row.preview}`)),
					...(removed.length > MAX_REMOVED ? [this.theme.fg("dim", `  … and ${removed.length - MAX_REMOVED} more`)] : []),
				]
			: [];
		return { lines: [...top, ...list.lines, ...gone], cursor: list.cursor };
	}

	private events(): string[] {
		const t = this.theme;
		const events = this.data.analysis.events;
		if (events.length === 0) return ["No compaction, drop, model or branch events on this branch."];
		const kinds = eventKinds(events);
		if (!kinds.some(([kind]) => kind === this.kind)) this.kind = "";
		const shown = events.filter((e) => !this.kind || e.kind === this.kind);
		const chip = (name: string, count: number, on: boolean) => (on ? t.bold(t.fg("accent", `[${name} ${count}]`)) : t.fg("muted", `${name} ${count}`));
		// A negative change frees context.
		const change = (delta: number | undefined, width = 0) =>
			delta === undefined ? " ".repeat(width) : t.fg(delta < 0 ? "success" : "warning", `≈${delta < 0 ? "−" : "+"}${fmtTokens(Math.abs(delta))}`.padStart(width));
		const sized = shown.filter((e) => e.delta !== undefined);
		const where = (e: { after: number }) => (e.after ? `after #${e.after}` : "at the start");
		const width = Math.max(...shown.map((e) => where(e).length));
		return [
			this.head("Events by kind"),
			...this.wrap([chip("all", events.length, !this.kind), ...kinds.map(([kind, count]) => chip(kind, count, kind === this.kind))]),
			this.pairs([["Net change of the context", sized.length ? change(sized.reduce((sum, e) => sum + (e.delta ?? 0), 0)) : "not known"]]),
			"",
			...shown.map((e) => `  ${fmtTime(e.time)}  ${t.fg("muted", where(e).padEnd(width))}  ${t.fg("accent", e.kind.padEnd(14))} ${change(e.delta, 8)}  ${e.detail}`),
		];
	}

	private files(): string[] {
		const files = this.data.analysis.files
			.filter((file) => this.matches(file.path))
			.sort((a, b) => b.reads + b.writes + b.edits - (a.reads + a.writes + a.edits));
		const unresolved = this.data.analysis.unresolvedEdits;
		const note = unresolved
			? [this.theme.fg("dim", `  ${unresolved} anchor-based edits are not listed: they were made before pi-context recorded their file.`)]
			: [];
		if (files.length === 0) return [this.filterText ? "No file matches the filter." : "No file activity yet.", ...note];
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
			...commands
				.filter((c) => this.matches(c.command))
				.reverse()
				.map((c) => `  ${mark(c.ok)} ${fmtTime(c.time)}  ${c.command.replace(/\s+/g, " ")}`),
		];
	}

	private tools(): string[] {
		const { analysis, declared, factor } = this.data;
		const { skills } = analysis;
		if (analysis.tools.length === 0) return ["No tool calls yet."];
		const tools = analysis.tools.filter((tool) => this.matches(tool.name));
		const flagged = tools.some((tool) => undeclared(tool, declared) > 0);
		const count = (n: number) => String(n).padStart(7);
		const size = (tokens: number) => (tokens ? `≈${fmtTokens(tokens * factor)}` : "–").padStart(9);
		const name = (tool: (typeof tools)[number]) => {
			const calls = undeclared(tool, declared);
			return calls ? this.theme.fg("warning", `${tool.name}  ! ${calls} not declared`) : tool.name;
		};
		const lines = [
			this.head(`${"calls".padStart(9)}${"nested".padStart(8)}${"errors".padStart(8)}${"call".padStart(10)}${"result".padStart(10)}  tool`),
			...tools
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
		for (const skill of skills.filter((skill) => this.matches(skill.name))) {
			lines.push(`  ${`×${skill.loads}`.padStart(5)} ${size(skill.tokens)}  ${skill.name}  ${this.theme.fg("dim", skill.path)}`);
		}
		return lines;
	}

	private agentLines(agent: AgentRec, selected: boolean): string[] {
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
			`${selected ? t.fg("accent", "▶") + indent.slice(1) : indent}${agent.parent ? "↳ " : ""}${mark} ${t.bold(agent.type)}  ${agent.description}  ${t.fg("dim", agent.id)}`,
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
		this.item = Math.min(this.item, Math.max(0, agents.length - 1));
		this.picks = [];
		agents.forEach((agent, i) => {
			this.picks.push({ line: lines.length, file: agent.sessionFile, title: `${agent.type}: ${agent.description}` });
			lines.push(...this.agentLines(agent, i === this.item));
		});
		return lines;
	}

	private insightsTab(): string[] {
		if (!this.summaries) return [this.progress];
		const t = this.theme;
		const days = PERIODS[this.period];
		this.insights ??= aggregate(this.summaries, Date.now(), days, {
			cwd: this.projectOnly ? this.host.cwd : undefined,
			sort: SORTS[this.sort][0],
			day: this.day,
		});
		const s = this.insights;
		const period = Number.isFinite(days) ? `Last ${days} days` : "All time";
		const [year, month, date] = (s.day ?? "").split("-").map(Number);
		const span = s.day ? `${s.day} (${WEEKDAYS[(new Date(year, month - 1, date).getDay() + 6) % 7]}) of ${period.toLowerCase()}` : period;
		const recorded = s.composition.requests;
		const top = (list: [string, number][]) => this.wrap(list.map(([name, n]) => `${name} ×${n}`));
		const max = Math.max(...s.week.map((day) => day.tokens), 1);
		const peak = Math.max(...s.heat.flat(), 1);
		const sessions = s.sessions.filter((session) => this.matches(`${session.cwd} ${session.name}`));
		this.item = Math.min(this.item, Math.max(0, sessions.length - 1));
		const lines = [
			this.head(`${span}, ${this.projectOnly ? `project ${basename(this.host.cwd)}` : "all projects"}`),
			this.pairs([
				["Sessions", s.sessions.length],
				["Requests", s.requests],
				["Tokens", fmtTokens(s.tokens)],
				["Cost", fmtCost(s.cost)],
				...(s.day ? [] : ([["Active days", s.activeDays]] as [string, number][])),
			]),
			"",
			this.head("Tokens by day"),
			...this.days(s),
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
			this.head(`Sent, by category (${recorded} of ${s.requests} requests recorded by pi-context)`),
			...(recorded ? this.shares(s.composition.sums) : ["  None."]),
			"",
			this.head("Models"),
			...(s.models.length === 0 ? ["  None."] : []),
			...s.models.map(
				([name, requests, tokens, cost]) =>
					`  ${String(requests).padStart(7)} req ${fmtTokens(tokens).padStart(7)}  ${fmtCost(cost).padStart(9)}  ${name}`,
			),
			"",
			this.head("Projects"),
			...(s.projects.length === 0 ? ["  None."] : []),
			...s.projects.map(
				([cwd, count, requests, tokens, cost]) =>
					`  ${String(count).padStart(4)} sessions ${String(requests).padStart(6)} req ${fmtTokens(tokens).padStart(7)}  ${fmtCost(cost).padStart(9)}  ${cwd}`,
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
		];
		if (sessions.length === 0) lines.push(this.filterText ? "  No session matches the filter." : "  None.");
		this.picks = sessions.map((session, i) => ({
			line: lines.length + i,
			file: session.file,
			title: session.name || `${basename(session.cwd)} ${fmtDay(session.end)}`,
		}));
		sessions.forEach((session, i) =>
			lines.push(
				`${i === this.item ? t.fg("accent", "▶") : " "} ${fmtDay(session.end).slice(5)} ${fmtTime(session.end).slice(0, 5)}  ${basename(session.cwd).slice(0, 24).padEnd(24)} ${String(session.requests).padStart(5)} req ${fmtTokens(session.tokens).padStart(7)}  ${fmtCost(session.cost).padStart(9)}  ${t.fg("dim", session.name)}`,
			),
		);
		return lines;
	}

	private settings(): string[] {
		const { config } = this.data;
		const t = this.theme;
		const affix = (text?: string) => (text ? `${text.length} characters: ${text.replace(/\s+/g, " ").slice(0, 60)}` : "disabled");
		const warn = config.warnPercent ?? DEFAULT_WARN_PERCENT;
		const items: { name: string; value: string; help: string; text?: string }[] = [
			{
				name: "Context warning",
				value: config.warnPercent === undefined ? `${warn}% (default)` : warn ? `${warn}%` : "disabled",
				help: "A notification appears when context use rises to this share of the window. Clearing restores the default.",
			},
			{
				name: "Auto-compact",
				value: config.compactPercent ? `${config.compactPercent}%` : "off",
				help: "When the agent stops and context use is at this share of the window or above, pi-context starts pi's compaction. Clearing turns it off.",
			},
			{
				name: "Cost budget",
				value: config.budget ? fmtCost(config.budget) : "none",
				help: "A warning appears once when the cost of the session reaches this amount, and the footer shows the cost. Clearing removes the budget.",
			},
			{
				name: "Cache expiry warning",
				value: config.expiryWarnSeconds ? `${config.expiryWarnSeconds}s before the expiry` : "off",
				help: "While the agent is idle, a warning appears this many seconds before the estimated expiry of the prompt cache. Clearing turns it off.",
			},
			{
				name: "Footer",
				value: `${footerItems(config).join(", ")}${config.footer ? "" : " (default)"}`,
				help: "What the footer shows, in order: context (context use), cost (session cost), cache (share of the sent tokens read from the prompt cache), ttl (estimated time until the prompt cache expires). Clearing restores the default.",
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