import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import {
	type AgentRec,
	type Attention,
	attentionLens,
	attentionOf,
	bands,
	baselineOf,
	briefOf,
	type CacheMiss,
	COMMAND_STATUSES,
	cacheStats,
	CATEGORIES,
	type Category,
	type CommandLens,
	type CommandRec,
	callOf,
	callView,
	commandRows,
	commandShape,
	commandStatus,
	type DeclaredTool,
	diffRows,
	eventKinds,
	FILE_KINDS,
	FILE_ORDERS,
	type FileKind,
	type FileOp,
	type FileOrder,
	type FileRec,
	familyTotals,
	fileRows,
	fileTotals,
	filesUpTo,
	imageText,
	injectors,
	introducedAt,
	isSlow,
	LABELS,
	MARK_KINDS,
	type MarkKind,
	places,
	programRanks,
	REPLY_KINDS,
	type ReplyKind,
	type RequestRec,
	type Row,
	replyCounts,
	scaleOf,
	schemaSources,
	slowest,
	sumByCategory,
	sumTokens,
	TOOL_ORDERS,
	textOf,
	tokensPerSecond,
	toolRows,
	toolsAt,
	trendBars,
	undeclared,
	type ViewData,
} from "./analyze.ts";
import { CHOICE_SETTINGS, CHOICES, choiceOf, DEFAULT_WARN_PERCENT } from "./config.ts";
import { agentDetail, type BoardItem, boardOf, chainOf, type FleetEvent, fleetSummary, narrow, readiness, TASK_STATES, type TaskState } from "./fleet.ts";
import { footerItems } from "./footer.ts";
import { bar, fmtCost, fmtDay, fmtDuration, fmtPercent, fmtTime, fmtTokens, sparkline } from "./format.ts";
import { hintTotal } from "./hints.ts";
import { aggregate, calendar, type DayStat, groupSessions, type Insights, type InsightsFilter, type SessionSort, type SessionSummary } from "./insights.ts";

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
	["context", "by context size"],
];
/** The top lists of the Insights tab, by the key that chooses an entry of the list. */
const USE_KEYS = { t: "tools", c: "programs", k: "skills" } as const;
/** What the Insights tab can shade the days by. */
const METRICS = ["tokens", "requests", "sessions", "cost"] as const;
/** The entries of the attention list of the Commands tab, in its order. */
const ATTENTION = ["slowest", "failing", "repeated"] as const;
/** The settings of the Settings tab, in its order. The view defaults come last. */
export const SETTINGS = ["warn", "compact", "budget", "expiry", "footer", "prefix", "suffix", ...CHOICE_SETTINGS] as const;
export type Setting = (typeof SETTINGS)[number];
/** Characters of an item that the inspector shows at most. */
const MAX_INSPECT_CHARS = 200_000;
const REFRESH_MS = 1000;
/** Tabs whose lists the user can filter. In the Fleet tab, only the timeline. */
const FILTERED: Tab[] = ["Current", "Browser", "Files", "Commands", "Tools", "Fleet", "Insights"];
/** Names of the kinds of reply that the Browser tab can list alone. */
const REPLY_NAMES: Record<ReplyKind, string> = { reasoning: "thinking", toolCalls: "tool calls", answers: "answers" };
const FILE_ORDER_NAMES: Record<FileOrder, string> = { ops: "most operations first", recent: "last used first", name: "by path", file: "by file name", lines: "most changed lines first" };
/** Names of the kinds of file operation in the Stats tab. */
const IO_NAMES: Record<FileKind, string> = { reads: "File reads", writes: "Writes", edits: "Edits", searches: "Searches", images: "Image reads" };
/** Marks of the Trend tab with their names in the legend: what happened since the bar before, and what sets the bar apart. */
const TREND_MARKS: Record<MarkKind, [mark: string, name: string]> = {
	compaction: ["✂", "compaction"],
	drop: ["▾", "drop"],
	restore: ["▴", "restore"],
	"task done": ["✓", "task done"],
	task: ["□", "task created"],
	question: ["?", "question"],
	longest: ["◷", "took longest"],
	growth: ["↑", "largest growth"],
	delegation: ["→", "delegation"],
	agent: ["←", "subagent message"],
	skill: ["◆", "skill loaded"],
	model: ["⇄", "model change"],
};
/** Views of the Fleet tab. */
const FLEET_VIEWS = ["Agents", "Timeline", "Tasks"] as const;
const TASK_STATE_NAMES: Record<TaskState, string> = { in_progress: "in progress", pending: "pending", done: "done" };
/** Position of the setting that the overlay last closed for. The overlay that opens on the Settings tab selects it again. */
let lastSetting = 0;
/** Removed items that the Browser tab lists at most. */
const MAX_REMOVED = 30;
/** The lines under the selected bar of the Trend tab. */
const BRIEF = [
	["User", "user"],
	["In", "added"],
	["Out", "reply"],
] as const;
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
	/** Id of the current session. */
	sessionId(): string;
	/** Context window of a model, when pi knows the model. */
	windowOf(model: string): number | undefined;
	configPath: string;
	/** Tab to open on. */
	tab?: Tab;
}

/** A setting the user asked to change. The overlay closes for the change. */
export interface SettingRequest {
	setting: Setting;
	clear: boolean;
}

/** An entry of the list in the Tools, Fleet or Insights tab. */
interface Entry {
	/** Body line of the entry. */
	line: number;
	/** The session that the entry opens. */
	file?: string;
	title: string;
	/** Id of the agent that the entry is about. */
	agent?: string;
	/** What the inspector shows for the entry. */
	text?: string;
}

interface Body {
	lines: string[];
	/** Line that must stay visible. */
	cursor?: number;
	/** Lines after the cursor that must stay visible with it. */
	span?: number;
}

/** How long before the present the time was, in the largest unit that fits: "3d ago". Empty when the time is not known. */
export function ago(time: number, now = Date.now()): string {
	if (!time) return "";
	const minutes = Math.max(0, Math.floor((now - time) / 60_000));
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m ago`;
	if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
	return `${Math.floor(minutes / 1440)}d ago`;
}

/** A duration. One under ten seconds shows tenths of a second. */
const fmtShort = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : fmtDuration(ms));

/** How a command ended and how much it printed, as far as the session tells. */
const commandBadges = (command: CommandRec): string[] => [
	...(command.exit === undefined ? [] : [`exit ${command.exit}`]),
	...(command.stopped ? [command.stopped === "timeout" ? "timed out" : "aborted"] : []),
	...(command.timeout === undefined ? [] : [`timeout ${command.timeout}s`]),
	...(command.truncated ? ["output truncated"] : []),
	...(command.lines === undefined ? [] : [`${command.lines} ${command.lines === 1 ? "line" : "lines"}`]),
	...(command.chars ? [`${fmtTokens(command.chars)} characters`] : []),
];

/** Whether two lenses list the same commands in the same order. */
const sameLens = (a: CommandLens, b?: CommandLens) => JSON.stringify(a) === JSON.stringify(b);

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
	/** The place of every request of `data`. */
	private places: ReturnType<typeof places> = [];
	private tab: number;
	private scroll = 0;
	private request: number;
	/** Selected entry of the list that the tab shows. */
	private item = 0;
	/** The entries of the list in the Tools, Fleet or Insights tab, as of the last render. */
	private picks: Entry[] = [];
	/** The selection of such a list moved: the Fleet tab must bring the detail of the selected agent into view. */
	private moved = false;
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
	/** Whether the Browser tab, opened from Trend, must select the first item added since the request before. */
	private toAdded = false;
	/** The file whose operations the Files tab lists, and the entry to select on the way back. */
	private opened?: { path: string; back: number };
	/** The files or operations that the Files tab lists. */
	private fileList: FileRec[] = [];
	private ops: FileOp[] = [];
	/** The commands that the Commands tab lists. */
	private commandList: CommandRec[] = [];
	/** Tool call whose result the list of items selects when it is next shown. */
	private toResult?: string;
	/** Position in TOOL_ORDERS of the order of the Tools tab. */
	private toolOrder = 0;
	/** Position in FILE_ORDERS of the order of the Files tab, and the kind of operation that its files must have. Empty: every file. */
	private fileOrder = 0;
	private fileKind: FileKind | "" = "";
	/** Which commands the Commands tab lists, and in which order. */
	private lens: CommandLens = {};
	/** The Files tab lists the files as they were after the selected request. */
	private asOf = false;
	/** The kind of reply that the Browser tab lists, or "tools": the tools that the request declared. Empty: every item. */
	private reply: ReplyKind | "tools" | "" = "";
	/** The Browser tab compares a request with the last request before its human input, not with the request before it. */
	private byInput = false;
	/** Position in FLEET_VIEWS of the view of the Fleet tab. */
	private fleetView = 0;
	/** The timeline of the Fleet tab lists the latest event first. */
	private latestFirst = false;
	/** The state of the tasks that the Fleet tab lists. Empty: every state. */
	private taskState: TaskState | "" = "";
	/** The Agents view of the Fleet tab lists only the subagents that run. */
	private runningOnly = false;
	/** Id of the agent that the timeline and the tasks of the Fleet tab are narrowed to. */
	private only?: string;
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
	/** Position in METRICS of what the Insights tab shades the days by. */
	private metric = 0;
	/** The tool, program or skill that the sessions of the Insights tab must have used. */
	private uses?: InsightsFilter["uses"];
	/** The Insights tab groups the sessions by project. */
	private grouped = false;
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
		this.places = places(this.data.analysis);
		this.tab = Math.max(0, TABS.indexOf(host.tab ?? "Stats"));
		this.request = this.data.analysis.requests.length - 1;
		// The views start with the defaults of the settings.
		const { config } = this.data;
		this.period = Math.max(0, PERIODS.indexOf(Number(choiceOf(config, "period")) || Number.POSITIVE_INFINITY));
		this.byTurn = choiceOf(config, "trend") === "input";
		this.delta = choiceOf(config, "mode") === "change";
		this.toolOrder = TOOL_ORDERS.indexOf(choiceOf(config, "tools"));
		this.fileOrder = FILE_ORDERS.indexOf(choiceOf(config, "files"));
		this.byInput = choiceOf(config, "diff") === "input";
		if (host.tab === "Settings") this.item = lastSetting;
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
		} else if (escape && this.opened) {
			this.item = this.opened.back;
			this.opened = undefined;
		} else if (escape && this.filterText) this.filterText = "";
		else if (escape && this.only && this.name === "Fleet") this.only = undefined;
		else if (escape && this.back) this.leaveSession();
		else if (escape || key === "q") {
			this.close();
			return;
		} else if (step) this.move(step);
		else if (matchesKey(key, "right") || matchesKey(key, "tab")) this.setTab((this.tab + 1) % TABS.length);
		else if (matchesKey(key, "left") || matchesKey(key, "shift+tab")) this.setTab((this.tab + TABS.length - 1) % TABS.length);
		else if (matchesKey(key, "enter")) {
			if (this.name === "Trend") {
				// The bar of a human input stands for its last request.
				const bars = trendBars(this.data.analysis, this.byTurn, false);
				this.selectRequest(bars[this.barAt(bars)]?.index ?? this.request);
				this.setTab(TABS.indexOf("Browser"));
				this.toAdded = true;
			}
			else if (this.name === "Turns") this.openTurn();
			else if (this.name === "Files") this.openFile();
			else if (this.name === "Commands") this.openCommand();
			else if (this.name === "Current" || this.name === "Browser") this.openItem();
			else if (this.name === "Tools" || (this.name === "Fleet" && this.fleetView > 0)) this.openEntry();
			else if (this.name === "Insights" || this.name === "Fleet") this.openSession();
			else if (this.name === "Settings") {
				this.close({ setting: SETTINGS[this.item], clear: false });
				return;
			}
		} else if (key === "x" && this.name === "Settings") {
			this.close({ setting: SETTINGS[this.item], clear: true });
			return;
		} else if (key === "/" && FILTERED.includes(this.name) && !this.opened && (this.name !== "Fleet" || this.fleetView === 1)) this.typing = true;
		else if ((key === "d" || key === "u") && (this.name === "Current" || this.name === "Hints")) this.drop(key === "d");
		else if (key === "k" && this.name === "Events") {
			const kinds = ["", ...eventKinds(this.data.analysis.events).map(([kind]) => kind)];
			this.kind = kinds[(kinds.indexOf(this.kind) + 1) % kinds.length];
			this.scroll = 0;
		} else if (key === "g" && this.name === "Trend") this.byTurn = !this.byTurn;
		else if (key === "m" && this.name === "Trend") this.delta = !this.delta;
		else if (key === "s" && this.name === "Tools") this.toolOrder = (this.toolOrder + 1) % TOOL_ORDERS.length;
		else if (key === "k" && this.name === "Files" && !this.opened) this.fileKind = this.next(FILE_KINDS, this.fileKind);
		else if (key === "s" && this.name === "Files" && !this.opened) this.fileOrder = (this.fileOrder + 1) % FILE_ORDERS.length;
		else if (key === "a" && this.name === "Files") {
			if (this.data.analysis.requests[this.request]) this.asOf = !this.asOf;
			else this.notice = "No request is selected.";
			this.item = 0;
		}
		else if (key === "k" && this.name === "Commands") this.lens = { ...this.lens, status: this.next(COMMAND_STATUSES, this.lens.status ?? "") || undefined };
		else if (key === "l" && this.name === "Commands") this.setLens({ ...this.lens, slow: !this.lens.slow || undefined });
		else if (key === "o" && this.name === "Commands") this.setLens({ ...this.lens, slowest: !this.lens.slowest || undefined });
		else if (key === "a" && this.name === "Commands") this.toAttention();
		else if (key === "b" && this.name === "Commands") {
			const command = this.commandList[this.item];
			if (command?.id) this.openResult(command.request, command.id);
			else if (command) this.notice = "The user ran this command: it has no tool result.";
		}
		else if ((key === "f" || key === "s") && this.name === "Commands") this.toCommand(key === "f");
		else if (key === "k" && this.name === "Browser") this.reply = this.next(toolsAt(this.data.analysis, this.request).length ? [...REPLY_KINDS, "tools" as const] : REPLY_KINDS, this.reply);
		else if (key === "b" && this.name === "Browser") this.byInput = !this.byInput;
		else if (key === "v" && this.name === "Fleet") {
			this.fleetView = (this.fleetView + 1) % FLEET_VIEWS.length;
			this.filterText = "";
			this.item = 0;
			this.scroll = 0;
		} else if (key === "o" && this.name === "Fleet" && this.fleetView === 1) this.latestFirst = !this.latestFirst;
		else if (key === "k" && this.name === "Fleet" && this.fleetView === 2) this.taskState = this.next(TASK_STATES, this.taskState);
		else if (key === "k" && this.name === "Fleet" && this.fleetView === 0) {
			this.runningOnly = !this.runningOnly;
			this.item = 0;
		}
		else if (key === "n" && this.name === "Fleet") this.toAgent();
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
		const { lines, cursor, span: below = 0 } = this.body();
		if (cursor !== undefined) {
			if (cursor + below >= this.scroll + height) this.scroll = cursor + below - height + 1;
			if (cursor < this.scroll) this.scroll = cursor;
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
			Browser: "↑/↓ select  enter inspect  [ ] request  / filter  k kind  b baseline",
			Events: "↑/↓ scroll  k kind",
			Files: `${this.opened ? "↑/↓ select  enter result  esc files" : "↑/↓ select  enter operations  / filter  k kind  s order"}  a ${this.asOf ? "all requests  [ ] request" : "as of request"}`,
			Commands: `↑/↓ select  enter detail  b result  / filter  k status  l ${this.lens.slow ? "all" : "slow only"}  o ${this.lens.slowest ? "newest" : "slowest"} first  a attention  f next failed  s slowest`,
			Tools: "↑/↓ select  enter description  / filter  s sort",
			Fleet: [
				`↑/↓ select  enter open  k ${this.runningOnly ? "every agent" : "running only"}  v timeline`,
				`↑/↓ select  enter inspect  o ${this.latestFirst ? "earliest" : "latest"} first  / filter  v tasks`,
				"↑/↓ select  enter inspect  k state  v agents",
			][this.fleetView] + `  n ${this.only ? "every agent" : "only this agent"}`,
			Insights: "↑/↓ select  enter open  p period  [ ] day  m metric  a project  s sort  g group  t/c/k tool/program/skill  x all  / filter",
			Settings: "↑/↓ select  enter edit or next value  x clear",
		};
		const filter = this.filterText ? `filter "${this.filterText}" (esc clears)  ` : "";
		return `${filter}←/→ tab  ${keys[this.name] ?? "↑/↓ scroll"}  r refresh  ${this.back ? "esc back  " : ""}q close`;
	}

	private close(request?: SettingRequest): void {
		if (request) lastSetting = this.item;
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
		this.places = places(this.data.analysis);
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
		this.moved = false;
		this.opened = undefined;
		this.filterText = "";
		// A tab that selects an item of the Browser tab must find it in the list.
		this.reply = "";
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
		else if (key === "g") this.grouped = !this.grouped;
		else if (key === "x") this.uses = undefined;
		else if (key === "m") {
			// The figures stay the same.
			this.metric = (this.metric + 1) % METRICS.length;
			return;
		} else if (key === "t" || key === "c" || key === "k") {
			// The entry after the chosen one of the list. After the last entry, none is chosen.
			const kind = USE_KEYS[key];
			// The lists are those of the last render.
			if (!this.insights) return;
			const names = this.insights[kind].map(([name]) => name);
			const name = names[this.uses?.kind === kind ? names.indexOf(this.uses.name) + 1 : 0];
			this.uses = name === undefined ? undefined : { kind, name };
			if (names.length === 0) this.notice = `The list of top ${kind} is empty.`;
		} else return;
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

	/** The days of the period as a calendar: one column per week, shaded by the chosen figure of the day. */
	private days(s: Insights): string[] {
		const t = this.theme;
		const rows = calendar(s.daily);
		// Show the most recent weeks that fit.
		const weeks = Math.min(rows[0].length, Math.max(1, Math.floor((this.width - 6) / 2)));
		const shown = rows.map((row) => row.slice(-weeks));
		const metric = METRICS[this.metric];
		const peak = Math.max(...s.daily.map((stat) => stat[metric]), 0) || 1;
		// Name a month above the first week that starts in it.
		const months = new Array<string>(weeks * 2).fill(" ");
		let last = "";
		for (let week = 0; week < weeks; week++) {
			const month = shown.map((row) => row[week]).find((stat) => stat)?.day.slice(5, 7) ?? last;
			if (month !== last && week * 2 + 3 <= months.length) months.splice(week * 2, 3, ...MONTHS[Number(month) - 1]);
			last = month;
		}
		const cell = (stat?: DayStat) =>
			!stat
				? "  "
				: stat.day === s.day
					? t.bold(t.fg("warning", "[]"))
					: stat[metric]
						? t.fg("accent", SHADES[Math.min(3, Math.floor((stat[metric] / peak) * 4))].repeat(2))
						: t.fg("dim", "· ");
		const chosen = s.daily.find((stat) => stat.day === s.day);
		const hidden = rows[0].length - weeks;
		return [
			t.fg("muted", `      ${months.join("")}`.trimEnd()),
			...shown.map((row, i) => `  ${WEEKDAYS[i]} ${row.map(cell).join("")}`),
			t.fg(
				"dim",
				chosen
					? `  [] ${chosen.day}: ${chosen.sessions} sessions, ${chosen.requests} requests, ${fmtTokens(chosen.tokens)} tokens, ${fmtCost(chosen.cost)}. [ ] change the day; ] on today shows the whole period.`
					: `  Shaded by the ${metric} of the day; m changes that. [ selects today, then [ ] change the day.${hidden > 0 ? ` ${hidden} earlier weeks do not fit.` : ""}`,
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

	/** The value of a filter after `value`. After the last value, the filter is empty again. The selection returns to the first entry. */
	private next<T extends string>(values: readonly T[], value: T | ""): T | "" {
		const all: (T | "")[] = ["", ...values];
		this.item = 0;
		this.scroll = 0;
		return all[(all.indexOf(value) + 1) % all.length];
	}

	/** Sets what the Commands tab lists. The selection returns to the first entry. */
	private setLens(lens: CommandLens): void {
		this.lens = lens;
		this.item = 0;
		this.scroll = 0;
	}

	/** Lists the commands of the next entry of the attention list. After the last entry, the tab lists every command again. */
	private toAttention(): void {
		const attention = attentionOf(this.data.analysis.commands);
		const lenses = ATTENTION.flatMap((entry) => attentionLens(attention, entry) ?? []);
		if (lenses.length === 0) {
			this.notice = "The attention list is empty.";
			return;
		}
		this.setLens(lenses[lenses.findIndex((lens) => sameLens(this.lens, lens)) + 1] ?? {});
	}

	/** Narrows the timeline and the tasks of the Fleet tab to the agent of the selected entry, or shows every agent again. */
	private toAgent(): void {
		const agent = this.only ? undefined : this.picks[this.item]?.agent;
		if (!this.only && !agent) {
			this.notice = "The selected entry names no agent.";
			return;
		}
		this.only = agent;
		// The Agents view lists every agent in both cases.
		if (this.fleetView > 0) this.item = 0;
	}

	/** Selects the next failed command of the list, or the slowest one. */
	private toCommand(failed: boolean): void {
		const list = this.commandList;
		const after = this.item + 1;
		const at = failed ? list.findIndex((_, i) => list[(after + i) % list.length].ok === false) : slowest(list);
		if (at < 0) this.notice = failed ? "No command of the list failed." : "No command of the list has a recorded time.";
		else this.item = failed ? (after + at) % list.length : at;
	}

	private move(delta: number): void {
		const listed: Tab[] = ["Current", "Hints", "Turns", "Browser", "Files", "Commands", "Settings"];
		if (this.name === "Trend") {
			const bars = trendBars(this.data.analysis, this.byTurn, false);
			const next = Math.max(0, Math.min(bars.length - 1, this.barAt(bars) + delta));
			this.selectRequest(bars[next]?.index ?? 0);
		}
		else if (listed.includes(this.name)) this.item = Math.max(0, this.item + delta);
		else if (this.name === "Tools" || this.name === "Fleet" || this.name === "Insights") this.pick(delta);
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
		this.moved = true;
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

	/** Opens the operations of the selected file, or the result of the selected operation. */
	private openFile(): void {
		if (this.opened) {
			const op = this.ops[this.item];
			if (op) this.openResult(op.request, op.id);
			return;
		}
		const file = this.fileList[this.item];
		if (!file) return;
		this.opened = { path: file.path, back: this.item };
		this.item = 0;
	}

	/**
	 * Selects the result of a tool call in the context of the request after the one that made the call,
	 * or in the current context when no request followed.
	 */
	private openResult(request: number, id: string): void {
		const inRequest = request < this.data.analysis.requests.length;
		if (inRequest) this.selectRequest(request);
		this.setTab(TABS.indexOf(inRequest ? "Browser" : "Current"));
		this.toResult = id;
	}

	/** A request by its number, with its human input and its step in it when they are known: "#12 3.2". */
	private coordinate(n: number): string {
		const place = this.places[n - 1];
		return `#${n}${place ? ` ${place.input}.${place.step}` : ""}`;
	}

	/** A line of the Stats tab: the file operations of the session by kind, and the loads of skills. No line when there are none. */
	private inOut(): string[] {
		const { files, skills } = this.data.analysis;
		const totals = fileTotals(files);
		const pairs: [string, number][] = [...FILE_KINDS.map((kind): [string, number] => [IO_NAMES[kind], totals[kind]]), ["Skill loads", skills.reduce((sum, skill) => sum + skill.loads, 0)]];
		const some = pairs.filter(([, count]) => count > 0);
		return some.length ? [this.pairs(some)] : [];
	}

	/** Shows the selected command of the Commands tab in the inspector: how it ended, and its output when the session holds it. */
	private openCommand(): void {
		const command = this.commandList[this.item];
		if (!command) return;
		const badges = commandBadges(command);
		const output = command.id ? this.data.resultText?.(command.id) : undefined;
		this.inspect = {
			title: `Command · ${command.id ? `request ${this.coordinate(command.request)}` : "run by the user"} · ${fmtTime(command.time)}${command.ms === undefined ? "" : ` · took ${fmtShort(command.ms)}`}`,
			text: [command.command, ...(badges.length ? ["", badges.join(" · ")] : []), ...(output ? ["", "Output:", output] : [])].join("\n"),
			back: this.scroll,
		};
		this.scroll = 0;
	}

	/** The selected entry of the Tools, Fleet or Insights tab. An entry that the user cannot see comes into view instead. */
	private picked(): Entry | undefined {
		const pick = this.picks[this.item];
		if (!pick) return undefined;
		const height = this.bodyHeight();
		if (pick.line < this.scroll || pick.line >= this.scroll + height) {
			// Do not open an entry that the user cannot see.
			this.scroll = Math.max(0, pick.line - Math.floor(height / 2));
			this.notice = "The selected entry is now in view. Press enter again to open it.";
			return undefined;
		}
		return pick;
	}

	/** Shows the content of the selected tool of the Tools tab, or of the selected event or task of the Fleet tab, in the inspector. */
	private openEntry(): void {
		const pick = this.picked();
		if (!pick) return;
		if (!pick.text) {
			this.notice = "This entry has no content.";
			return;
		}
		this.inspect = { title: pick.title, text: pick.text, back: this.scroll };
		this.scroll = 0;
	}

	/** Shows the session of the selected entry of the Insights or Fleet tab. */
	private openSession(): void {
		const pick = this.picked();
		if (!pick) return;
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
		this.places = places(data.analysis);
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

	/** Opens the selected item of the Current or Browser tab in the inspector. A tool result comes with its call. */
	private openItem(): void {
		const row = this.rows[this.item];
		if (!row) return;
		let text = row.text;
		let rows = this.data.current;
		const request = this.data.analysis.requests[this.request];
		if (this.name === "Browser" && request && (text === undefined || row.id)) {
			// A snapshot keeps no content. Find the item, and the call of a tool result, in the context rebuilt from the session.
			rows = this.rebuiltRows(request);
			text ??= textOf(row, this.positions[this.item], rows);
		}
		// The tool schemas of a request: the tools that the request declared, not those that are declared now.
		const declared = this.name === "Browser" && row.cat === "tools" && this.reply !== "tools" ? toolsAt(this.data.analysis, this.request) : [];
		// Sizes on the scale of the list.
		const factor = declared.length ? scaleOf(sumTokens(request.rows ?? this.rebuiltRows(request)), request.context) : 1;
		if (declared.length) text = declared.map((tool) => `≈${fmtTokens(tool.tokens * factor).padStart(6)}  ${tool.name}${tool.source ? `  ${tool.source}` : ""}  called ${tool.calls}×`).join("\n");
		const call = row.id && text !== undefined ? callView(row, text, callOf(row, rows)?.text) : undefined;
		const head = call
			? `Tool: ${call.tool}\nStatus: ${call.status}\nLines: ${call.lines}\n\n${call.args === undefined ? "" : `Arguments:\n${call.args}\n\n`}Result:\n`
			: "";
		// A terminal shows no image: one line tells what the session holds of each.
		const images = (row.images ?? []).map((image, i) => `Image ${i + 1}: ${imageText(image)}\n`).join("");
		this.inspect = {
			title: `${LABELS[row.cat]} · ${row.label}${text === undefined ? "" : ` · ${fmtTokens(text.length)} characters`}`,
			text: (images && `${images}\n`) + head + (text ?? `${row.preview}\n\n(Only this preview is available. The item was not found in the saved session.)`),
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

	/** A value of a filter with the number of entries that it keeps. The active value is marked. */
	private chip(name: string, count: number, on: boolean): string {
		const t = this.theme;
		return on ? t.bold(t.fg("accent", `[${name} ${count}]`)) : t.fg("muted", `${name} ${count}`);
	}

	/** The shares of the categories as a bar of `width` cells, each in the color of its category. A list holds the sizes in the order of CATEGORIES. */
	private mix(sums: Record<Category, number> | number[] | undefined, width: number): string {
		const cells = bands(
			CATEGORIES.map((cat, i) => ({ cat, tokens: (Array.isArray(sums) ? sums[i] : sums?.[cat]) ?? 0, label: "", preview: "" })),
			width,
		);
		return cells.length ? cells.map((cat) => this.theme.fg(COLORS[cat], "█")).join("") : this.theme.fg("dim", "·".repeat(width));
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
				return this.files();
			case "Commands":
				return this.commands();
			case "Tools":
				return { lines: this.tools() };
			case "Fleet":
				return this.fleet();
			case "Insights":
				return { lines: this.insightsTab() };
			case "Settings":
				return this.settings();
		}
	}

	private stats(): string[] {
		const { analysis, usage, model, agents, rates } = this.data;
		const timing = analysis.timing;
		const totals = analysis.totals;
		const pair = (key: string, value: string) => `${this.theme.fg("muted", key)} ${value}`;
		const family = familyTotals(totals, agents);
		const sized = (sum: { tokens: number; cost: number }) => `${fmtTokens(sum.tokens)} tokens, ${fmtCost(sum.cost)}`;
		const speed = tokensPerSecond(timing);
		const spanMs = REPLY_KINDS.reduce((sum, kind) => sum + timing.spans[kind][0], 0);
		const stream = timing.streamed
			? this.wrap([
					pair("First token", `after ${fmtShort(timing.ttftMs / timing.streamed)} on average (${timing.streamed} requests timed)`),
					...(speed === undefined ? [] : [pair("Output", `${speed < 10 ? speed.toFixed(1) : Math.round(speed)} tokens per second`)]),
					...REPLY_KINDS.filter((kind) => timing.spans[kind][0] > 0).map((kind) =>
						pair(`Stream, ${REPLY_NAMES[kind]}`, `${fmtDuration(timing.spans[kind][0])} (${fmtPercent(timing.spans[kind][0], spanMs)})`),
					),
				])
			: [];
		const cell = (value: string | number, width: number) => String(value).padStart(width);
		const models = [...analysis.models].sort((a, b) => b.cost - a.cost || b.sent - a.sent);
		const price = (rate: number) => `$${+rate.toFixed(4)}`;
		const priced = models.flatMap((m) => {
			const rate = rates?.[m.model];
			return rate
				? [`  ${cell(price(rate.input), 8)} ${cell(price(rate.output), 8)} ${cell(price(rate.cacheRead), 10)} ${cell(price(rate.cacheWrite), 11)}  ${m.model}`]
				: [];
		});
		const cache = cacheStats(analysis);
		const overhead = Math.max(0, timing.activeMs - timing.modelMs - timing.toolMs);
		const share = (ms: number) => `${fmtDuration(ms)} (${fmtPercent(ms, timing.activeMs)})`;
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
			...this.inOut(),
			...(agents.length
				? this.wrap([
						pair(`With ${agents.length} ${agents.length === 1 ? "subagent" : "subagents"}`, sized(family)),
						pair("Session alone", sized(family.own)),
						pair("Subagents", sized(family.agents)),
					])
				: []),
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
			...models.map(
				(m) => `  ${cell(m.requests, 8)} ${cell(fmtTokens(m.sent), 8)} ${cell(fmtTokens(m.output), 8)} ${cell(fmtCost(m.cost), 10)}  ${m.model}`,
			),
			...(priced.length
				? [
						this.theme.fg("muted", `  ${cell("input", 8)} ${cell("output", 8)} ${cell("cache read", 10)} ${cell("cache write", 11)}  model, price per million tokens`),
						...priced,
					]
				: []),
			"",
			this.head("Timing (turns recorded by pi-context)"),
			this.pairs([
				["Active", fmtDuration(timing.activeMs)],
				["Model calls", share(timing.modelMs)],
				["Tool runs", share(timing.toolMs)],
				["Overhead", share(overhead)],
			]),
			...stream,
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
	 * without it the rows are in reading order. With `kind`, the list holds only the rows of that category.
	 */
	private list(rows: Row[], factor: number, above: number, marks?: string[], positions?: number[], kind?: ReplyKind | ""): Body {
		const t = this.theme;
		const requests = this.data.analysis.requests;
		const shown = rows
			.map((row, i) => ({ row, mark: marks?.[i], position: positions?.[i] ?? i, from: introducedAt(row, requests) }))
			.filter(({ row }) => (!kind || row.cat === kind) && this.matches(`${LABELS[row.cat]} ${row.dropped ? "dropped " : ""}${row.label} ${row.preview}`));
		this.rows = shown.map(({ row }) => row);
		this.positions = shown.map(({ position }) => position);
		if (this.toResult) {
			const at = shown.findIndex(({ row }) => row.id === this.toResult);
			if (at >= 0) this.item = at;
			else this.notice = "The result is not in this context.";
			this.toResult = undefined;
		}
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

	/** Where pi starts compaction, the room before it, and the output limit of the model. Nothing when the window or the reserve is not known. */
	private reserve(): string[] {
		const { usage, reserve } = this.data;
		if (!reserve || !usage || usage.contextWindow <= 0) return [];
		const items: string[] = [];
		const item = (key: string, value: string) => items.push(`${this.theme.fg("muted", key)} ${value}`);
		if (reserve.compaction !== undefined) {
			const start = usage.contextWindow - reserve.compaction;
			item("Compaction starts at", `${fmtTokens(start)} (${fmtPercent(start, usage.contextWindow)} of the window)`);
			if (usage.tokens != null) item("Room before compaction", fmtTokens(Math.max(0, start - usage.tokens)));
		}
		if (reserve.output !== undefined) item("Output limit", fmtTokens(reserve.output));
		return items.length ? this.wrap(items) : [];
	}

	private current(): Body {
		const { current, usage, factor } = this.data;
		const top = [this.head("Composition"), ...this.composition(sumByCategory(current), usage?.tokens), ...this.reserve(), ""];
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
			...(inputs.some((input) => input.waitMs) ? [t.fg("dim", "  waited: the time that the input waited for the user's answers to questions. took does not include it.")] : []),
			t.fg("muted", `   ${cells(["#", "time", "reqs", "tools", "sent", "output", "cost", "took"])}  input`),
		];
		const lines = inputs.map((input, i) => {
			const waited = input.waitMs ? `${t.fg("muted", `waited ${fmtDuration(input.waitMs)}`)}  ` : "";
			const line = `${cells([input.n, fmtTime(input.time), input.requests, input.toolCalls, fmtTokens(input.sent), fmtTokens(input.output), fmtCost(input.cost), fmtDuration(input.ms)])}  ${waited}${t.fg("dim", input.preview)}`;
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
		// Only the kinds of marks that occur take room, in the legend and in the rows.
		const present = MARK_KINDS.filter((kind) => bars.some((bar) => bar.marks?.includes(kind)));
		const wide = Math.max(0, ...bars.map((bar) => bar.marks?.length ?? 0));
		// The human input of each request and its step in it, when they are known.
		const spots = bars.map((bar) => {
			const place = this.byTurn ? undefined : this.places[bar.index];
			return place ? ` ${place.input}.${place.step}` : "";
		});
		const spot = Math.max(0, ...spots.map((each) => each.length));
		const lines = [
			this.head(this.delta ? `Change of the tokens sent, from one bar to the next: ${what}` : `Tokens sent by ${what} (provider-reported)`),
			`  ${t.fg("muted", line)}`,
			`  ${" ".repeat(Math.floor((selected * line.length) / bars.length))}${t.fg("accent", "▲")}`,
			...this.wrap([
				"took: the recorded duration.",
				...(spot ? ["3.2 after the number: human input 3, step 2."] : []),
				...(present.length ? ["Marks, since the bar before:"] : []),
				...present.map((kind) => TREND_MARKS[kind].join(" ")),
			]).map((legend) => t.fg("dim", legend)),
		];
		const above = lines.length;
		/** Lines under the selected bar. */
		let below = 0;
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
			const took = entry.ms === undefined ? " ".repeat(11) : `took ${fmtDuration(entry.ms).padStart(6)}`;
			const marks = paint(
				"warning",
				MARK_KINDS.filter((kind) => entry.marks?.includes(kind))
					.map((kind) => TREND_MARKS[kind][0])
					.join("")
					.padEnd(wide),
			);
			const row = `#${String(entry.n).padStart(3)}${spots[i].padEnd(spot)} ${fmtTime(input?.time ?? r.time)} ${size} ${marks} ${took}  ${figures}`;
			lines.push(on ? t.fg("accent", `▶ ${row}`) : `  ${row}`);
			if (!on) return;
			const from = lines.length;
			const brief = briefOf(this.data.analysis, entry.index, this.byTurn);
			if (brief) lines.push(...BRIEF.map(([name, key]) => `      ${t.fg("muted", name.padEnd(6))}${brief[key]}`));
			const where = this.byTurn ? [] : this.placePairs(entry.index);
			if (where.length) lines.push(`    ${this.pairs(where)}`);
			lines.push(
				`      ${t.fg("muted", "Usage ")}input ${fmtTokens(r.input)}  cache read ${fmtTokens(r.cacheRead)}  cache write ${fmtTokens(r.cacheWrite)}  output ${fmtTokens(r.output)}  ${t.fg("dim", "(provider-reported)")}`,
			);
			const parts = entry.parts;
			if (parts) {
				const sizes = CATEGORIES.filter((cat) => Math.round(parts[cat]) !== 0).map(
					(cat) => `${LABELS[cat]} ${parts[cat] < 0 ? "−" : this.delta ? "+" : ""}${fmtTokens(Math.abs(parts[cat]))}`,
				);
				lines.push(`      ${t.fg("muted", "Est.  ")}${sizes.join("  ") || "no change"}  ${t.fg("dim", "(by category)")}`);
			}
			below = lines.length - from;
		});
		return { lines, cursor: selected === 0 ? 0 : above + selected, span: below };
	}

	/** The human input a request belongs to with its place in it, and its time to the first token, as far as they are known. */
	private placePairs(index: number): [string, string][] {
		const place = this.places[index];
		const ttft = this.data.analysis.requests[index]?.ttft;
		return [
			...(place ? [["Place", `input ${place.input}, step ${place.step} of ${place.steps}`] as [string, string]] : []),
			...(ttft === undefined ? [] : [["First token", `after ${fmtShort(ttft)}`] as [string, string]]),
		];
	}

	private browser(): Body {
		const request = this.data.analysis.requests[this.request];
		if (!request) return { lines: ["No requests yet."] };
		const top = [
			this.head(`Request ${this.coordinate(request.n)} of ${this.data.analysis.requests.length}`),
			this.pairs([
				["Time", fmtTime(request.time)],
				["Model", request.model],
				["Sent", fmtTokens(request.context)],
				["From cache", fmtPercent(request.cacheRead, request.context)],
				["Output", fmtTokens(request.output)],
				["Took", request.ms == null ? "?" : fmtDuration(request.ms)],
			]),
		];
		const where = this.placePairs(this.request);
		if (where.length) top.push(this.pairs(where));
		if (request.miss) top.push(this.theme.fg("warning", `  Cache miss: ${this.missText(request.miss)}.`));
		const rows = request.rows ?? this.rebuiltRows(request);
		if (rows.length === 0 && !request.sums) {
			return { lines: [...top, "", "The context of this request cannot be rebuilt from the session."] };
		}
		const replies = replyCounts(rows);
		const declared = toolsAt(this.data.analysis, this.request);
		if (declared.length === 0 && this.reply === "tools") this.reply = "";
		top.push(
			...this.wrap([
				this.chip("all items", rows.length, !this.reply),
				...REPLY_KINDS.map((kind) => this.chip(REPLY_NAMES[kind], replies[kind], kind === this.reply)),
				...(declared.length ? [this.chip("tool schemas", declared.length, this.reply === "tools")] : []),
			]),
			"",
		);
		const sums = request.rows ? sumByCategory(rows) : (request.sums ?? sumByCategory(rows));
		const rebuilt = " (rebuilt from the session)";
		const factor = scaleOf(sumTokens(rows), request.context);
		const signed = (tokens: number) => `≈${tokens < 0 ? "−" : "+"}${fmtTokens(Math.abs(tokens) * factor)}`;
		top.push(this.head(`Composition${request.rows || request.sums ? "" : rebuilt}`), ...this.composition(sums, request.context), "");
		const previous = this.data.analysis.requests[baselineOf(this.data.analysis, this.request, this.byInput ? "input" : "request")];
		const diff = previous ? diffRows(previous.rows ?? this.rebuiltRows(previous), rows) : undefined;
		if (!diff && this.byInput) top.push(this.theme.fg("dim", "  No request came before the human input of this request: there is nothing to compare with."), "");
		if (diff) {
			const count = (mark: string) => diff.marks.filter((m) => m === mark).length;
			top.push(
				this.head(`Since request #${previous.n}, ${this.byInput ? "the last request before the human input" : "the request before"}`),
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
		const strip = (selected?: number) => [...this.strip(rows, selected), this.head(this.reply === "tools" ? "Tools that the request declared, largest schema first" : `Assembled from${request.rows ? "" : rebuilt}`), this.legend()];
		const above = top.length + strip().length;
		if (this.toAdded) this.item = Math.max(0, diff?.marks.indexOf("+") ?? 0);
		this.toAdded = false;
		// The declared tools stand at the place of the tool schemas in the prompt.
		const at = Math.max(0, rows.findIndex((row) => row.cat === "tools"));
		const list =
			this.reply === "tools"
				? this.list(declared.map((tool) => this.toolRow(tool)), factor, above, undefined, declared.map(() => at))
				: this.list(rows, factor, above, diff?.marks, undefined, this.reply);
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
		if (events.length === 0) return ["No injection, compaction, drop, model, branch, question, delegation or task events on this branch."];
		const kinds = eventKinds(events);
		if (!kinds.some(([kind]) => kind === this.kind)) this.kind = "";
		const shown = events.filter((e) => !this.kind || e.kind === this.kind);
		// A negative change frees context.
		const change = (delta: number | undefined, width = 0) =>
			delta === undefined ? " ".repeat(width) : t.fg(delta < 0 ? "success" : "warning", `≈${delta < 0 ? "−" : "+"}${fmtTokens(Math.abs(delta))}`.padStart(width));
		const sized = shown.filter((e) => e.delta !== undefined);
		const where = (e: { after: number }) => (e.after ? `after #${e.after}` : "at the start");
		const width = Math.max(...shown.map((e) => where(e).length));
		const by = injectors(shown);
		const name = Math.max(...by.map((sum) => sum.producer.length));
		return [
			this.head("Events by kind"),
			...this.wrap([this.chip("all", events.length, !this.kind), ...kinds.map(([kind, count]) => this.chip(kind, count, kind === this.kind))]),
			this.pairs([["Net change of the context", sized.length ? change(sized.reduce((sum, e) => sum + (e.delta ?? 0), 0)) : "not known"]]),
			...(by.length
				? ["", this.head("Injected by"), ...by.map((sum) => `  ${sum.producer.padEnd(name)}  ${`${sum.count}×`.padStart(5)}  ≈${fmtTokens(sum.tokens).padStart(6)}`)]
				: []),
			"",
			...shown.map((e) => `  ${fmtTime(e.time)}  ${t.fg("muted", where(e).padEnd(width))}  ${t.fg("accent", e.kind.padEnd(14))} ${change(e.delta, 8)}  ${e.detail}${e.replaced === undefined ? "" : `, ${e.replaced} messages replaced${e.removed === undefined ? "" : `, ≈${fmtTokens(e.removed)} tokens`}`}`),
		];
	}

	private files(): Body {
		const t = this.theme;
		const changed = (added?: number, removed?: number) =>
			added === undefined ? " ".repeat(16) : `${t.fg("success", `+${added}`.padStart(7))} ${t.fg("error", (removed === undefined ? "" : `−${removed}`).padStart(8))}`;
		const select = (top: string[], lines: string[], below: string[] = []): Body => ({
			lines: [...top, ...lines.map((line, i) => (i === this.item ? `${t.fg("accent", "▶")} ${line}` : `  ${line}`)), ...below],
			cursor: this.item === 0 ? 0 : top.length + this.item,
		});
		const columns = `${"+added".padStart(7)} ${"−removed".padStart(8)}`;
		// With the selected request as the end, only the operations up to it count.
		const upTo = this.asOf ? this.data.analysis.requests[this.request]?.n : undefined;
		const recorded = upTo === undefined ? this.data.analysis.files : filesUpTo(this.data.analysis.files, upTo);
		const asOf = upTo === undefined ? "" : `as of request ${this.coordinate(upTo)}`;
		const file = recorded.find((f) => f.path === this.opened?.path);
		if (file) {
			// Newest first.
			this.ops = [...file.ops].reverse();
			this.item = Math.min(this.item, this.ops.length - 1);
			const wide = Math.max(7, ...this.ops.map((op) => this.coordinate(op.request).length));
			const names = { reads: "read", writes: "write", edits: "edit", searches: "search", images: "image" };
			// A partial read: its first line, and the number of lines, where 0 is no limit.
			const range = ([first, count]: [number, number]) =>
				t.fg("dim", `  ${count === 0 ? `from line ${first}` : count === 1 ? `line ${first}` : `lines ${first}-${first + count - 1}`}`);
			return select(
				[
					this.head(asOf ? `${file.path}, ${asOf}` : file.path),
					this.pairs([
						["Reads", file.reads],
						["Writes", file.writes],
						["Edits", file.edits],
						["Searches", file.searches],
						["Images", file.images],
						["Lines", `+${file.added} −${file.removed}`],
					]),
					"",
					t.fg("muted", `  ${"time".padEnd(8)}  ${"request".padEnd(wide)}  ${"what".padEnd(6)}  ${columns}  tool`),
				],
				this.ops.map(
					(op) =>
						`${fmtTime(op.time)}  ${this.coordinate(op.request).padEnd(wide)}  ${names[op.op].padEnd(6)}  ${op.hits === undefined ? changed(op.added, op.removed) : `${op.hits} ${op.hits === 1 ? "hit" : "hits"}`.padStart(16)}  ${op.tool}${op.range ? range(op.range) : ""}${op.error ? t.fg("error", "  failed") : ""}`,
				),
			);
		}
		this.opened = undefined;
		const all = recorded.filter((file) => this.matches(file.path));
		const files = fileRows(all, FILE_ORDERS[this.fileOrder], this.fileKind || undefined);
		this.fileList = files;
		const unresolved = this.data.analysis.unresolvedEdits;
		const note = unresolved
			? [this.theme.fg("dim", `  ${unresolved} anchor-based edits are not listed: they were made before pi-context recorded their file.`)]
			: [];
		if (recorded.length === 0) return { lines: [asOf ? `No file activity ${asOf}.` : "No file activity yet.", ...note] };
		// A kind keeps the files that have such operations.
		const top = [
			...(asOf ? [this.head(`Files ${asOf}`)] : []),
			...this.wrap([this.chip("all", all.length, !this.fileKind), ...FILE_KINDS.map((kind) => this.chip(kind, all.filter((file) => file[kind] > 0).length, kind === this.fileKind))]),
			t.fg("dim", `  Order: ${FILE_ORDER_NAMES[FILE_ORDERS[this.fileOrder]]}.`),
		];
		if (files.length === 0) return { lines: [...top, "  No file matches the filter.", ...note] };
		this.item = Math.min(this.item, files.length - 1);
		const count = (n: number, width = 5) => String(n).padStart(width);
		return select(
			[...top, this.head(` ${"read".padStart(6)}${"write".padStart(6)}${"edit".padStart(6)}${"search".padStart(7)}${"image".padStart(6)}  ${columns}  path`)],
			files.map(
				(f) =>
					`${count(f.reads)} ${count(f.writes)} ${count(f.edits)} ${count(f.searches, 6)} ${count(f.images)}  ${f.added + f.removed ? changed(f.added, f.removed) : changed()}  ${f.path}`,
			),
			note,
		);
	}

	private commands(): Body {
		const t = this.theme;
		const commands = this.data.analysis.commands;
		if (commands.length === 0) return { lines: ["No commands yet."] };
		const programs = programRanks(commands)
			.slice(0, 10)
			.map(({ program, uses, runs }) => `${program} ×${uses}${runs < uses ? t.fg("dim", ` in ${runs} ${runs === 1 ? "command" : "commands"}`) : ""}`);
		const attention = attentionOf(commands);
		const slowest = attention.slowest === undefined ? undefined : commands[attention.slowest];
		const brief = (command: string) => truncateToWidth(command.replace(/\s+/g, " "), 40);
		// The entry whose commands the tab lists is marked.
		const note = (entry: keyof Attention, name: string, text: string) =>
			sameLens(this.lens, attentionLens(attention, entry)) ? t.bold(t.fg("accent", `[${name} ${text}]`)) : `${t.fg("muted", name)} ${text}`;
		const notes = [
			...(slowest ? [note("slowest", "Slowest", `${fmtShort(slowest.ms ?? 0)}  ${brief(slowest.command)}`)] : []),
			...(attention.failing ? [note("failing", "Fails most", `${attention.failing.program} ×${attention.failing.count}`)] : []),
			...(attention.repeated ? [note("repeated", "Repeated most", `×${attention.repeated.count}  ${brief(attention.repeated.command)}`)] : []),
		];
		const mark = (ok?: boolean) => (ok === undefined ? t.fg("dim", "…") : ok ? t.fg("success", "✓") : t.fg("error", "✗"));
		const timed = commands.filter((c) => c.ms !== undefined);
		const rows = commandRows(commands, this.lens).filter((index) => this.matches(commands[index].command));
		// Newest first, unless the lens orders the commands.
		this.commandList = (this.lens.slowest ? rows : rows.reverse()).map((index) => commands[index]);
		this.item = Math.max(0, Math.min(this.item, this.commandList.length - 1));
		const { lens } = this;
		const what = [
			lens.slowest ? "slowest first" : "newest first",
			...(lens.slow ? ["slow only"] : []),
			...(lens.status ? [`status ${lens.status}`] : []),
			...(lens.program ? [`running ${lens.program}`] : []),
			...(lens.text ? [`containing "${brief(lens.text)}"`] : []),
		];
		const wide = Math.max(7, ...this.commandList.map((c) => (c.id ? this.coordinate(c.request).length : 0)));
		const top = [
			...(notes.length ? [this.head("Attention"), ...this.wrap(notes), ""] : []),
			this.pairs([
				["Commands", commands.length],
				["Failed", commands.filter((c) => c.ok === false).length],
				["Time", timed.length ? fmtDuration(timed.reduce((sum, c) => sum + (c.ms ?? 0), 0)) : "not known"],
			]),
			...this.wrap([
				this.chip("all", commands.length, !this.lens.status),
				...COMMAND_STATUSES.map((status) => this.chip(status, commands.filter((c) => commandStatus(c) === status).length, status === this.lens.status)),
			]),
			"",
			this.head("Programs"),
			...this.wrap(programs),
			"",
			this.head(`Executions (${what.join(", ")})`),
			...(commands.some(isSlow) ? [t.fg("dim", "  A highlighted time is 10 seconds or more.")] : []),
			t.fg("muted", `    ${"time".padEnd(8)}  ${"request".padEnd(wide)}  ${"took".padStart(6)}  command`),
		];
		const lines = this.commandList.map((c, i) => {
			const request = (c.id ? this.coordinate(c.request) : "user").padEnd(wide);
			const took = (c.ms === undefined ? "" : fmtShort(c.ms)).padStart(6);
			const shape = commandShape(c.command);
			const tags = [...(shape.lines > 1 ? [`${shape.lines} lines`] : []), ...(shape.heredoc ? ["heredoc"] : []), ...(shape.inline ? ["inline script"] : [])];
			const tag = tags.length ? `${t.fg("muted", `[${tags.join(", ")}]`)} ` : "";
			const exit = c.exit === undefined ? "" : `${t.fg("error", `exit ${c.exit}`)} `;
			return `${i === this.item ? t.fg("accent", "▶") : " "} ${mark(c.ok)} ${fmtTime(c.time)}  ${t.fg("muted", request)}  ${isSlow(c) ? t.fg("warning", took) : took}  ${exit}${tag}${c.command.replace(/\s+/g, " ")}`;
		});
		if (lines.length === 0) lines.push("  No command matches the filter.");
		return { lines: [...top, ...lines], cursor: this.item === 0 ? 0 : top.length + this.item };
	}

	/** What pi knows about a tool now, as the text of the inspector. */
	private toolText(name: string): string | undefined {
		const doc = this.data.toolDoc?.(name);
		if (!doc) return undefined;
		return [
			...(doc.description ? [doc.description, ""] : []),
			...(doc.params.length ? ["Parameters:"] : []),
			...doc.params.map((param) => `  ${param.name}: ${param.type}${param.required ? ", required" : ""}${param.description ? `\n      ${param.description}` : ""}`),
		].join("\n");
	}

	/** A tool that a request declared, as an item of the Browser tab. Its content is what pi knows about the tool now. */
	private toolRow(tool: DeclaredTool): Row {
		const text = this.toolText(tool.name) ?? "(No description: pi does not know this tool now.)";
		return { cat: "tools", tokens: tool.tokens, label: tool.name, preview: `${tool.source ? `${tool.source}  ` : ""}called ${tool.calls}×`, text };
	}

	private tools(): string[] {
		const { analysis, declared, schemas, sources, factor } = this.data;
		const { skills } = analysis;
		const order = TOOL_ORDERS[this.toolOrder];
		const all = toolRows(analysis.tools, schemas, sources, order);
		if (all.length === 0) return ["No tools yet."];
		const tools = all.filter((tool) => this.matches(`${tool.name} ${tool.source}`));
		const flagged = tools.some((tool) => undeclared(tool, declared) > 0);
		const count = (n: number) => String(n).padStart(7);
		const size = (tokens: number) => (tokens ? `≈${fmtTokens(tokens * factor)}` : "–").padStart(9);
		const wide = Math.max(6, ...tools.map((tool) => tool.source.length));
		const name = (tool: (typeof tools)[number]) => {
			const calls = undeclared(tool, declared);
			return calls ? this.theme.fg("warning", `${tool.name}  ! ${calls} not declared`) : tool.name;
		};
		const groups = schemaSources(schemas, sources);
		this.item = Math.min(this.item, Math.max(0, tools.length - 1));
		this.picks = tools.map((tool, i) => ({ line: 1 + i, title: `Tool · ${tool.name}`, text: this.toolText(tool.name) }));
		const lines = [
			this.head(`${"calls".padStart(9)}${"nested".padStart(8)}${"errors".padStart(8)}${"call".padStart(10)}${"result".padStart(10)}${"schema".padStart(10)}  ${"source".padEnd(wide)}  tool`),
			...tools.map(
				(tool, i) =>
					`${i === this.item ? this.theme.fg("accent", "▶") : " "} ${count(tool.calls)} ${count(tool.nested)} ${tool.errors ? this.theme.fg("error", count(tool.errors)) : count(0)} ${size(tool.callTokens)} ${size(tool.resultTokens)} ${size(tool.schema)}  ${this.theme.fg("muted", tool.source.padEnd(wide))}  ${name(tool)}`,
			),
			...(flagged ? [this.theme.fg("warning", "  ! Direct calls that the model made while the tool was not declared to it.")] : []),
			this.theme.fg("dim", `  Sorted by ${order === "calls" ? "calls" : order === "schema" ? "the size of the schema" : "name"}. Session totals; token figures are estimates.`),
			this.theme.fg("dim", "  schema: what the declaration of the tool takes in each request now; – when the tool is not declared."),
			this.theme.fg("dim", "  A nested call is made by another tool and occupies that tool's tokens."),
			"",
			this.head("Tool schemas by source"),
			...(groups.length ? groups.map((group) => `  ${size(group.tokens)} ${`${group.tools} ${group.tools === 1 ? "tool" : "tools"}`.padStart(10)}  ${group.source || "unknown"}`) : ["  None."]),
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
		if (agent.context != null) {
			const window = agent.window ? ` / ${fmtTokens(agent.window)} (${fmtPercent(agent.context, agent.window)}) ${bar(agent.context / agent.window, 12)}` : "";
			detail("Context", `${fmtTokens(agent.context)}${window}`);
		}
		if (agent.sums) detail("Composition", this.mix(agent.sums, 16));
		// An agent is under the agent that started it.
		const indent = "  ".repeat((agent.depth ?? (agent.parent ? 1 : 0)) + 1);
		const lines = [
			`${selected ? t.fg("accent", "▶") + indent.slice(1) : indent}${agent.parent ? "↳ " : ""}${mark} ${t.bold(agent.type)}  ${agent.description}  ${t.fg("dim", agent.id)}`,
			...this.wrap(details, `${indent}  `),
		];
		if (agent.error) lines.push(`${indent}  ${t.fg("error", agent.error.replace(/\s+/g, " "))}`);
		if (!selected) return lines;
		const { timeline, tasks, agents } = this.data;
		const more = agentDetail(agent, timeline, boardOf(tasks, agents));
		const flat = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, this.width);
		// The key stands on the first line of its values.
		const row = (key: string, value: string) => lines.push(`${indent}  ${t.fg("muted", key.padEnd(7))}${value}`);
		if (more.prompt) row("Prompt", flat(more.prompt));
		if (more.reply && more.reply !== agent.error) row("Reply", flat(more.reply));
		more.tasks.forEach((task, i) => row(i ? "" : "Tasks", `#${task.id} ${flat(task.subject)}  ${t.fg("dim", task.status)}`));
		more.events.forEach((event, i) => row(i ? "" : "Events", `${fmtDay(event.time).slice(5)} ${fmtTime(event.time)}  ${event.kind}  ${flat(event.title)}`));
		return lines;
	}

	private fleet(): Body {
		const { analysis, agents, usage, model, running, parentSession, timeline, tasks } = this.data;
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
		const view = FLEET_VIEWS[this.fleetView];
		const board = boardOf(tasks, agents);
		const summary = fleetSummary(agents, timeline, board);
		// The timeline and the tasks of one agent, when the tab is narrowed to it.
		const only = agents.find((agent) => agent.id === this.only);
		if (!only) this.only = undefined;
		const part = only ? narrow(only, timeline, board) : { timeline, board };
		const counts = { Agents: agents.length, Timeline: part.timeline.length, Tasks: part.board.reduce((sum, group) => sum + group.items.length, 0) };
		lines.push("");
		if (summary.agents + summary.items + summary.messages > 0) {
			lines.push(
				this.pairs([
					["Subagents", `${summary.agents} (${summary.running} running)`],
					["Tasks and delegations", summary.items],
					["Messages", summary.messages],
				]),
			);
		}
		lines.push(...this.wrap(FLEET_VIEWS.map((name) => this.chip(name, counts[name], name === view))));
		if (only) lines.push(`  ${t.fg("warning", `Only ${only.type}: ${only.description.replace(/\s+/g, " ")}`)}  ${t.fg("dim", "in the timeline and the tasks")}`);
		this.picks = [];
		/** Lines of the selected agent after its first. */
		let span = 0;
		if (view === "Timeline") this.timeline(lines, part.timeline);
		else if (view === "Tasks") this.board(lines, only);
		else {
			const listed = this.runningOnly ? agents.filter((agent) => agent.status === "running") : agents;
			lines.push("", this.head(this.runningOnly ? `Running subagents (${listed.length} of ${agents.length})` : `Subagents (${agents.length})`));
			if (listed.length === 0) lines.push(agents.length ? "  No subagent runs now." : "  None on this branch.");
			this.item = Math.min(this.item, Math.max(0, listed.length - 1));
			listed.forEach((agent, i) => {
				this.picks.push({ line: lines.length, file: agent.sessionFile, title: `${agent.type}: ${agent.description}`, agent: agent.id });
				const block = this.agentLines(agent, i === this.item);
				if (i === this.item) span = block.length - 1;
				lines.push(...block);
			});
		}
		// After a move, the selected entry comes into view whole. Otherwise the tab scrolls freely.
		const pick = this.moved ? this.picks[this.item] : undefined;
		this.moved = false;
		return { lines, cursor: pick?.line, span };
	}

	/** The timeline view of the Fleet tab: adds those of the events that pass the filter. An event opens into its content. */
	private timeline(lines: string[], timeline: FleetEvent[]): void {
		const t = this.theme;
		const { agents } = this.data;
		// The type of an agent tells more than its id.
		const who = (event: FleetEvent) => agents.find((agent) => agent.id === event.agent)?.type ?? event.agent ?? "";
		const events = timeline.filter((event) => this.matches(`${event.title} ${event.body ?? ""}`));
		if (this.latestFirst) events.reverse();
		this.item = Math.min(this.item, Math.max(0, events.length - 1));
		lines.push("", this.head(`Timeline (${this.latestFirst ? "latest" : "earliest"} first)`));
		if (events.length === 0) lines.push(timeline.length ? "  No event matches the filter." : "  No delegation, message, completion or task event on this branch.");
		const wide = Math.min(24, Math.max(0, ...events.map((event) => who(event).length)));
		events.forEach((event, i) => {
			this.picks.push({ line: lines.length, title: `${event.kind} · ${event.title.replace(/\s+/g, " ")}`, text: event.body, agent: event.agent });
			lines.push(
				`${i === this.item ? t.fg("accent", "▶") : " "} ${fmtDay(event.time).slice(5)} ${fmtTime(event.time)}  ${t.fg("accent", event.kind.padEnd(12))}  ${t.fg("muted", who(event).slice(0, wide).padEnd(wide))}  ${event.title.replace(/\s+/g, " ")}`,
			);
		});
	}

	/** The tasks view of the Fleet tab: adds the tasks and the delegations by owner. An entry opens into its description and reply. */
	private board(lines: string[], only?: AgentRec): void {
		const t = this.theme;
		const { tasks, agents } = this.data;
		// With an agent: only the tasks that it or its type owns, and its own delegation.
		const part = (state?: TaskState) => (only ? narrow(only, [], boardOf(tasks, agents, state)).board : boardOf(tasks, agents, state));
		const all = part().flatMap((group) => group.items);
		const groups = part(this.taskState || undefined);
		this.item = Math.min(this.item, Math.max(0, groups.reduce((sum, group) => sum + group.items.length, 0) - 1));
		const mark = (item: BoardItem) =>
			item.state === "in_progress"
				? t.fg("accent", "●")
				: item.state === "pending"
					? t.fg("dim", "○")
					: item.status === "completed"
						? t.fg("success", "✓")
						: t.fg("error", "✗");
		const ids = (list: string[]) => list.map((id) => `#${id}`).join(", ");
		// The tasks that a task waits for, with the blockers of its blockers. A delegation waits for none.
		const chain = (item: BoardItem) =>
			(item.agent ? [] : chainOf(tasks, item.id)).map((id) => {
				const task = tasks.find((task) => task.id === id);
				return `  #${id}${task ? ` ${task.subject.replace(/\s+/g, " ")} (${task.status})` : ""}`;
			});
		lines.push(
			"",
			...this.wrap([
				this.chip("all", all.length, !this.taskState),
				...TASK_STATES.map((state) => this.chip(TASK_STATE_NAMES[state], all.filter((item) => item.state === state).length, state === this.taskState)),
			]),
		);
		if (groups.length === 0) lines.push("", all.length ? "  No task is in this state." : "  No tasks and no delegations on this branch.");
		for (const { owner, items } of groups) {
			lines.push("", this.head(`${owner} (${items.length})`));
			for (const item of items) {
				const text = [
					`Status: ${item.status}`,
					...(item.blockedBy.length ? [`Blocked by: ${ids(item.blockedBy)}`] : []),
					...(chain(item).length ? ["Depends on, nearest first:", ...chain(item)] : []),
					...(item.description ? [`\nDescription:\n${item.description}`] : []),
					...(item.reply ? [`\nReply:\n${item.reply}`] : []),
				].join("\n");
				const selected = this.picks.length === this.item;
				this.picks.push({ line: lines.length, title: `${owner} · ${item.subject.replace(/\s+/g, " ")}`, text, agent: item.agent });
				const blocked = item.blockedBy.length
					? `  ${t.fg("warning", `blocked by ${ids(item.blockedBy)}`)}`
					: readiness(item) === "ready"
						? `  ${t.fg("success", "ready")}`
						: "";
				// A delegation has the id of its agent, which is long.
				const subject = `${item.agent ? "" : `#${item.id} `}${item.subject.replace(/\s+/g, " ")}`;
				lines.push(`${selected ? t.fg("accent", "▶") : " "} ${mark(item)} ${subject}  ${t.fg("muted", item.status)}${blocked}${item.agent ? `  ${t.fg("dim", item.id)}` : ""}`);
			}
		}
	}

	private insightsTab(): string[] {
		if (!this.summaries) return [this.progress];
		const t = this.theme;
		const days = PERIODS[this.period];
		this.insights ??= aggregate(this.summaries, Date.now(), days, {
			cwd: this.projectOnly ? this.host.cwd : undefined,
			sort: SORTS[this.sort][0],
			day: this.day,
			uses: this.uses,
		});
		const s = this.insights;
		const period = Number.isFinite(days) ? `Last ${days} days` : "All time";
		const [year, month, date] = (s.day ?? "").split("-").map(Number);
		const span = s.day ? `${s.day} (${WEEKDAYS[(new Date(year, month - 1, date).getDay() + 6) % 7]}) of ${period.toLowerCase()}` : period;
		const recorded = s.composition.requests;
		const uses = this.uses;
		// The entry that narrows the list of sessions is marked. After it: the sessions that used it, the last use, and the source of a skill.
		const top = (kind: NonNullable<InsightsFilter["uses"]>["kind"]) =>
			this.wrap(
				s[kind].map(([name, n, last, sessions]) => {
					const text = `${name} ×${n}`;
					const on = uses?.kind === kind && uses.name === name;
					const source = kind === "skills" ? s.skillInfo[name]?.[1] : undefined;
					const notes = [`in ${sessions} ${sessions === 1 ? "session" : "sessions"}`, ...(last ? [ago(last)] : []), ...(source ? [source] : [])];
					return `${on ? t.bold(t.fg("accent", `[${text}]`)) : text} ${t.fg("dim", notes.join(", "))}`;
				}),
			);
		const used = uses ? `, sessions that used the ${uses.kind.slice(0, -1)} ${uses.name}` : "";
		const metric = METRICS[this.metric];
		const max = Math.max(...s.week.map((day) => day[metric]), 0) || 1;
		const peak = Math.max(...s.heat.flat(), 1);
		const sessions = s.sessions.filter((session) => this.matches(`${session.cwd} ${session.name}`));
		this.item = Math.min(this.item, Math.max(0, sessions.length - 1));
		const lines = [
			this.head(`${span}, ${this.projectOnly ? `project ${basename(this.host.cwd)}` : "all projects"}${used}`),
			this.pairs([
				[uses ? "Sessions listed" : "Sessions", s.sessions.length],
				["Requests", s.requests],
				["Tokens", fmtTokens(s.tokens)],
				["Cost", fmtCost(s.cost)],
				...(s.day ? [] : ([["Active days", s.activeDays]] as [string, number][])),
			]),
			this.pairs([
				["Human inputs", s.userInputs],
				["Tool calls", s.toolCalls],
				["Active time", fmtDuration(s.activeMs)],
				["Cache-hit rate", fmtPercent(s.cacheRate, 1)],
			]),
			"",
			this.head(`${metric[0].toUpperCase()}${metric.slice(1)} by day`),
			...this.days(s),
			"",
			this.head(`Last 7 days (bars: ${metric})`),
			...s.week.map(
				(day) =>
					`  ${day.day.slice(5)} ${t.fg("accent", bar(day[metric] / max, 24))} ${fmtTokens(day.tokens).padStart(7)}  ${fmtCost(day.cost).padStart(9)}  ${String(day.requests).padStart(5)} requests  ${day.sessions} sessions`,
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
			...top("tools"),
			this.head("Top programs"),
			...top("programs"),
			this.head("Top skills"),
			...top("skills"),
			t.fg("dim", "  After the uses: the sessions that used it, the last use, and for a skill where it comes from."),
			t.fg("dim", "  t, c, k: list only the sessions that used the next tool, program or skill. x: all sessions."),
			"",
			this.head(`Sessions (${SORTS[this.sort][1]}${this.grouped ? ", by project" : ""}${used.replace(", sessions", ",")})`),
			t.fg("dim", "  ctx: the tokens that the last request of the session sent, and their share of the window of its model when pi knows it."),
			t.fg("dim", "  The bar shows the estimated composition of that request:"),
			...this.wrap(CATEGORIES.map((cat) => `${t.fg(COLORS[cat], "█")} ${t.fg("muted", LABELS[cat])}`)),
		];
		if (sessions.length === 0) lines.push(this.filterText ? "  No session matches the filter." : "  None.");
		this.picks = [];
		const current = this.host.sessionId();
		// The window of each model, asked for once.
		const windows = new Map<string, number | undefined>();
		const windowOf = (model: string) => {
			if (!windows.has(model)) windows.set(model, this.host.windowOf(model));
			return windows.get(model);
		};
		const row = (session: SessionSummary) => {
			const selected = this.picks.length === this.item;
			this.picks.push({ line: lines.length, file: session.file, title: session.name || `${basename(session.cwd)} ${fmtDay(session.end)}` });
			const window = session.model ? windowOf(session.model) : undefined;
			const full = window ? fmtPercent(session.context, window) : "";
			lines.push(
				`${selected ? t.fg("accent", "▶") : " "} ${fmtDay(session.end).slice(5)} ${fmtTime(session.end).slice(0, 5)}  ${basename(session.cwd).slice(0, 24).padEnd(24)} ${String(session.userInputs).padStart(4)} inputs · ${String(session.requests).padStart(5)} requests ${fmtTokens(session.tokens).padStart(7)}  ${fmtCost(session.cost).padStart(9)} ${fmtTokens(session.context).padStart(7)} ctx ${full.padStart(4)} ${this.mix(session.profile, 10)}  ${session.id === current ? `${t.fg("accent", "current")}  ` : ""}${t.fg("dim", session.name)}`,
			);
		};
		for (const [cwd, group] of this.grouped ? groupSessions(sessions) : ([["", sessions]] as [string, SessionSummary[]][])) {
			if (cwd) lines.push(t.fg("muted", `  ${cwd} (${group.length})`));
			for (const session of group) row(session);
		}
		return lines;
	}

	private settings(): Body {
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
		// The entries are in the order of SETTINGS.
		const own = items.length;
		for (const name of CHOICE_SETTINGS) {
			const { key, label, values, help } = CHOICES[name];
			items.push({
				name: label,
				value: `${choiceOf(config, name)}${config[key] === undefined ? " (default)" : ""}  ${t.fg("dim", `of: ${values.join(", ")}`)}`,
				help: `${help} Enter sets the next value. Clearing restores the default: ${values[0]}.`,
			});
		}
		this.item = Math.min(this.item, items.length - 1);
		const selected = items[this.item];
		const row = (item: (typeof items)[number], i: number) => `${i === this.item ? t.fg("accent", "▶") : " "} ${item.name.padEnd(22)} ${item.value}`;
		const lines = [
			this.head("Settings"),
			...items.slice(0, own).map(row),
			"",
			this.head("View defaults"),
			...items.slice(own).map((item, i) => row(item, own + i)),
			"",
			...wrapped(selected.help, this.width - 2).map((line) => t.fg("dim", `  ${line}`)),
			t.fg("dim", `  Saved in ${this.host.configPath}`),
			...(selected.text ? ["", this.head("Value"), ...wrapped(selected.text, this.width - 2).map((line) => `  ${line}`)] : []),
		];
		// The selected setting stays in view, and its help with it when the height allows.
		const cursor = this.item === 0 ? 0 : this.item < own ? 1 + this.item : 3 + this.item;
		return { lines, cursor, span: lines.length - 1 - cursor };
	}
}