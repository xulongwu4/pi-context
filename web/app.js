"use strict";

const token = new URLSearchParams(location.search).get("t") ?? "";
const CATS = ["system", "tools", "user", "injected", "skills", "toolCalls", "toolResults", "reasoning", "answers"];
const COLORS = {
	system: "#6366f1",
	tools: "#f59e0b",
	user: "#22c55e",
	injected: "#a855f7",
	skills: "#f97316",
	toolCalls: "#3b82f6",
	toolResults: "#14b8a6",
	reasoning: "#8b5cf6",
	answers: "#ec4899",
};
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const INSIGHT_CARDS = ["i-kpi", "i-days", "i-week", "i-heat", "i-composition", "i-models", "i-projects", "i-tools", "i-programs", "i-sessions"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Most rows a table shows, and most removed items the browser lists. */
const MAX_LIST = 200;
/** Most item contents kept after they were opened. */
const MAX_TEXTS = 50;
const SESSIONS_STEP = 60;
/** The kinds of file operations: the counter of a file, the name of its chip, the name of one operation. */
const FILE_KINDS = [["reads", "Read", "read"], ["writes", "Written", "write"], ["edits", "Edited", "edit"], ["searches", "Searched", "search"], ["images", "Images", "image"]];
/** What the trend marks on a bar, in the order of the server: the glyph and what it tells. The first that a bar has is shown. */
const MARKS = {
	compaction: ["✂", "compaction"],
	drop: ["▾", "drop"],
	restore: ["▴", "restore"],
	"task done": ["✓", "task done"],
	task: ["□", "task created"],
	question: ["?", "question to the user"],
	longest: ["◷", "took the longest"],
	growth: ["↑", "largest growth"],
	delegation: ["→", "delegation"],
	agent: ["←", "message of a subagent"],
	skill: ["◆", "skill loaded"],
	model: ["⇄", "model change"],
};
/** Width of the treemap of the current context, in units of its height. */
const MAP_RATIO = 2.5;
const TASK_STATES = [["in_progress", "In progress"], ["pending", "Pending"], ["done", "Done"]];
/** How a command ended that did not end by itself. */
const STOPS = { timeout: "timed out", aborted: "aborted" };

const state = {
	page: location.hash === "#insights" ? "insights" : "context",
	/** The saved session on show, as { file, title }. Null: the current session. */
	session: null,
	data: null,
	/** Number of the request in the browser. Null: the current context. */
	request: null,
	/** What the server said about that request. */
	view: null,
	/**
	 * Context Trend: one bar for each human input, a bar as the change since the bar before, the whole session in the width.
	 * `last` is the number of bars that the trend shows, the last ones, until `whole` is set. 0: every bar.
	 */
	trend: { byTurn: false, delta: false, fit: false, last: 0, whole: false },
	/** Current Context shows a treemap in place of the bar. */
	treemap: false,
	/** Order of the tools: calls, schema or name. */
	toolOrder: "calls",
	/** Order of the files: ops, recent, name or lines. */
	fileOrder: "ops",
	/** The kind of operation whose files File Activity lists. Empty: every file. */
	fileKind: "",
	/** File Activity shows the files as they were after the request of the Context Browser: `then` holds them as { n, files }. */
	asOf: false,
	then: null,
	/** What Command Executions lists, as the CommandLens of src/analyze.ts: some of status, slow, program, text and slowest. */
	lens: {},
	/** Indexes of the commands whose row is open, and what the server said about their outputs: { text } or { error }. */
	openRuns: new Set(),
	outputs: new Map(),
	/** Index in the commands of the run that Command Executions highlights. */
	run: null,
	/** What the diff of a request compares with: the request before it, or with "input" the last request before its human input. */
	diff: "request",
	/** The tool whose description the tool list shows, and what the server said about it: { name, description, params } or { name, error }. */
	tool: null,
	toolDoc: null,
	/** Context Browser, the tools that a request declared: what the search box holds, and the order: size, name or calls. */
	declFind: "",
	declOrder: "size",
	/**
	 * The subagent whose detail Agents shows, and what the server said about it: { id, prompt, reply, tasks, events, timeline, board } or { id, error }.
	 * Collaboration Timeline and Tasks Board show its `timeline` and its `board` in place of those of the session.
	 */
	agent: null,
	agentInfo: null,
	/** The kind of event that Collaboration Timeline lists. Empty: every kind. */
	fleetKind: "",
	/** The part of the replies that the Context Browser keeps: reasoning, toolCalls or answers. Empty: every item. */
	reply: "",
	/** Collaboration Timeline: the earliest event first, and the events whose body is open. */
	earliest: false,
	openEvents: new Set(),
	/** Tasks Board: the state it lists (empty: every state), the open items, and the id of the highlighted task. */
	taskState: "",
	openTasks: new Set(),
	task: null,
	/** Id of a task to the ids of the tasks that it waits for, for the tasks that were opened. */
	chains: new Map(),
	/** Whether the page took the view defaults of the settings. */
	started: false,
	openCats: new Set(),
	openItems: new Set(),
	/** Paths of the files whose operations File Activity lists. */
	openFiles: new Set(),
	/** The opened items as { text, call, json }; `call` describes the call of a tool result, `json` is the text as formatted JSON when it is JSON. */
	texts: new Map(),
	/** How the content of an opened item shows, by the key of the item: { mode, find, at }. */
	viewers: new Map(),
	/** The kind of event that Context Events lists. Empty: every kind. */
	kind: "",
	insights: null,
	/** What the calendar of Insights is shaded by: requests, tokens, sessions or cost. */
	dayMetric: "tokens",
	/** Length of the Insights period in days, or "all". */
	days: 30,
	/** The day that Insights is narrowed to, as YYYY-MM-DD, or with `until` the first and the last day. Null: the whole period. */
	day: null,
	until: null,
	/** The tool, program or skill whose sessions Insights lists, as { kind, name }. Null: every session. */
	uses: null,
	shown: SESSIONS_STEP,
};
let labels = {};

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

// The formats of src/format.ts.
function tok(n) {
	if (n == null) return "?";
	for (const [limit, unit] of [[1e9, "B"], [1e6, "M"], [1e3, "k"]]) if (n >= limit) return (n / limit).toFixed(1) + unit;
	return String(Math.round(n));
}
const cost = (dollars) => "$" + dollars.toFixed(dollars >= 1 ? 2 : 4);
function dur(ms) {
	const s = Math.round(ms / 1000);
	if (s < 60) return s + "s";
	if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
	return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}
const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);
/** A short time shows tenths of a second. */
const secs = (ms) => (ms < 10_000 ? (ms / 1000).toFixed(1) + "s" : dur(ms));
const date = (ms) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const pct = (part, total) => (total > 0 ? Math.round((part / total) * 100) : 0) + "%";

function sumBy(rows) {
	const sums = Object.fromEntries(CATS.map((cat) => [cat, 0]));
	for (const row of rows) sums[row.cat] += row.tokens;
	return sums;
}
const totalOf = (sums) => CATS.reduce((total, cat) => total + sums[cat], 0);
/** Identifies an item by its content, so that it stays open when the data is loaded again. */
const keyOf = (row) => [row.id ?? "", row.cat, row.label, row.tokens, row.preview].join("|");
const params = (extra = {}) => (state.session ? { ...extra, session: state.session.file } : extra);

async function api(name, query = {}, body) {
	const options = body && { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
	const response = await fetch(`api/${name}?${new URLSearchParams({ t: token, ...query })}`, options || undefined);
	const result = await response.json();
	if (!response.ok) throw new Error(result.error ?? response.statusText);
	return result;
}

function setError(message) {
	$("error").textContent = message;
	$("error").hidden = !message;
}

const painted = new Map();
/** Sets the content of a card. An unchanged card is left alone, and scroll positions are kept. */
function paint(id, html) {
	if (painted.get(id) === html) return;
	painted.set(id, html);
	const body = $(id).querySelector(".body");
	// A list scrolled to its end stays at its end, so that the newest request stays in view.
	const kept = new Map(
		[...body.querySelectorAll("[data-keep]")].map((el) => [el.dataset.keep, el.scrollWidth - el.clientWidth - el.scrollLeft < 4 ? null : el.scrollLeft]),
	);
	const top = body.scrollTop;
	// A field of the card that has the focus keeps it, with its caret.
	const active = body.contains(document.activeElement) ? document.activeElement : null;
	const focus = active?.dataset.focus;
	body.innerHTML = html;
	body.scrollTop = top;
	for (const el of body.querySelectorAll("[data-keep]")) el.scrollLeft = kept.get(el.dataset.keep) ?? el.scrollWidth;
	if (!focus) return;
	const field = body.querySelector(`[data-focus="${focus}"]`);
	field?.focus();
	field?.setSelectionRange(active.selectionStart, active.selectionEnd);
}

// Parts of cards.

function donut(parts, label, sub) {
	const total = parts.reduce((sum, part) => sum + part.value, 0);
	const round = 2 * Math.PI * 42;
	let offset = 0;
	const arcs = parts.map((part) => {
		const length = total > 0 ? (part.value / total) * round : 0;
		const arc = `<circle cx="60" cy="60" r="42" fill="none" stroke="${part.color}" stroke-width="14" stroke-dasharray="${length} ${round - length}" stroke-dashoffset="${-offset}"/>`;
		offset += length;
		return arc;
	});
	return `<svg class="donut" viewBox="0 0 120 120"><g transform="rotate(-90 60 60)"><circle cx="60" cy="60" r="42" fill="none" style="stroke:var(--track)" stroke-width="14"/>${arcs.join("")}</g><text x="60" y="62" font-size="15" font-weight="700">${esc(label)}</text><text x="60" y="77" font-size="10">${esc(sub)}</text></svg>`;
}

/** One line for each part: { label, color, value, text }. */
function legend(parts) {
	const total = parts.reduce((sum, part) => sum + part.value, 0);
	const line = (part) =>
		`<div><i class="dot" style="background:${part.color}"></i><span>${esc(part.label)}</span><b class="tok">${esc(part.text)}</b><small>${pct(part.value, total)}</small></div>`;
	return `<div class="legend">${parts.map(line).join("")}</div>`;
}

const catParts = (sums, factor = 1) =>
	CATS.filter((cat) => sums[cat] > 0).map((cat) => ({ label: labels[cat], color: COLORS[cat], value: sums[cat] * factor, text: "≈" + tok(sums[cat] * factor) }));

const pairs = (list) => `<dl class="pairs">${list.map(([name, value]) => `<div><dt>${esc(name)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>`;

/**
 * One tile for each [value, label, sub, to, part]. A tile with `to` goes to the card, or the part of a card, with that id.
 * With `part`, the sub line is about a part of the card: it goes to the card with the filter that the attributes `part` set. See the action "go".
 */
const tiles = (list) =>
	`<div class="tiles">${list.map(([value, label, sub = "", to, part]) => `<div class="tile"${to ? ` data-act="go" data-to="${to}" title="Go to the card"` : ""}><b>${esc(value)}</b><span>${esc(label)}</span><small>${part ? `<a data-act="go" data-to="${to}" ${part} title="Go to the card and list only these">${esc(sub)}</a>` : esc(sub)}</small></div>`).join("")}</div>`;

/** Names with counts, the largest first. With `attrs`, each is a button with the attributes that `attrs` gives for its name. */
function pills(title, items, max = 8, attrs) {
	if (items.length === 0) return "";
	const sorted = [...items].sort((a, b) => b[1] - a[1]);
	const more = sorted.length > max ? `<span class="pill muted">+${sorted.length - max} more</span>` : "";
	const tag = attrs ? "button" : "span";
	const shown = sorted.slice(0, max).map(([name, count]) => `<${tag} class="pill"${attrs ? " " + attrs(name) : ""}>${esc(name)} <b>${count}</b></${tag}>`);
	return `<div class="pills"><span class="muted">${title}</span>${shown.join("")}${more}</div>`;
}

/** A table. Cells are HTML. A heading that starts with ">" aligns its column to the right. A row that is a string is one cell over all columns. */
function table(head, rows, empty = "Nothing yet.") {
	if (rows.length === 0) return `<p class="muted">${empty}</p>`;
	const right = head.map((title) => title.startsWith(">"));
	const cells = (row, tag) => row.map((cell, i) => `<${tag}${right[i] ? ' class="r"' : ""}>${cell}</${tag}>`).join("");
	const titles = cells(head.map((title) => title.replace(/^>/, "")), "th");
	const more = rows.length > MAX_LIST ? `<p class="muted">The first ${MAX_LIST} of ${rows.length}.</p>` : "";
	const lines = rows.slice(0, MAX_LIST).map((row) => `<tr>${typeof row === "string" ? `<td colspan="${head.length}">${row}</td>` : cells(row, "td")}</tr>`);
	return `<div class="scroll"><table><thead><tr>${titles}</tr></thead><tbody>${lines.join("")}</tbody></table></div>${more}`;
}

const clip = (text, css = "") => `<span class="${css}" title="${esc(text)}">${esc(text.length > 120 ? text.slice(0, 120) + "…" : text)}</span>`;

const dropButton = (ids, dropping) =>
	`<button data-act="drop" data-dropped="${dropping ? 1 : 0}" data-ids="${esc(JSON.stringify(ids))}">${dropping ? "Drop" : "Restore"}</button>`;

/** Chips that choose the value of state[key]. Each is [label, count, value]. */
const chips = (key, list) =>
	list.map(([label, count, value]) => `<button${value === state[key] ? ' class="on"' : ""} data-act="pick" data-key="${key}" data-value="${value}">${label} ${count}</button>`).join("");

/** The colour of the status of a task or an agent. */
const statusCss = (status) => (/run|progress/.test(status) ? "warn" : /complete|done/.test(status) ? "good" : /error|fail|abort|stop|cancel/.test(status) ? "bad" : "muted");

/** As commandStatus() of src/analyze.ts. */
const commandStatus = (command) => (command.ok == null ? "unknown" : command.ok ? "ok" : "failed");

/** As isSlow() of src/analyze.ts: the run took ten seconds or more. */
const isSlow = (command) => (command.ms ?? 0) >= 10_000;

/** As commandRows() of src/analyze.ts: the indexes of the commands that the lens lets through, in its order. */
function commandRows(commands, lens) {
	const text = lens.text?.toLowerCase();
	const rows = commands
		.map((_, index) => index)
		.filter((index) => {
			const command = commands[index];
			if (lens.status && commandStatus(command) !== lens.status) return false;
			if (lens.slow && !isSlow(command)) return false;
			if (lens.program && !command.programs.includes(lens.program)) return false;
			return !text || command.command.toLowerCase().includes(text);
		});
	return lens.slowest ? rows.sort((a, b) => (commands[b].ms ?? -1) - (commands[a].ms ?? -1)) : rows;
}

/** The attribute that carries parts of a lens to the actions "lens" and "go". */
const lensData = (parts) => `data-lens="${esc(JSON.stringify(parts))}"`;

/** Sets what Command Executions lists. The filter box shows the text of the lens. */
function setLens(lens) {
	state.lens = lens;
	$("command-filter").value = lens.text ?? "";
}

/** As commandShape() of src/analyze.ts: the lines of a command, and whether it holds a heredoc or a script given to an interpreter on the command line. */
const commandShape = (text) => ({
	lines: text.split("\n").length,
	heredoc: /(?<!<)<<(?!<)-?\s*['"]?\w/.test(text),
	inline: /(?:^|[\s;|&(])(?:python[\d.]*|node|bun|deno|perl|ruby|bash|sh|zsh)\s+(?:-\w+\s+)*(?:-c|-e|--eval)\s/.test(text),
});

/** As readiness() of src/fleet.ts: whether a pending task can start, or waits for other tasks. */
const readiness = (item) => (item.agent || item.state !== "pending" ? undefined : item.blockedBy.length > 0 ? "blocked" : "ready");

/** Index of the run with the longest wall time; -1 when no run has one. */
function slowest(commands) {
	let index = -1;
	commands.forEach((command, i) => {
		if (command.ms != null && (index < 0 || command.ms > commands[index].ms)) index = i;
	});
	return index;
}

const missText = (miss) => `≈${tok(miss.tokens)} tokens billed again, ≈${cost(miss.cost)} extra, after ${dur(miss.idleMs)} without a request`;

/** Number of a request to its place among the requests of its human input: { input, step, steps }. */
let placed = new Map();
/** The coordinate of request `n`: "#12 · 3.2" for step 2 of human input 3. Only the number when the place is not known. */
const coord = (n) => (placed.get(n) ? `#${n} · ${placed.get(n).input}.${placed.get(n).step}` : `#${n}`);
/** The long form of a coordinate. */
const placeText = (place) => `input ${place.input}, step ${place.step} of ${place.steps}`;
/** A link that names request `n` by its coordinate. `attrs` are the attributes of its action; the tooltip tells `tip` and the long form of the coordinate. */
const requestLink = (n, attrs, tip) => `<a class="tok" ${attrs} title="${esc([tip, placed.get(n) && placeText(placed.get(n))].filter(Boolean).join(": "))}">${coord(n)}</a>`;

// The cards of the Context page. Each returns HTML for the data `d` of a session.

function statsCard(d) {
	const compactions = d.events.filter((event) => event.kind === "compaction").length;
	const failed = d.commands.filter((command) => command.ok === false).length;
	const edited = d.files.filter((file) => file.edits > 0).length;
	const misses = d.cache.misses ? `${d.cache.misses} misses, ≈${cost(d.cache.cost)} extra` : "no misses";
	// The session with its subagents.
	const { own, agents } = d.family;
	const family = (text) => (agents.count ? `${text} with ${agents.count === 1 ? "the subagent" : `${agents.count} subagents`}` : "");
	const timing = d.timing;
	const top = tiles([
		[d.userInputs, "Human inputs", "", "turns"],
		[d.requests.length, "Requests", "", "trend"],
		[d.toolCalls, "Tool calls", `${d.toolErrors} errors`, "tools"],
		[tok(own.tokens), "Tokens", family(tok(d.family.tokens)), "tokens"],
		[cost(own.cost), "Cost", family(cost(d.family.cost)), "models"],
		[pct(d.cache.rate, 1), "Read from cache", misses, "tokens"],
		[d.events.length, "Context events", `${compactions} compactions`, "events", compactions ? `data-key="kind" data-value="compaction"` : ""],
		...(d.commands.length ? [[d.commands.length, "Commands", `${failed} failed`, "commands", failed ? lensData({ status: "failed" }) : ""]] : []),
		...(d.files.length ? [[d.files.length, "Files", `${edited} edited`, "files", edited ? `data-key="fileKind" data-value="edits"` : ""]] : []),
		...(agents.count ? [[agents.count, "Subagents", `${d.fleet.running} running`, "agents"]] : []),
		// The reply streams that pi-context timed.
		...(timing.streamed ? [[secs(timing.ttftMs / timing.streamed), "To the first token", `average of ${timing.streamed} requests`, "timing"]] : []),
		...(d.tps == null ? [] : [[Math.round(d.tps), "Output tokens per second", "after the first token", "timing"]]),
	]);
	const money = (dollars) => "$" + Number(dollars.toFixed(4));
	const rate = ([model, rates]) =>
		`<span class="pill">${esc(model)} <b>${money(rates.input)} input · ${money(rates.output)} output · ${money(rates.cacheRead)} cache read · ${money(rates.cacheWrite)} cache write</b></span>`;
	const rates = Object.entries(d.rates).map(rate);
	const prices = rates.length ? `<div class="pills"><span class="muted">Prices per million tokens</span>${rates.join("")}</div>` : "";
	const link = (to, text) => `<a data-act="go" data-to="${to}" title="Go to the card">${text}</a>`;
	return (
		top +
		pills(link("tools", "Tools"), d.tools.map((tool) => [tool.name, tool.calls + tool.nested]), 8, (name) => `data-act="go" data-to="tools" data-name="${esc(name)}" title="Show the tool in its card"`) +
		pills(link("commands", "Programs"), d.programs.map((program) => [program.program, program.uses]), 8, (name) => `data-act="go" data-to="commands" ${lensData({ program: name })} title="List the runs of the program"`) +
		prices
	);
}

function tokensCard(d) {
	const totals = d.totals;
	const head = pairs([
		["Input", tok(totals.input)],
		["Cache read", tok(totals.cacheRead)],
		["Cache write", tok(totals.cacheWrite)],
		["Output", tok(totals.output)],
	]);
	if (!d.billedRequests) return head + `<p class="muted">pi-context recorded no request of this session, so the split by category is not known.</p>`;
	const parts = catParts(d.billed);
	const note = `Sent over the session, by category: ${d.billedRequests} of ${d.requests.length} requests, those recorded by pi-context. Each request sends the whole context again.`;
	return `${head}<div class="split">${donut(parts, tok(totalOf(d.billed)), "sent")}${legend(parts)}</div><p class="muted">${note}</p>`;
}

function timingCard(d) {
	const timing = d.timing;
	if (!timing.activeMs) return `<p class="muted">pi-context recorded no turn of this session.</p>`;
	const part = (label, value, color) => ({ label, value, color, text: dur(value) });
	const parts = [
		part("Model calls", timing.modelMs, COLORS.toolCalls),
		part("Tool runs", timing.toolMs, COLORS.toolResults),
		part("Overhead", Math.max(0, timing.activeMs - timing.modelMs - timing.toolMs), "#9ca3af"),
	];
	const split = `<div class="split">${donut(parts, dur(timing.activeMs), "active")}${legend(parts)}</div>`;
	if (!timing.streamed) return split;
	// The reply streams that pi-context timed: the wait for the first token, the speed after it, and the time that each part of the replies took.
	const spans = ["reasoning", "toolCalls", "answers"].map((kind) => {
		const [ms, blocks] = timing.spans[kind];
		return { label: labels[kind], color: COLORS[kind], value: ms, text: `${secs(ms)} in ${blocks} ${blocks === 1 ? "block" : "blocks"}` };
	});
	const whole = spans.reduce((sum, span) => sum + span.value, 0);
	const facts = pairs([
		["Timed", `${timing.streamed} of ${d.requests.length} requests`],
		["To the first token", `${secs(timing.ttftMs / timing.streamed)} on average`],
		...(d.tps == null ? [] : [["Output", `${Math.round(d.tps)} tokens per second`]]),
	]);
	const bar = spans.map((span) => `<i style="width:${(span.value / whole) * 100}%;background:${span.color}" title="${esc(span.label)} ${esc(span.text)}"></i>`);
	return `${split}<h3>Reply streams</h3>${facts}${whole ? `<div class="bar">${bar.join("")}</div>${legend(spans)}` : ""}`;
}

/**
 * Gives each node a rectangle of the area x, y, w, h, in proportion to its value: halves the nodes by value along the longer side, and each half again.
 * The nodes come largest first. `put` gets each node with its rectangle.
 */
function layout(nodes, x, y, w, h, put) {
	if (nodes.length === 1) return put(nodes[0], x, y, w, h);
	const total = nodes.reduce((sum, node) => sum + node.value, 0);
	let cut = 1;
	let first = nodes[0].value;
	while (cut < nodes.length - 1 && first + nodes[cut].value <= total / 2) first += nodes[cut++].value;
	const share = first / total;
	if (w >= h) {
		layout(nodes.slice(0, cut), x, y, w * share, h, put);
		layout(nodes.slice(cut), x + w * share, y, w * (1 - share), h, put);
	} else {
		layout(nodes.slice(0, cut), x, y, w, h * share, put);
		layout(nodes.slice(cut), x, y + h * share, w, h * (1 - share), put);
	}
}

/** The context as a treemap: one area for each category, divided into its items. A click on an item opens it in the Context Browser. */
function treemap(rows, factor) {
	const groups = CATS.map((cat) => {
		const items = rows.map((row, i) => ({ row, i, value: row.tokens })).filter((item) => item.row.cat === cat && item.value > 0);
		return { items: items.sort((a, b) => b.value - a.value), value: items.reduce((sum, item) => sum + item.value, 0) };
	}).filter((group) => group.value > 0);
	if (groups.length === 0) return "";
	const cells = [];
	// The rectangles are in percent of the height; an area that is large enough shows the label of its item.
	const cell = ({ row, i }, x, y, w, h) =>
		cells.push(
			`<i data-act="cell" data-i="${i}" style="left:${x / MAP_RATIO}%;top:${y}%;width:${w / MAP_RATIO}%;height:${h}%;background:${COLORS[row.cat]}" title="#${i + 1} ${esc(labels[row.cat])} · ${esc(row.label)} · ≈${tok(row.tokens * factor)}">${w > 20 && h > 12 ? esc(row.label) : ""}</i>`,
		);
	layout(groups.sort((a, b) => b.value - a.value), 0, 0, 100 * MAP_RATIO, 100, (group, x, y, w, h) => layout(group.items, x, y, w, h, cell));
	return `<div class="map">${cells.join("")}</div>`;
}
function currentCard(d) {
	const sums = sumBy(d.current);
	const size = d.usage?.tokens ?? totalOf(sums) * d.factor;
	const window = d.usage?.contextWindow || 0;
	const parts = catParts(sums, d.factor);
	const used = window
		? `<span><b class="big">${d.usage.percent == null ? "?" : d.usage.percent.toFixed(1) + "%"}</b> of the window used</span>`
		: `<span class="muted">The size of the window is not known.</span>`;
	const bar = parts.map((p) => `<i style="width:${(p.value / (window || size || 1)) * 100}%;background:${p.color}" title="${esc(p.label)} ${p.text}"></i>`);
	const note = `≈ figures are sizes at 4 characters per token, scaled by ${d.factor.toFixed(2)} to add up to the provider-reported size.`;
	// The end of the window that pi keeps free: it starts compaction when the context grows into it.
	const reserve = window ? d.reserve : undefined;
	const start = reserve?.compaction > 0 && reserve.compaction < window ? window - reserve.compaction : undefined;
	const tail = start == null ? "" : `<u style="width:${(reserve.compaction / window) * 100}%" title="Reserve of ${tok(reserve.compaction)} tokens: compaction starts at ${tok(start)}"></u>`;
	const room = start == null ? "" : start >= size ? `${tok(start - size)} tokens left before it` : `the context is ${tok(size - start)} tokens over it`;
	const limits = [
		start == null ? "" : `Compaction starts at ${tok(start)} tokens, the window less a reserve of ${tok(reserve.compaction)} (hatched): ${room}.`,
		reserve?.output ? `Output limit of the model: ${tok(reserve.output)} tokens.` : "",
	].filter(Boolean);
	const kept = limits.length ? `<p>${limits.join(" ")}</p>` : "";
	const shape = state.treemap ? treemap(d.current, d.factor) : `<div class="bar">${bar.join("")}${tail}</div>`;
	return `<div class="between"><span><b class="big">${tok(size)}</b>${window ? " / " + tok(window) : ""} tokens</span>${used}</div>${shape}${kept}${legend(parts)}<p class="muted">${note}</p>`;
}

function trendCard(d) {
	const all = d.trend;
	if (all.length === 0) return `<p class="muted">No requests yet.</p>`;
	const { byTurn, delta, fit, last, whole } = state.trend;
	// The view default can keep the trend to its last bars.
	const hidden = last && !whole ? Math.max(0, all.length - last) : 0;
	const bars = all.slice(hidden);
	// What a bar adds above the base line, and what it takes away below the line.
	const sides = (bar) => {
		const values = bar.parts ? CATS.map((cat) => bar.parts[cat]) : [bar.value];
		return [values.reduce((sum, value) => sum + Math.max(0, value), 0), values.reduce((sum, value) => sum - Math.min(0, value), 0)];
	};
	const up = Math.max(...bars.map((bar) => sides(bar)[0]), 1);
	const down = Math.max(...bars.map((bar) => sides(bar)[1]), 0);
	// The longest duration fills the strip under the bars.
	const longest = Math.max(...bars.map((bar) => bar.ms ?? 0));
	const column = (bar, i) => {
		const request = d.requests[bar.index];
		const input = byTurn ? d.inputs[bar.n - 1] : undefined;
		// The requests that the bar stands for: one, or those of the human input.
		const covered = d.requests.slice((all[hidden + i - 1]?.index ?? -1) + 1, bar.index + 1);
		// An event is marked on the first bar after it.
		const marks = bar.marks ?? [];
		const mark = MARKS[d.markKinds.find((kind) => marks.includes(kind))]?.[0];
		const miss = covered.find((r) => r.miss)?.miss;
		const [more, less] = sides(bar);
		const stack = (sign) =>
			bar.parts
				? CATS.filter((cat) => sign * bar.parts[cat] > 0).map((cat) => `<i style="flex:${sign * bar.parts[cat]};background:${COLORS[cat]}"></i>`).join("")
				: `<i style="flex:1;background:#9ca3af"></i>`;
		const half = (size, most, sign) =>
			`<div class="half" style="flex:${most}">${size > 0 ? `<div class="stack" style="flex:0 0 ${(size / most) * 100}%">${stack(sign)}</div>` : ""}</div>`;
		const tip = [
			input ? `input #${input.n} · ${input.requests} requests · ${input.preview}` : "",
			`${coord(request.n)} · ${clock(request.time)} · ${request.model}`,
			delta ? `change ${bar.value < 0 ? "−" : "+"}${tok(Math.abs(bar.value))}` : "",
			`sent ${tok(request.context)}, ${pct(request.cacheRead, request.context)} from cache · output ${tok(request.output)} · ${cost(request.cost)}`,
			bar.ms == null ? "" : `took ${dur(bar.ms)}`,
			request.ttft == null ? "" : `first token after ${secs(request.ttft)}`,
			marks.length ? `marks: ${marks.map((kind) => MARKS[kind]?.[1] ?? kind).join(", ")}` : "",
			miss ? "cache miss: " + missText(miss) : "",
		];
		const on = covered.some((r) => r.n === state.request);
		return `<div class="col${on ? " on" : ""}" data-act="request" data-n="${request.n}" title="${esc(tip.filter(Boolean).join("\n"))}"><b>${mark ?? (miss ? "!" : "")}</b>${half(more, up, 1)}${down ? half(less, down, -1) : ""}${longest ? `<u style="--h:${((bar.ms ?? 0) / longest) * 100}%"></u>` : ""}</div>`;
	};
	// The selected request: what the provider reported, and the estimates of pi-context with the categories.
	const picked = d.requests.find((request) => request.n === state.request);
	const reported = picked
		? pairs([[`${coord(picked.n)}, provider-reported`, ""], ["Input", tok(picked.input)], ["Cache read", tok(picked.cacheRead)], ["Cache write", tok(picked.cacheWrite)], ["Output", tok(picked.output)]])
		: "";
	// Where the request stands among the requests of its human input, and how long its first token took.
	const where = picked ? placePairs(picked, state.view?.place) : [];
	// As in the bars, the recorded composition is scaled to the size that the provider reported.
	const recorded = picked?.sums ? CATS.reduce((total, cat) => total + (picked.sums[cat] ?? 0), 0) : 0;
	const estimate = (cat) => (recorded > 0 ? ` ≈${tok(((picked.sums[cat] ?? 0) * picked.context) / recorded)}` : "");
	const key = CATS.map((cat) => `<span class="pill"><i class="dot" style="background:${COLORS[cat]}"></i> ${esc(labels[cat])}${estimate(cat)}</span>`).join("");
	const what = `${delta ? "The change of the tokens sent since the bar before: growth above the line, the rest below it. One bar for" : "Tokens sent by"} ${byTurn ? "the last request of each human input" : "each request"}.`;
	// The marks that the bars on show have.
	const seen = d.markKinds.filter((kind) => MARKS[kind] && bars.some((bar) => bar.marks?.includes(kind))).map((kind) => MARKS[kind].join(" "));
	if (d.requests.some((request) => request.miss)) seen.push("! cache miss");
	const glyphs = seen.length ? ` Marks: ${seen.join(", ")}. A bar shows the first of its marks; its tooltip lists all.` : "";
	const some = hidden ? `The last ${bars.length} of ${all.length} bars.` : `All ${all.length} bars.`;
	const cut = last && all.length > last ? `<p class="muted">${some} <a data-act="bars">${hidden ? "Show all" : `Show the last ${last}`}</a></p>` : "";
	const note = `${what} Click a bar to open the request in the Context Browser. Grey: not recorded by pi-context.${glyphs}${longest ? ` The strip under a bar is its duration: the longest took ${dur(longest)}.` : ""}${picked?.sums ? ` ≈ figures: the estimated composition of request ${coord(picked.n)}.` : ""}`;
	const axis = `<div class="axis${longest ? " timed" : ""}"><span>${delta ? "+" : ""}${tok(up)}</span><span>${down ? "−" + tok(down) : 0}</span></div>`;
	// What the selected request did. Each line opens what it tells of in the Context Browser.
	const brief = state.view?.brief;
	const line = (name, text, act, title) => `<div ${act} title="${title}"><b>${name}</b><span>${esc(text)}</span></div>`;
	const told = brief
		? `<div class="brief">${line("User", brief.user, brief.first == null ? "" : `data-act="request" data-n="${d.requests[brief.first]?.n}"`, "Open the first request of the human input")}${line("In", brief.added, `data-act="added"`, "Show the first item added since the request before")}${line("Out", brief.reply, `data-act="reply"`, "Show the answer in the context of the next request")}</div>`
		: "";
	return `<div class="trend">${axis}<div class="cols${fit ? " fit" : ""}" data-keep="trend">${bars.map(column).join("")}</div></div>${cut}${told}${where.length ? pairs(where) : ""}${reported}<div class="pills">${key}</div><p class="muted">${note}</p>`;
}

/** Number of the first request that carried the row: the first one made after the message of the row was created. */
const firstRequest = (row) => (row.time == null ? undefined : state.data.requests.find((request) => request.time > row.time)?.n);

/** The pairs that tell where a request stands among the requests of its human input, and how long its first token took. */
const placePairs = (request, place) => [
	...(place ? [["Place", placeText(place)]] : []),
	...(request.ttft == null ? [] : [["To the first token", secs(request.ttft)]]),
];

/** The row of item `i` of the context that the browser shows. */
const shownRow = (i) => (state.request == null ? state.data.current : state.view?.rows)?.[i];

/** The text as formatted JSON, when it is a JSON object or array. */
function prettyJson(text) {
	if (!/^\s*[[{]/.test(text ?? "")) return undefined;
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return undefined;
	}
}

/**
 * Escapes text and marks what matches `needle`, whatever the case: `mark` makes the HTML of a piece of text.
 * `count` is the number of matches marked so far; match number `at` is the current one.
 */
function finder(needle) {
	const pattern = needle ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi") : null;
	const found = { count: 0, at: -1 };
	found.mark = (text) => {
		if (!pattern) return esc(text);
		let html = "";
		let end = 0;
		for (const match of text.matchAll(pattern)) {
			html += `${esc(text.slice(end, match.index))}<mark${found.count++ === found.at ? ' class="at"' : ""}>${esc(match[0])}</mark>`;
			end = match.index + match[0].length;
		}
		return html + esc(text.slice(end));
	};
	return found;
}

/**
 * Text as HTML with the headings, code fences, lists and inline code of Markdown. Any other line is a paragraph.
 * `mark` escapes every piece of the text; no part of the text reaches the page as HTML.
 */
function markdown(text, mark) {
	const inline = (line) => line.split(/(`[^`]+`)/).map((part, i) => (i % 2 ? `<code>${mark(part.slice(1, -1))}</code>` : mark(part))).join("");
	const out = [];
	/** The lines of the open code fence, and the tag of the open list. */
	let fence;
	let list = "";
	const close = () => {
		if (list) out.push(`</${list}>`);
		list = "";
	};
	for (const line of text.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) {
			close();
			if (fence) out.push(`<pre>${mark(fence.join("\n"))}</pre>`);
			fence = fence ? undefined : [];
			continue;
		}
		if (fence) {
			fence.push(line);
			continue;
		}
		const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
		if (item) {
			const tag = /\d/.test(item[1]) ? "ol" : "ul";
			if (list !== tag) {
				close();
				out.push(`<${tag}>`);
				list = tag;
			}
			out.push(`<li>${inline(item[2])}</li>`);
			continue;
		}
		close();
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		// The headings are those of an item, not of the page: levels 4 to 6.
		if (heading) out.push(`<h${Math.min(6, heading[1].length + 3)}>${inline(heading[2])}</h${Math.min(6, heading[1].length + 3)}>`);
		else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
	}
	if (fence) out.push(`<pre>${mark(fence.join("\n"))}</pre>`);
	close();
	return out.join("");
}

/**
 * The content of the opened item `i`: as text, as Markdown, or as formatted JSON when it is JSON; with a button that copies it,
 * and a find box whose matches are marked. `entry` is what state.texts has for the item.
 */
function viewer(key, i, entry) {
	const { mode, find = "", at = 0 } = state.viewers.get(key) ?? {};
	const modes = [["text", "Text"], ["markdown", "Markdown"], ...(entry.json ? [["json", "JSON"]] : [])];
	const picked = modes.some(([value]) => value === mode) ? mode : "text";
	const shown = picked === "json" ? entry.json : entry.text;
	const draw = (mark) => (picked === "markdown" ? `<div class="md">${markdown(shown, mark)}</div>` : `<pre>${mark(shown)}</pre>`);
	const found = finder(find);
	// The first pass counts the matches: a step past the last match goes to the first.
	if (find) draw(found.mark);
	const count = found.count;
	found.at = count ? ((at % count) + count) % count : -1;
	found.count = 0;
	const buttons = modes.map(([value, label]) => `<button${value === picked ? ' class="on"' : ""} data-act="mode" data-i="${i}" data-mode="${value}">${label}</button>`);
	const step = (by, label, tip) => `<button data-act="find" data-i="${i}" data-by="${by}"${count ? "" : " disabled"} title="${tip}">${label}</button>`;
	const matches = find ? `<span class="muted">${count ? `${found.at + 1} of ${count}` : "No match"}</span>` : "";
	const box = `<input type="search" data-find="${i}" data-focus="find${i}" placeholder="Find" value="${esc(find)}">${step(-1, "‹", "Previous match")}${step(1, "›", "Next match")}${matches}`;
	return `<div class="viewer">${buttons.join("")}<button data-act="copy" data-i="${i}" title="Copy what is shown">Copy</button>${box}</div>${draw(found.mark)}`;
}
/** One item of the context. With `flat`, the item is in a list of all categories and shows its category. */
function itemHtml({ row, i, mark }, factor, canDrop, flat) {
	const key = keyOf(row);
	const open = state.openItems.has(key);
	const button = canDrop && row.id ? dropButton([row.id], !row.dropped) : "";
	const from = firstRequest(row);
	const first = from == null ? "" : `<span class="from" title="Request ${coord(from)} was the first to carry this item">@${from}</span>`;
	const category = flat ? `<i class="dot" style="background:${COLORS[row.cat]}" title="${esc(labels[row.cat])}"></i>` : "";
	const line = `<div class="item${row.dropped ? " dropped" : ""}${flat ? " flat" : ""}" data-act="item" data-i="${i}"><span class="mark">${mark}</span><span class="pos" title="Position in the prompt">#${i + 1}</span>${category}<span class="lbl">${esc(row.label)}</span><span class="pv">${esc(row.preview)}</span>${first}${button}<span class="tok">≈${tok(row.tokens * factor)}</span></div>`;
	if (!open) return line;
	const entry = state.texts.get(key);
	const call = entry?.call;
	// A tool result comes with its call: the tool, the outcome, the size of the result and the arguments.
	const badge = call?.status === "error" ? `<span class="bad">error</span>` : `<span class="good">OK</span>`;
	const about = call ? `<div class="call"><b>${esc(call.tool)}</b>${badge}<span class="muted">${call.lines} ${call.lines === 1 ? "line" : "lines"}</span></div>` : "";
	const args = call?.args == null ? "" : `<small class="cap">Arguments</small><pre>${esc(call.args)}</pre><small class="cap">Result</small>`;
	return `${line}${about}${args}${entry ? viewer(key, i, entry) : "<pre>Loading…</pre>"}`;
}

/** The tools that the request of the browser declared, one row for each: the name, who provides it, the calls of the request, the size of the schema. A row opens what pi knows about the tool. */
function declaredHtml(view) {
	const needle = state.declFind.trim().toLowerCase();
	const orders = { size: (a, b) => b.tokens - a.tokens, name: (a, b) => a.name.localeCompare(b.name), calls: (a, b) => b.calls - a.calls || b.tokens - a.tokens };
	const found = view.tools.filter((tool) => !needle || `${tool.name} ${tool.source}`.toLowerCase().includes(needle)).sort(orders[state.declOrder]);
	const row = (tool) => {
		const open = tool.name === state.tool;
		const called = tool.calls ? `<span class="warn" title="Calls of the tool in this request">called ${tool.calls}×</span>` : "";
		const line = `<div class="item" data-act="tool" data-name="${esc(tool.name)}" title="Show the description and the parameters"><span class="fold">${open ? "▾" : "▸"}</span><span class="lbl mono">${esc(tool.name)}</span><span class="pv">${esc(tool.source)}</span>${called}<span class="tok">≈${tok(tool.tokens * view.factor)}</span></div>`;
		return open ? line + toolAbout() : line;
	};
	const sorts = [["size", "Size", "Largest schema first"], ["name", "Name", "By name"], ["calls", "Calls", "Most calls in this request first"]]
		.map(([value, label, tip]) => `<button${value === state.declOrder ? ' class="on"' : ""} data-act="pick" data-key="declOrder" data-value="${value}" title="${tip}">${label}</button>`)
		.join("");
	const bar = `<div class="viewer"><b>Declared tools</b><input type="search" data-decls data-focus="decls" value="${esc(state.declFind)}" placeholder="Search tools">${sorts}<span class="muted">${found.length} of ${view.tools.length}</span></div>`;
	return bar + (found.map(row).join("") || `<p class="muted">No tool matches.</p>`);
}

function browserCard(d) {
	const request = d.requests.find((r) => r.n === state.request);
	const view = request ? state.view : { rows: d.current, factor: d.factor };
	if (!view) return `<p class="muted">Loading…</p>`;
	const head = [];
	if (request) {
		head.push(
			pairs([
				["Request", coord(request.n)],
				["Time", clock(request.time)],
				["Model", request.model],
				["Sent", tok(request.context)],
				["From cache", pct(request.cacheRead, request.context)],
				["Output", tok(request.output)],
				["Took", request.ms == null ? "?" : dur(request.ms)],
				["Cost", cost(request.cost)],
				...placePairs(request, view.place),
			]),
		);
		if (request.miss) head.push(`<p class="warn">Cache miss: ${missText(request.miss)}.</p>`);
		if (view.rebuilt) head.push(`<p class="muted">Rebuilt from the session: pi-context has no record of what this request sent.</p>`);
		if (view.marks) {
			const count = (mark) => view.marks.filter((m) => m === mark).length;
			const base = view.base === "input" ? "the last request before the human input" : "the request before";
			head.push(pairs([["Compared with", `${coord(view.since)}, ${base}`], ["+ added", count("+")], ["~ changed", count("~")], ["− removed", view.removed.length]]));
		} else {
			head.push(`<p class="muted">No request ${view.base === "input" ? "before the human input" : "before this one"} to compare with.</p>`);
		}
	} else {
		head.push(`<p class="muted">${d.readOnly ? "The context after the last request." : "What the next request is assembled from."}</p>`);
	}
	const needle = $("filter").value.trim().toLowerCase();
	const order = $("order").value;
	const bySize = order === "size";
	// The parts of the replies: a chip keeps only the items of its part.
	const kind = state.reply;
	const replies = request ? view.replies : d.replies;
	if (replies) {
		const list = [["All", view.rows.length, ""], ["Thinking", replies.reasoning, "reasoning"], ["Tool calls", replies.toolCalls, "toolCalls"], ["Answers", replies.answers, "answers"]];
		head.push(`<div class="controls">${chips("reply", list)}</div>`);
	}
	const passes = (row) => (!kind || row.cat === kind) && (!needle || `${row.label} ${row.preview}`.toLowerCase().includes(needle));
	// The list of what the request added and changed leaves the other items out.
	const changes = order === "added";
	const items = view.rows.map((row, i) => ({ row, i, mark: view.marks?.[i] ?? "" })).filter(({ row, mark }) => passes(row) && (!changes || mark));
	const all = totalOf(sumBy(view.rows));
	const canDrop = !request && !d.readOnly;
	// One band for each item, in reading order. Its width is the share of the item.
	const band = (row, i) =>
		`<i${passes(row) ? "" : ' class="off"'} data-act="band" data-i="${i}" style="flex-grow:${row.tokens};background:${COLORS[row.cat]}" title="#${i + 1} ${esc(labels[row.cat])} · ${esc(row.label)} · ≈${tok(row.tokens * view.factor)}"></i>`;
	if (all > 0) head.push(`<div class="strip">${view.rows.map(band).join("")}</div>`);
	// What the category gained or lost since the request before.
	const badge = (cat) => {
		const change = view.delta?.[cat] ?? 0;
		const count = view.items?.[cat] ?? 0;
		if (!change && !count) return "";
		const size = change ? `≈${change > 0 ? "+" : "−"}${tok(Math.abs(change) * view.factor)}` : "";
		const number = count ? `${count > 0 ? "+" : "−"}${Math.abs(count)} ${Math.abs(count) === 1 ? "item" : "items"} ` : "";
		return `<span class="${change > 0 || (!change && count > 0) ? "warn" : "good"}">${number}${size}</span>`;
	};
	const gone = (row) =>
		`<div class="item"><span class="mark bad">−</span><span class="lbl">${esc(row.label)}</span><span class="pv">${esc(row.preview)}</span><span class="tok">≈${tok(row.tokens * view.factor)}</span></div>`;
	const removed = view.removed?.length ? `<h3>No longer in the request (${view.removed.length})</h3>${view.removed.slice(0, MAX_LIST).map(gone).join("")}` : "";
	if (order === "flat" || changes) {
		const badges = CATS.filter(badge).map((cat) => `<span class="pill"><i class="dot" style="background:${COLORS[cat]}"></i> ${esc(labels[cat])} ${badge(cat)}</span>`);
		if (badges.length > 0) head.push(`<div class="pills">${badges.join("")}</div>`);
		const list = items.map((item) => itemHtml(item, view.factor, canDrop, true)).join("");
		const none = !changes || needle || kind ? "Nothing matches." : !request ? "Select a request to see what it added and changed." : view.marks ? "The request added and changed nothing." : "";
		return head.join("") + (list || `<p class="muted">${none}</p>`) + removed;
	}
	const groups = CATS.map((cat) => {
		const own = items.filter((item) => item.row.cat === cat);
		if (own.length === 0) return "";
		if (bySize) own.sort((a, b) => b.row.tokens - a.row.tokens);
		const tokens = own.reduce((sum, item) => sum + item.row.tokens, 0);
		// A filter shows what it found.
		const open = needle || kind ? true : state.openCats.has(cat);
		const delta = badge(cat);
		const title = `<div class="cat" data-act="cat" data-cat="${cat}"><span>${open ? "▾" : "▸"}</span><i class="dot" style="background:${COLORS[cat]}"></i><b>${esc(labels[cat])} <small>${own.length} items</small></b>${delta}<span class="tok">≈${tok(tokens * view.factor)}</span><span class="share">${pct(tokens, all)}</span></div>`;
		// The tool declarations list the tools that the request declared, when pi-context recorded them.
		const declared = cat === "tools" && view.tools?.length ? declaredHtml(view) : "";
		return open ? title + own.map((item) => itemHtml(item, view.factor, canDrop)).join("") + declared : title;
	});
	return head.join("") + (groups.join("") || `<p class="muted">Nothing matches.</p>`) + removed;
}

function hintsCard(d) {
	const free = d.hints.reduce((sum, hint) => sum + (hint.kind === "nested" ? 0 : hint.tokens), 0);
	const rows = d.hints.map((hint) => [
		esc(hint.kind),
		`${esc(hint.label)}<br><small>${esc(hint.detail)}</small>`,
		// The size of a file that scripts read is an upper bound: a script may return only part of it.
		hint.kind === "nested" ? (hint.tokens ? "up to ≈" + tok(hint.tokens * d.factor) : "size unknown") : "≈" + tok(hint.tokens * d.factor),
		hint.ids?.length && !d.readOnly ? dropButton(hint.ids, true) : "",
	]);
	const dropped = d.dropped.map((row) => [esc(row.label), clip(row.preview), "≈" + tok(row.tokens * d.factor), d.readOnly || !row.id ? "" : dropButton([row.id], false)]);
	const total = d.hints.length ? `<p>Dropping all of it would free ≈${tok(free * d.factor)} tokens. Files that scripts read more than once are not counted.</p>` : "";
	const list = table(["Kind", "What", ">Tokens", ""], rows, "Nothing to drop.");
	return total + list + (dropped.length ? "<h3>Dropped tool results</h3>" + table(["Tool", "Content", ">Tokens", ""], dropped) : "");
}

function turnsCard(d) {
	// The wait for the user's answers to questions has a column when an input waited.
	const waited = d.inputs.some((input) => input.waitMs != null);
	const rows = [...d.inputs].reverse().map((input) => [
		input.first >= 0 ? requestLink(d.requests[input.first].n, `data-act="request" data-n="${d.requests[input.first].n}"`, "Open the first request of the input in the Context Browser") : `<span class="muted">input ${input.n}</span>`,
		clock(input.time),
		clip(input.preview),
		input.requests,
		input.toolCalls,
		tok(input.sent),
		tok(input.output),
		cost(input.cost),
		dur(input.ms),
		...(waited ? [input.waitMs == null ? "" : dur(input.waitMs)] : []),
	]);
	const note = waited ? `<p class="muted">Waited: the time that the input waited for the answers of the user to questions. Took does not include it.</p>` : "";
	return table(["Request", "Time", "Input", ">Requests", ">Tools", ">Sent", ">Output", ">Cost", ">Took", ...(waited ? [">Waited"] : [])], rows, "No input yet.") + note;
}

function eventsCard(d) {
	if (d.events.length === 0) return `<p class="muted">No injection, compaction, drop, question, delegation, task, model or branch events on this branch.</p>`;
	const counts = new Map();
	for (const event of d.events) counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
	const kind = counts.has(state.kind) ? state.kind : "";
	const chip = (name, count, value) => `<button${value === kind ? ' class="on"' : ""} data-act="kind" data-kind="${esc(value)}">${esc(name)} ${count}</button>`;
	const chips = [chip("all", d.events.length, ""), ...[...counts].map(([name, count]) => chip(name, count, name))];
	const shown = d.events.filter((event) => !kind || event.kind === kind);
	// A negative change frees context.
	const change = (delta) => (delta == null ? "" : `<span class="${delta < 0 ? "good" : "warn"}">≈${delta < 0 ? "−" : "+"}${tok(Math.abs(delta))}</span>`);
	const sized = shown.filter((event) => event.delta != null);
	const net = sized.length ? change(sized.reduce((sum, event) => sum + event.delta, 0)) : "not known";
	const where = (event) => (event.after ? requestLink(event.after, `data-act="request" data-n="${event.after}"`, "Open the request in the Context Browser") : "start");
	// A compaction tells how many messages its summary replaced, and their estimated size.
	const detail = (event) =>
		esc(event.detail) + (event.replaced == null ? "" : ` <small>${event.replaced} ${event.replaced === 1 ? "message" : "messages"} replaced${event.removed == null ? "" : `, about ${tok(event.removed)} tokens`}</small>`);
	// The injections by the extension message type or the skill that made them, largest first.
	const sums = new Map();
	for (const event of shown) {
		if (event.producer == null) continue;
		const sum = sums.get(event.producer) ?? [0, 0];
		sums.set(event.producer, [sum[0] + 1, sum[1] + (event.delta ?? 0)]);
	}
	const by = [...sums].sort((a, b) => b[1][1] - a[1][1]).map(([producer, [count, tokens]]) => [esc(producer), count, "≈" + tok(tokens)]);
	return (
		`<div class="controls">${chips.join("")}</div><p>Net change of the context: ${net}</p>` +
		(by.length ? table(["Injected by", ">Events", ">Tokens"], by) : "") +
		table(
			["Time", "After", "Kind", ">Change", "Detail"],
			shown.map((event) => [clock(event.time), where(event), esc(event.kind), change(event.delta), detail(event)]),
		)
	);
}

function filesCard(d) {
	const ops = (file) => FILE_KINDS.reduce((sum, [kind]) => sum + file[kind], 0);
	const last = (file) => file.ops.reduce((time, op) => Math.max(time, op.time), 0);
	const names = Object.fromEntries(FILE_KINDS.map(([kind, , name]) => [kind, name]));
	// The orders of fileRows() of src/analyze.ts.
	const orders = { ops: (a, b) => ops(b) - ops(a), recent: (a, b) => last(b) - last(a), name: (a, b) => a.path.localeCompare(b.path), lines: (a, b) => b.added + b.removed - (a.added + a.removed) };
	const kind = state.fileKind;
	// With "As of the request", the files as they were after the request of the Context Browser.
	const then = state.asOf && state.then?.n === state.request ? state.then.files : undefined;
	const files = then ?? d.files;
	const needle = $("file-filter").value.trim().toLowerCase();
	const kinds = chips("fileKind", [["All", files.length, ""], ...FILE_KINDS.map(([each, label]) => [label, files.filter((file) => file[each] > 0).length, each])]);
	// A read of a part of the file tells its lines.
	const part = (range) => (!range ? "" : range[1] ? ` of lines ${range[0]}–${range[0] + range[1] - 1}` : ` from line ${range[0]}`);
	const added = (n) => (n == null ? "" : `<span class="good">+${n}</span>`);
	const removed = (n) => (n == null ? "" : `<span class="bad">−${n}</span>`);
	const rows = files
		.filter((file) => (!kind || file[kind] > 0) && (!needle || file.path.toLowerCase().includes(needle)))
		.sort(orders[state.fileOrder] ?? orders.ops)
		.flatMap((file) => {
			const open = state.openFiles.has(file.path);
			const known = file.added + file.removed > 0;
			const name = `<a data-act="file" data-path="${esc(file.path)}" title="Show the operations on the file">${open ? "▾" : "▸"} ${clip(file.path, "mono")}</a>`;
			const row = [name, ...FILE_KINDS.map(([each]) => file[each] || ""), known ? added(file.added) : "", known ? removed(file.removed) : ""];
			if (!open) return [row];
			// Newest first.
			const log = [...file.ops].reverse().map((op) => {
				const result = requestLink(op.request, `data-act="result" data-n="${op.request}" data-id="${esc(op.id)}"`, "Show the tool result in the Context Browser");
				const failed = op.error ? ` <span class="bad">failed</span>` : "";
				const hits = op.hits == null ? "" : `, ${op.hits} ${op.hits === 1 ? "hit" : "hits"}`;
				return [`<span class="op">${clock(op.time)} ${result} ${names[op.op]}${part(op.range)} by ${esc(op.tool)}${hits}${failed}</span>`, "", "", "", "", "", added(op.added), removed(op.removed)];
			});
			return [row, ...log];
		});
	const note = d.unresolvedEdits ? `<p class="muted">${d.unresolvedEdits} edits by anchor could not be matched to a file.</p>` : "";
	const empty = !files.length ? "No file activity yet." : needle ? "No file matches." : "No file with such an operation.";
	const when = !state.asOf ? "" : state.request == null ? "Select a request in the Context Trend or the Context Browser to see the files as they were after it." : then ? `The files as they were after request ${coord(state.request)}. The list follows the request that the Context Trend and the Context Browser show.` : "Loading…";
	return `<div class="controls">${kinds}</div>` + (when ? `<p class="muted">${when}</p>` : "") + table(["File", ">Reads", ">Writes", ">Edits", ">Searches", ">Images", ">Added", ">Removed"], rows, empty) + note;
}

function commandsCard(d) {
	const lens = state.lens;
	// A failed run tells how it ended, when the session tells it.
	const status = (command) =>
		command.ok == null ? "" : command.ok ? `<span class="good">ok</span>` : `<span class="bad tok">${command.exit != null ? "exit " + command.exit : (STOPS[command.stopped] ?? "failed")}</span>`;
	const took = (ms) => (ms == null ? "" : secs(ms));
	const by = (command) =>
		command.id
			? requestLink(command.request, `data-act="result" data-n="${command.request}" data-id="${esc(command.id)}"`, "Show the tool result in the Context Browser")
			: `<span class="muted">user</span>`;
	// What sets a command apart: a long run, more than one line, a heredoc, a script given to an interpreter.
	const marks = (command) => {
		const shape = commandShape(command.command);
		const list = [isSlow(command) ? "slow" : "", shape.lines > 1 ? `${shape.lines} lines` : "", shape.heredoc ? "heredoc" : "", shape.inline ? "inline script" : ""];
		return list.filter(Boolean).map((mark) => `<span class="pill${mark === "slow" ? " warn" : ""}">${mark}</span> `).join("");
	};
	// An open run: how it ended, the whole command, and its output as the session holds it.
	const detail = (command, i) => {
		const output = state.outputs.get(i);
		const badges = [
			command.exit == null ? "" : `<span class="pill bad">exit ${command.exit}</span>`,
			command.stopped ? `<span class="pill bad">${STOPS[command.stopped]}</span>` : "",
			command.truncated ? `<span class="pill warn" title="pi cut the output for the model">output truncated</span>` : "",
			command.lines == null ? "" : `<span class="pill">${command.lines} ${command.lines === 1 ? "line" : "lines"} of output</span>`,
		].join("");
		const shown = !output
			? `<pre>Loading…</pre>`
			: output.error
				? `<p class="muted">${esc(output.error)}</p>`
				: output.text
					? `<pre>${esc(output.text)}</pre>`
					: `<p class="muted">The command printed nothing.</p>`;
		return `${badges ? `<div class="pills">${badges}</div>` : ""}<small class="cap">Command</small><pre>${esc(command.command)}</pre><small class="cap">Output</small>${shown}`;
	};
	const counts = { ok: 0, failed: 0, unknown: 0 };
	for (const command of d.commands) counts[commandStatus(command)]++;
	const found = commandRows(d.commands, lens);
	// The session has the oldest run first. The list has the newest first, or with the lens the slowest.
	const listed = lens.slowest ? found : found.reverse();
	// The table shows its first rows: it starts late enough to show the highlighted run.
	const skip = Math.max(0, listed.indexOf(state.run) - MAX_LIST + 1);
	const rows = listed.slice(skip).flatMap((i) => {
		const command = d.commands[i];
		const open = state.openRuns.has(i);
		const name = `<a data-act="output" data-i="${i}" title="Show the whole command and its output">${open ? "▾" : "▸"} ${clip(command.command, "mono")}</a>`;
		const row = [
			`<span class="run${i === state.run ? " hit" : ""}">${clock(command.time)}</span>`,
			by(command),
			status(command),
			took(command.ms),
			esc([...new Set(command.programs)].join(", ")),
			marks(command) + name,
		];
		return open ? [row, detail(command, i)] : [row];
	});
	const timed = d.commands.filter((command) => command.ms != null);
	const time = timed.length ? `, ${dur(timed.reduce((sum, command) => sum + command.ms, 0))}` : "";
	const title = `${d.commands.length} runs of ${d.programs.length} programs, ${counts.failed} failed${time}`;
	// A control that sets parts of the lens.
	const set = (label, parts, on, tip) => `<button${on ? ' class="on"' : ""} data-act="lens" ${lensData(parts)} title="${tip}">${label}</button>`;
	const statuses = [["All", d.commands.length, "", "Every run"], ["OK", counts.ok, "ok", "Only the runs that ended well"], ["Failed", counts.failed, "failed", "Only the failed runs"], ["Unknown", counts.unknown, "unknown", "Only the runs whose outcome the session does not tell"]]
		.map(([label, count, value, tip]) => set(`${label} ${count}`, { status: value }, value === (lens.status ?? ""), tip))
		.join("");
	const slow = set(`Slow ${d.commands.filter(isSlow).length}`, { slow: !lens.slow }, lens.slow, "Only the runs that took ten seconds or more");
	const order = `<span class="muted">Order</span>${set("Latest", { slowest: false }, !lens.slowest, "The newest run first")}${set("Slowest", { slowest: true }, lens.slowest, "The run with the longest wall time first")}`;
	const jump = (to, label, any, tip) => `<button data-act="run" data-to="${to}"${any ? "" : " disabled"} title="${tip}">${label}</button>`;
	const jumps = `<span class="muted">Go to</span>${jump("failed", "Next failed", counts.failed, "Highlight the newest failed run, then the one before it")}${jump("slowest", "Slowest run", timed.length, "Highlight the run with the longest wall time")}`;
	// The parts of the lens that no other control shows. The filter box cannot show a text of more than one line.
	const pill = (label, part) => `<button class="pill on" data-act="lens" ${lensData({ [part]: "" })} title="Remove this filter">${label} ×</button>`;
	const active = (lens.program ? pill(`Program: ${esc(lens.program)}`, "program") : "") + (lens.text && lens.text !== $("command-filter").value.trim() ? pill(`Command: ${clip(lens.text, "mono")}`, "text") : "");
	const newer = skip ? `<p class="muted">${skip} ${lens.slowest ? "slower" : "newer"} runs are not listed.</p>` : "";
	const empty = d.commands.length ? "No run matches." : "No command yet.";
	// The runs that deserve a look: each entry lists them.
	const { slowest: slowestRun, failing, repeated } = d.attention;
	const entry = (name, tip, label) => `<button data-act="lens" data-whole="1" ${lensData(d.lenses[name])} title="${tip}">${label}</button>`;
	const look = [
		d.commands[slowestRun] ? entry("slowest", "List the slowest runs first", `the slowest run took ${took(d.commands[slowestRun].ms)}`) : "",
		failing ? entry("failing", "List the failed runs of the program", `${esc(failing.program)} failed ${failing.count} times`) : "",
		repeated ? entry("repeated", "List the runs of the command", `${clip(repeated.command, "mono")} ran ${repeated.count} times`) : "",
	].filter(Boolean);
	const attention = look.length ? `<div class="pills"><span class="warn">Worth a look</span>${look.join("")}</div>` : "";
	const ranks = pills(title, d.programs.map((program) => [program.program, program.uses]), 8, (name) => `data-act="lens" ${lensData({ program: name === lens.program ? "" : name })} title="List only the runs of the program"`);
	return (
		ranks +
		attention +
		`<div class="controls">${statuses}${slow}${order}${jumps}${active}</div>` +
		newer +
		table(["Time", "Request", "", ">Took", "Programs", "Command"], rows, empty)
	);
}

/** What pi knows now about the picked tool: its description and its parameters. */
function toolAbout() {
	const doc = state.toolDoc?.name === state.tool ? state.toolDoc : undefined;
	const listed = (doc?.params ?? []).map((param) => [esc(param.name), esc(param.type), param.required ? "required" : "", esc(param.description)]);
	return !doc
		? `<p class="muted">Loading…</p>`
		: doc.error
			? `<p class="muted">${esc(doc.error)}</p>`
			: (doc.description ? `<pre>${esc(doc.description)}</pre>` : "") + table(["Parameter", "Type", "", "Description"], listed, "The tool has no parameters.");
}

function toolsCard(d) {
	const size = (tokens) => (tokens ? "≈" + tok(tokens) : "");
	const tools = d.toolRows.map((tool) => {
		const undeclared = tool.undeclared + (d.declared.includes(tool.name) ? 0 : tool.unchecked);
		const flag = undeclared ? ` <span class="warn" title="${undeclared} direct calls while the tool was not declared to the model">!</span>` : "";
		const name = `<a data-act="tool" data-name="${esc(tool.name)}" title="Show the description and the parameters">${tool.name === state.tool ? "▾" : "▸"} ${esc(tool.name)}</a>`;
		return [name + flag, esc(tool.source), size(tool.schema * d.factor), tool.calls || "", tool.nested || "", tool.errors || "", size(tool.callTokens), size(tool.resultTokens)];
	});
	const sources = d.schemaSources.map((group) => [esc(group.source || "unknown"), group.tools, "≈" + tok(group.tokens * d.factor)]);
	const skills = d.skills.map((skill) => [clip(skill.name), skill.loads, "≈" + tok(skill.tokens)]);
	const models = [...d.models].sort((a, b) => b.cost - a.cost).map((model) => [esc(model.model), model.requests, tok(model.sent), tok(model.output), cost(model.cost)]);
	return [
		table(["Tool", "Source", ">Schema", ">Calls", ">In scripts", ">Errors", ">Arguments", ">Results"], tools, "No tool yet."),
		state.tool ? `<h3>Tool ${esc(state.tool)}</h3>${toolAbout()}` : "",
		sources.length ? "<h3>Tool schemas by source</h3>" + table(["Source", ">Tools", ">Tokens"], sources) : "",
		skills.length ? "<h3>Skills</h3>" + table(["Skill", ">Loads", ">Tokens"], skills) : "",
		`<h3 id="models">Models</h3>` + table(["Model", ">Requests", ">Sent", ">Output", ">Cost"], models, "No request yet."),
	].join("");
}

// The subagents and the tasks of the session.

/** What the server said that the timeline and the board hold about the picked agent, as { timeline, board }. Undefined: no agent is picked, or the answer is not there yet. */
const narrowed = () => (state.agent && state.agentInfo?.id === state.agent && state.agentInfo.timeline ? state.agentInfo : undefined);

/** The pill of a card that shows only what is about the picked agent. A click shows everything again. */
function agentPill(d) {
	if (!state.agent) return "";
	const type = d.agents.find((agent) => agent.id === state.agent)?.type ?? state.agent.slice(0, 8);
	return `<button class="pill on" data-act="agent" data-id="${esc(state.agent)}" title="Show every agent, event and task again">Filtered to ${esc(type)} ×</button>`;
}

function agentsCard(d) {
	const { agents, running, items, messages } = d.fleet;
	const summary = `<p>${agents} ${agents === 1 ? "agent" : "agents"}, ${running} running · ${items} ${items === 1 ? "item" : "items"} on the board · ${messages} ${messages === 1 ? "message" : "messages"} to and from the agents</p>`;
	if (d.agents.length === 0) return summary + `<p class="muted">No subagent in this session.</p>`;
	// What the picked agent was asked and answered, its tasks and its last events.
	const detail = (agent) => {
		if (agent.id !== state.agent) return "";
		const info = state.agentInfo?.id === agent.id ? state.agentInfo : undefined;
		if (!info) return `<p class="muted">Loading…</p>`;
		if (info.error) return `<p class="bad">${esc(info.error)}</p>`;
		const block = (title, text) => (text ? `<small class="cap">${title}</small><pre>${esc(text)}</pre>` : "");
		const task = (item) =>
			`<div class="row"><span class="pos">#${esc(item.id)}</span><span class="sub" title="${esc(item.subject)}">${esc(item.subject)}</span><span class="${statusCss(item.status)}">${esc(item.status.replace(/_/g, " "))}</span></div>`;
		const event = (each) =>
			`<div class="row"><span class="pos">${clock(each.time)}</span><span class="pill">${esc(each.kind)}</span><span class="sub" title="${esc(each.title)}">${esc(each.title)}</span></div>`;
		const tasks = info.tasks.length ? `<h3>Tasks</h3>${info.tasks.map(task).join("")}` : "";
		const events = info.events.length ? `<h3>Last events</h3>${info.events.map(event).join("")}` : "";
		return block("Prompt", info.prompt) + block("Reply", info.reply) + tasks + events || `<p class="muted">The session tells nothing more about this agent.</p>`;
	};
	const ids = new Set(d.agents.map((agent) => agent.id));
	// Each agent is followed by the agents that it started.
	const under = (parent, level) =>
		d.agents.filter((agent) => (ids.has(agent.parent) ? agent.parent : undefined) === parent).flatMap((agent) => [[agent, level], ...under(agent.id, level + 1)]);
	const card = ([agent, level]) => {
		const total = agent.sums ? totalOf(agent.sums) : 0;
		// The bar is the window when it is known, else the context.
		const full = agent.window || agent.context || total;
		// The estimates are scaled to the provider-reported size of the context.
		const scale = total && agent.context ? agent.context / total : 1;
		const part = (cat) => `<i style="width:${((agent.sums[cat] * scale) / full) * 100}%;background:${COLORS[cat]}" title="${esc(labels[cat])} ≈${tok(agent.sums[cat] * scale)}"></i>`;
		const bar = total
			? CATS.filter((cat) => agent.sums[cat] > 0).map(part).join("")
			: agent.context && agent.window
				? `<i style="width:${(agent.context / agent.window) * 100}%;background:#9ca3af" title="The composition is not recorded"></i>`
				: "";
		const ran = agent.startedAt == null ? undefined : (agent.completedAt ?? Date.now()) - agent.startedAt;
		const facts = [
			["Context", agent.context == null ? "?" : tok(agent.context) + (agent.window ? ` / ${tok(agent.window)}` : "")],
			agent.context != null && agent.window ? ["Window used", pct(agent.context, agent.window)] : null,
			["Steps", agent.requests ?? "?"],
			["Ran", ran == null ? "?" : dur(ran)],
			agent.toolUses == null ? null : ["Tool calls", agent.toolUses],
			agent.tokens == null ? null : ["Tokens", tok(agent.tokens)],
			agent.cost == null ? null : ["Cost", cost(agent.cost)],
			agent.compactions ? ["Compactions", agent.compactions] : null,
		].filter(Boolean);
		const error = agent.error ? `<p class="bad">${esc(agent.error)}</p>` : "";
		return `<div class="agent" style="margin-left:${(agent.depth ?? level) * 20}px"><div class="between" data-act="agent" data-id="${esc(agent.id)}" title="Show the prompt, the reply, the tasks and the last events of the agent, and only its events and tasks in the timeline and on the board"><b>${agent.id === state.agent ? "▾" : "▸"} ${esc(agent.type)}</b><span class="${statusCss(agent.status)}">${esc(agent.status)}</span></div><div>${esc(agent.description)}</div><small class="mono">${esc(agent.model ?? "")}</small>${bar ? `<div class="bar">${bar}</div>` : ""}${pairs(facts)}${error}${detail(agent)}</div>`;
	};
	const pill = agentPill(d);
	return `${summary}${pill && `<p>${pill}</p>`}<div class="agents">${under(undefined, 0).map(card).join("")}</div>`;
}

/** Identifies an event of the timeline, so that it stays open when the data is loaded again. */
const eventKey = (event) => [event.time, event.kind, event.agent ?? "", event.title].join("|");

function timelineCard(d) {
	if (d.timeline.length === 0) return `<p class="muted">No delegation, message or task event in this session.</p>`;
	// With a picked agent, only its events.
	const timeline = narrowed()?.timeline ?? d.timeline;
	// An agent shows as its type; its id is in the tooltip.
	const who = (id) => (id ? (d.agents.find((agent) => agent.id === id)?.type ?? id.slice(0, 8)) : "");
	const needle = $("fleet-search").value.trim().toLowerCase();
	const counts = new Map();
	for (const event of timeline) counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
	const kind = state.fleetKind;
	// The chip of the picked kind stays when the agent has no such event.
	if (kind && !counts.has(kind)) counts.set(kind, 0);
	const kinds = chips("fleetKind", [["All", timeline.length, ""], ...[...counts].map(([name, count]) => [esc(name), count, esc(name)])]);
	const found = timeline.filter(
		(event) => (!kind || event.kind === kind) && (!needle || `${event.kind} ${who(event.agent)} ${event.title} ${event.body ?? ""}`.toLowerCase().includes(needle)),
	);
	// The data has the earliest event first.
	if (!state.earliest) found.reverse();
	const line = (event) => {
		const key = eventKey(event);
		const open = event.body && state.openEvents.has(key);
		const row = `<div class="item flat" data-act="event" data-key="${esc(key)}"><span class="fold">${event.body ? (open ? "▾" : "▸") : ""}</span><span class="pos">${clock(event.time)}</span><span class="pill">${esc(event.kind)}</span><span class="lbl" title="${esc(event.agent ?? "")}">${esc(who(event.agent))}</span><span class="sub" title="${esc(event.title)}">${esc(event.title)}</span></div>`;
		return open ? `${row}<pre>${esc(event.body)}</pre>` : row;
	};
	const more = found.length > MAX_LIST ? `<p class="muted">The first ${MAX_LIST} of ${found.length}.</p>` : "";
	return `<div class="controls">${kinds}${agentPill(d)}</div>` + (found.length ? `<div class="scroll">${found.slice(0, MAX_LIST).map(line).join("")}</div>${more}` : `<p class="muted">No event matches.</p>`);
}

function boardCard(d) {
	// With a picked agent, only its tasks and its delegation.
	const board = narrowed()?.board ?? d.board;
	const items = board.flatMap((group) => group.items);
	const pill = agentPill(d);
	if (items.length === 0) return (pill && `<div class="controls">${pill}</div>`) + `<p class="muted">No task and no delegation ${narrowed() ? "of this agent" : "in this session"}.</p>`;
	const picked = state.taskState;
	const states = chips("taskState", [["All", items.length, ""], ...TASK_STATES.map(([value, label]) => [label, items.filter((item) => item.state === value).length, value])]);
	const needle = $("board-search").value.trim().toLowerCase();
	const matches = (item) => (!picked || item.state === picked) && (!needle || `${item.id} ${item.subject} ${item.description ?? ""} ${item.status}`.toLowerCase().includes(needle));
	// A task of the chain that another task waits for, in the colour of its status.
	const link = (id) => {
		const task = items.find((item) => item.id === id && !item.agent);
		return `<a class="${task ? statusCss(task.status) : ""}" data-act="blocker" data-id="${esc(id)}" title="${esc(task ? `${task.subject} (${task.status.replace(/_/g, " ")})` : "")}">#${esc(id)}</a>`;
	};
	const line = (item) => {
		// A task that waits for other tasks opens too: it shows their chain.
		const waits = !item.agent && d.tasks.some((task) => task.id === item.id && task.blockedBy.length > 0);
		const more = item.description || item.reply || waits;
		const open = more && state.openTasks.has(item.id);
		const blockers = item.blockedBy.map((id) => `<a data-act="blocker" data-id="${esc(id)}" title="Show the task">#${esc(id)}</a>`);
		const ready = readiness(item);
		const badge = ready ? `<span class="pill ${ready === "ready" ? "good" : "warn"}">${ready}</span>` : "";
		const blocked = blockers.length ? `<span class="warn">${ready ? "" : "blocked "}by ${blockers.join(", ")}</span>` : "";
		// A delegation has the id of its agent.
		const id = item.agent ? item.id.slice(0, 8) : "#" + item.id;
		const row = `<div class="item flat${item.id === state.task ? " hit" : ""}" data-act="task" data-id="${esc(item.id)}"><span class="fold">${more ? (open ? "▾" : "▸") : ""}</span><span class="pos" title="${esc(item.id)}">${esc(id)}</span><span class="sub" title="${esc(item.subject)}">${esc(item.subject)}</span>${badge}${blocked}<span class="${statusCss(item.status)}">${esc(item.status.replace(/_/g, " "))}</span></div>`;
		if (!open) return row;
		const reply = item.reply ? `<small class="cap">Reply</small><pre>${esc(item.reply)}</pre>` : "";
		const chain = (waits && state.chains.get(item.id)) || [];
		const before = chain.length ? `<small class="cap">Waits for ${chain.map(link).join(", ")}, the nearest first</small>` : "";
		return row + before + (item.description ? `<pre>${esc(item.description)}</pre>` : "") + reply;
	};
	const groups = board.map((group) => [group.owner, group.items.filter(matches)]).filter(([, own]) => own.length > 0);
	const list = groups.map(([owner, own]) => `<h3>${esc(owner)} · ${own.length}</h3>${own.map(line).join("")}`).join("");
	return `<div class="controls">${states}${pill}</div>` + (list || `<p class="muted">${needle ? "No task matches." : "No task in this state."}</p>`);
}

// The Insights page.

/**
 * A tally of tools, programs or skills: name, sessions that used it, time of the last use, uses. A click on a name lists the sessions that used it.
 * `info` gives a skill its path and where it comes from.
 */
const rank = (kind, items, empty, info = {}) => {
	const on = (name) => (state.uses?.kind === kind && state.uses.name === name ? ' class="on"' : "");
	const line = ([name, count, last, sessions]) => {
		const [path, source] = Object.hasOwn(info, name) ? info[name] : [];
		const badge = source ? ` <small class="pill" title="Where the skill comes from">${esc(source)}</small>` : "";
		const where = path ? `<small class="mono path" title="${esc(path)}">${esc(path)}</small>` : "";
		const used = sessions == null ? "" : `${sessions} ${sessions === 1 ? "session" : "sessions"}`;
		return `<span${on(name)} data-act="uses" data-kind="${kind}" data-name="${esc(name)}" style="--w:${(count / items[0][1]) * 100}%" title="${esc(name)}: click to list only the sessions that used it">${esc(name)}${badge}</span><small title="Sessions that used it">${used}</small><small title="Last used">${last ? date(last) : ""}</small><b class="tok">${count}</b>${where}`;
	};
	return items.length ? `<div class="rank">${items.map(line).join("")}</div>` : `<p class="muted">${empty}</p>`;
};

/** The local day as YYYY-MM-DD. */
const today = () => {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

/** What the calendar of Insights can be shaded by: the field of a day, its name, and how a value reads. */
const DAY_METRICS = [["requests", "Requests", String], ["tokens", "Tokens", (n) => tok(n)], ["sessions", "Sessions", String], ["cost", "Cost", (n) => cost(n)]];

/** The days of the period as a calendar: one column per week, Monday first, shaded by the requests, the tokens, the sessions or the cost of the day. */
function daysCard(ins) {
	const days = ins.daily;
	if (days.length === 0) return `<p class="muted">No day in the period.</p>`;
	const [year, month, date] = days[0].day.split("-").map(Number);
	const offset = (new Date(year, month - 1, date).getDay() + 6) % 7;
	const weeks = Math.ceil((offset + days.length) / 7);
	const [metric, name, show] = DAY_METRICS.find(([each]) => each === state.dayMetric);
	const peak = Math.max(...days.map((day) => day[metric]), 0);
	const cell = (day) => {
		if (!day) return "<span></span>";
		const tip = `${day.day}: ${day.sessions} sessions, ${day.requests} requests, ${tok(day.tokens)} tokens, ${cost(day.cost)}`;
		const shade = day[metric] > 0 ? `<b style="opacity:${0.2 + (0.8 * day[metric]) / peak}"></b>` : "";
		const on = ins.until ? day.day >= ins.day && day.day <= ins.until : day.day === ins.day;
		return `<i${on ? ' class="on"' : ""} data-act="day" data-day="${day.day}" title="${tip}">${shade}</i>`;
	};
	// The grid fills by column: a column of labels, then one column per week.
	const cells = DAYS.map((name) => `<span>${name}</span>`);
	const months = ["<span></span>"];
	let last = "";
	for (let week = 0; week < weeks; week++) {
		const column = Array.from({ length: 7 }, (_, weekday) => days[week * 7 + weekday - offset]);
		const name = column.find(Boolean)?.day.slice(5, 7) ?? last;
		months.push(`<span>${name === last ? "" : MONTHS[Number(name) - 1]}</span>`);
		last = name;
		cells.push(...column.map(cell));
	}
	const note = "Click a day to narrow the page to it. Click another day with Shift to narrow the page to the days from the one to the other. Click the day again to show the whole period.";
	const metrics = DAY_METRICS.map(([value, label]) => `<button${value === metric ? ' class="on"' : ""} data-act="pick" data-key="dayMetric" data-value="${value}">${label}</button>`).join("");
	// The legend names what shades the days, from a day with nothing to the day with the most.
	const scale = [0.2, 0.4, 0.6, 0.8, 1].map((opacity) => `<i><b style="opacity:${opacity}"></b></i>`).join("");
	const key = `<div class="pills shades"><span>${name} of a day: 0</span><i></i>${scale}<span>${show(peak)}</span></div>`;
	return `<div class="controls"><span class="muted">Shaded by</span>${metrics}</div><div class="scroll-x" data-keep="days"><div class="cal months" style="--weeks:${weeks}">${months.join("")}</div><div class="cal" style="--weeks:${weeks}">${cells.join("")}</div></div>${key}<p class="muted">${note}</p>`;
}

function renderInsights() {
	for (const button of document.querySelectorAll('[data-act="days"]')) button.classList.toggle("on", button.dataset.days === String(state.days));
	document.querySelector('[data-act="today"]').classList.toggle("on", state.day === today() && !state.until);
	const ins = state.insights;
	if (!ins) {
		for (const id of INSIGHT_CARDS) paint(id, `<p class="muted">Reading the sessions…</p>`);
		return;
	}
	paint(
		"i-kpi",
		tiles([
			[ins.sessions.length, "Sessions"],
			[ins.requests, "Requests"],
			[tok(ins.tokens), "Tokens"],
			[cost(ins.cost), "Cost"],
			ins.until ? [`${ins.day.slice(5)} to ${ins.until.slice(5)}`, "Days"] : ins.day ? [ins.day, "Day"] : [ins.activeDays, "Active days"],
			[pct(ins.cacheRate, 1), "Read from cache"],
			[ins.userInputs, "Human inputs"],
			[ins.toolCalls, "Tool calls"],
			[dur(ins.activeMs), "Active time", "of the recorded turns"],
		]) + (ins.day ? `<p>The figures cover ${ins.until ? `${ins.day} to ${ins.until}` : ins.day} only. <a data-act="day">Show the whole period</a></p>` : ""),
	);
	paint("i-days", daysCard(ins));
	const sent = totalOf(ins.composition.sums);
	const parts = catParts(ins.composition.sums);
	const recorded = `${ins.composition.requests} of ${ins.requests} requests, those recorded by pi-context. Each request sends the whole context again.`;
	paint(
		"i-composition",
		sent ? `<div class="split">${donut(parts, tok(sent), "sent")}${legend(parts)}</div><p class="muted">${recorded}</p>` : `<p class="muted">pi-context recorded no request ${ins.until ? "on these days" : ins.day ? "on this day" : "in the period"}.</p>`,
	);
	const most = Math.max(...ins.week.map((day) => day.tokens), 1);
	const column = (day) =>
		`<div title="${day.requests} requests"><span>${tok(day.tokens)}</span><i style="height:${(day.tokens / most) * 60}%"></i><span>${day.day.slice(5)}</span><span>${cost(day.cost)}</span><span>${day.sessions} ${day.sessions === 1 ? "session" : "sessions"}</span></div>`;
	paint("i-week", `<div class="week">${ins.week.map(column).join("")}</div>`);
	const peak = Math.max(...ins.heat.flat(), 1);
	const hours = "<span></span>" + Array.from({ length: 24 }, (_, hour) => `<span>${hour % 6 === 0 ? hour : ""}</span>`).join("");
	const cell = (count, day, hour) =>
		`<i title="${DAYS[day]} ${hour}:00, ${count} requests">${count ? `<b style="opacity:${0.2 + (0.8 * count) / peak}"></b>` : ""}</i>`;
	const days = ins.heat.map((row, day) => `<span>${DAYS[day]}</span>${row.map((count, hour) => cell(count, day, hour)).join("")}`);
	paint("i-heat", `<div class="heat">${hours}${days.join("")}</div>`);
	paint(
		"i-models",
		table(
			["Model", ">Requests", ">Tokens", ">Cost"],
			ins.models.map(([model, requests, tokens, dollars]) => [esc(model), requests, tok(tokens), cost(dollars)]),
			"No request in the period.",
		),
	);
	paint(
		"i-projects",
		table(
			["Directory", ">Sessions", ">Requests", ">Tokens", ">Cost"],
			ins.projects.map(([cwd, sessions, requests, tokens, dollars]) => [clip(cwd, "mono"), sessions, requests, tok(tokens), cost(dollars)]),
			"No session in the period.",
		),
	);
	paint("i-tools", rank("tools", ins.tools, "No tool call in the period."));
	paint("i-programs", `<h3>Programs</h3>${rank("programs", ins.programs, "No command in the period.")}<h3>Skills</h3>${rank("skills", ins.skills, "No skill loaded in the period.", ins.skillInfo)}`);
	const needle = $("search").value.trim().toLowerCase();
	const found = ins.sessions.filter((session) => !needle || `${session.name} ${session.cwd} ${session.lastUser ?? ""}`.toLowerCase().includes(needle));
	const card = (session) => {
		const title = session.name || session.cwd.split("/").pop() || session.cwd;
		const open = session.file ? ` data-act="session" data-file="${esc(session.file)}" data-title="${esc(title)}"` : "";
		// The composition of the last recorded request of the session.
		const profile = session.profile ?? [];
		const sum = profile.reduce((total, tokens) => total + tokens, 0);
		// The bar is the window of the model when it is known, else the context.
		const used = session.window ? Math.min(1, session.context / session.window) : 1;
		const parts = CATS.map((cat, i) => (profile[i] > 0 ? `<i style="width:${(profile[i] / sum) * used * 100}%;background:${COLORS[cat]}" title="${esc(labels[cat] ?? cat)} ≈${tok(profile[i])}"></i>` : "")).join("");
		const bar = sum || !session.window ? parts : `<i style="width:${used * 100}%;background:#9ca3af"></i>`;
		const share = session.window ? ` · ${pct(session.context, session.window)}` : "";
		const tip = session.window ? `Tokens that the last request sent: ${pct(session.context, session.window)} of the window of ${tok(session.window)} of ${session.model}` : "Tokens that the last request sent";
		const context = `<div class="between"><div class="bar"${sum ? "" : ' title="The composition is not recorded"'}>${bar}</div><small class="tok" title="${esc(tip)}">context ${tok(session.context)}${share}</small></div>`;
		const current = session.current ? `<span class="badge" title="The session that is open in pi">current</span> ` : "";
		const count = (n, one) => `${n} ${n === 1 ? one : one + "s"}`;
		const asked = session.lastUser ? `<small class="asked" title="The last human input">${esc(session.lastUser)}</small>` : "";
		return `<div class="session"${open}><b>${current}${esc(title)}</b><small class="mono">${esc(session.cwd)}</small>${asked}${context}<div class="between"><small>${date(session.end)}</small><span>${count(session.userInputs, "input")} · ${count(session.requests, "request")} · ${tok(session.tokens)} · ${cost(session.cost)}</span></div></div>`;
	};
	const more = found.length > state.shown ? `<p><button data-act="more">Show more (${found.length - state.shown} left)</button></p>` : "";
	const shown = found.slice(0, state.shown);
	// As groupSessions() of src/insights.ts: the directories in the order of their first session.
	const groups = new Map();
	for (const session of shown) groups.set(session.cwd, [...(groups.get(session.cwd) ?? []), session]);
	const cards = (sessions) => `<div class="sessions">${sessions.map(card).join("")}</div>`;
	const list = $("group").checked ? [...groups].map(([cwd, sessions]) => `<h3 class="mono">${esc(cwd)} · ${sessions.length}</h3>${cards(sessions)}`).join("") : cards(shown);
	const used = state.uses
		? `<p>Only the sessions that used the ${{ tools: "tool", programs: "program", skills: "skill" }[state.uses.kind]} <b>${esc(state.uses.name)}</b>. The other figures cover all sessions. <a data-act="uses">Clear</a></p>`
		: "";
	paint("i-sessions", used + (found.length ? list + more : `<p class="muted">No session matches.</p>`));
}

// Drawing and loading.

function fillSettings(d) {
	const form = $("settings-form");
	$("settings").hidden = d.readOnly;
	const seen = JSON.stringify(d.config);
	// A form that the user is editing is left alone.
	if (d.readOnly || form.dataset.seen === seen || form.dataset.dirty) return;
	form.dataset.seen = seen;
	const values = {
		warn: d.config.warnPercent ?? d.warnDefault,
		compact: d.config.compactPercent ?? 0,
		budget: d.config.budget ?? 0,
		expiry: d.config.expiryWarnSeconds ?? 0,
		footer: d.footer.join(" "),
		prefix: d.config.systemPromptPrefix ?? "",
		suffix: d.config.systemPromptSuffix ?? "",
	};
	for (const [name, value] of Object.entries(values)) {
		form.elements[name].value = value;
		form.elements[name].dataset.was = form.elements[name].value;
	}
}

/** The view defaults as selects. Unchanged selects are left alone, so that an open one stays open. */
function fillChoices(d) {
	const field = ([setting, choice]) => {
		const options = choice.values.map((value, i) => `<option value="${esc(value)}"${value === d.view[setting] ? " selected" : ""}>${esc(value)}${i === 0 ? " (default)" : ""}</option>`);
		return `<label>${esc(choice.label)}<select data-setting="${esc(setting)}">${options.join("")}</select><small>${esc(choice.help)}</small></label>`;
	};
	const html = Object.entries(d.choices).map(field).join("");
	if (painted.get("choices") === html) return;
	painted.set("choices", html);
	$("choices").innerHTML = html;
}

/** Makes the page show what view defaults say. `view` has some of period, trend, mode, fit, tools, files and diff. */
function applyDefaults(view) {
	if (view.period) {
		state.days = view.period === "all" ? "all" : Number(view.period);
		state.day = null;
		state.until = null;
	}
	if (view.trend) state.trend.byTurn = view.trend === "input";
	if (view.mode) state.trend.delta = view.mode === "change";
	if (view.fit) {
		state.trend.last = view.fit === "off" ? 0 : Number(view.fit);
		state.trend.whole = false;
	}
	if (view.tools) state.toolOrder = view.tools;
	if (view.files) state.fileOrder = view.files;
	if (view.diff) state.diff = view.diff;
}

/**
 * The requests that the picker of the Context Browser finds for what is typed, as [number, preview of the human input], at most 8:
 * the request with that number, the request at that coordinate ("3.2", or "3" for the first step of input 3), and the first requests of the inputs whose preview holds the text.
 */
function pickRequests(d, typed) {
	const found = new Map();
	const add = (i) => {
		if (d.requests[i] && !found.has(d.requests[i].n)) found.set(d.requests[i].n, d.inputs[d.places[i]?.input - 1]?.preview ?? "");
	};
	const [, first, step] = /^#?(\d+)(?:\.(\d+))?$/.exec(typed) ?? [];
	if (first && !step) add(d.requests.findIndex((request) => request.n === Number(first)));
	if (first) add(d.places.findIndex((place) => place?.input === Number(first) && place.step === Number(step ?? 1)));
	for (const input of d.inputs) if (input.preview.toLowerCase().includes(typed.toLowerCase())) add(input.first);
	return [...found].slice(0, 8);
}

/** Lists under the picker of the Context Browser the requests that it finds. */
function fillPicks(d) {
	const typed = $("pick").value.trim();
	const rows = typed ? pickRequests(d, typed) : [];
	const list = rows.map(([n, preview]) => `<div class="item flat" data-act="goto" data-n="${n}" title="${esc(placed.get(n) ? placeText(placed.get(n)) : "")}"><span class="lbl">${coord(n)}</span><span class="pv">${esc(preview)}</span></div>`);
	$("picks").innerHTML = !typed ? "" : list.join("") || `<p class="muted">No request matches.</p>`;
}

function syncRequests(d) {
	const select = $("request");
	const made = `${state.session?.file ?? ""}:${d.requests.length}`;
	if (select.dataset.made !== made) {
		select.dataset.made = made;
		const options = [...d.requests].reverse().map((r) => `<option value="${r.n}">${coord(r.n)} · ${clock(r.time)} · ${tok(r.context)}</option>`);
		select.innerHTML = `<option value="">Current context</option>${options.join("")}`;
	}
	select.value = state.request ?? "";
}

function render() {
	const d = state.data;
	$("context").hidden = state.page !== "context";
	$("insights").hidden = state.page !== "insights";
	for (const button of document.querySelectorAll("nav button")) button.classList.toggle("on", button.dataset.page === state.page);
	$("title").textContent = d?.title ?? "Context";
	document.title = `${d?.title ?? "Context"} · pi-context`;
	$("live").hidden = !d?.live;
	$("model").textContent = d?.model ?? "";
	$("other").hidden = !d?.readOnly;
	if (state.page === "insights") return renderInsights();
	if (!d) return;
	syncRequests(d);
	fillPicks(d);
	$("base").value = state.diff;
	fillSettings(d);
	if (!d.readOnly) fillChoices(d);
	paint("stats", statsCard(d));
	paint("tokens", tokensCard(d));
	paint("timing", timingCard(d));
	document.querySelector("[data-act=treemap]").classList.toggle("on", state.treemap);
	paint("current", currentCard(d));
	for (const button of document.querySelectorAll("[data-act=trend]")) button.classList.toggle("on", state.trend[button.dataset.key]);
	paint("trend", trendCard(d));
	paint("browser", browserCard(d));
	paint("hints", hintsCard(d));
	paint("turns", turnsCard(d));
	paint("events", eventsCard(d));
	for (const button of document.querySelectorAll("[data-act=files]")) button.classList.toggle("on", state.fileOrder === button.dataset.order);
	document.querySelector("[data-act=asOf]").classList.toggle("on", state.asOf);
	paint("files", filesCard(d));
	paint("commands", commandsCard(d));
	for (const button of document.querySelectorAll("[data-act=order]")) button.classList.toggle("on", state.toolOrder === button.dataset.order);
	paint("tools", toolsCard(d));
	// A session without subagents and tasks does not show their cards.
	const fleet = d.agents.length + d.timeline.length + d.board.length > 0;
	for (const id of ["agents", "timeline", "board"]) $(id).hidden = !fleet;
	document.querySelector("[data-act=earliest]").classList.toggle("on", state.earliest);
	paint("agents", agentsCard(d));
	paint("timeline", timelineCard(d));
	paint("board", boardCard(d));
}

/** What the server makes for the choices of the page: the bars of the trend and the order of the tools. */
const dataQuery = () => ({ turn: state.trend.byTurn ? 1 : 0, delta: state.trend.delta ? 1 : 0, tools: state.toolOrder });

let loading = false;
let again = false;
/** Loads the data of the session on show. A call during a load makes one more load follow. */
async function load() {
	if (loading) {
		again = true;
		return;
	}
	loading = true;
	try {
		const sent = dataQuery();
		const d = await api("data", params(sent));
		labels = d.labels;
		placed = new Map(d.requests.map((request, i) => [request.n, d.places[i]]));
		// The first load tells the view defaults of the settings: the page starts from them.
		if (!state.started) {
			state.started = true;
			const days = state.days;
			applyDefaults(d.view);
			if (state.page === "insights" && days !== state.days) loadInsights();
			// The bars and the tool list were made for other choices: one more load brings them.
			if (JSON.stringify(sent) !== JSON.stringify(dataQuery())) {
				loading = false;
				return load();
			}
		}
		state.data = d;
		setError("");
		const request = d.requests.find((r) => r.n === state.request);
		// Another branch can have another request under the same number.
		if (state.request != null && state.view?.time !== request?.time) selectRequest(request?.n ?? null);
		// The picked agent may have gone on since the last load.
		if (state.agent) loadAgent();
	} catch (error) {
		setError(error.message);
		// A saved session that cannot be opened gives way to the current one.
		if (state.session) {
			state.session = null;
			again = true;
		}
	}
	loading = false;
	render();
	if (again) {
		again = false;
		load();
	}
}

async function selectRequest(n) {
	state.request = n;
	state.view = null;
	if (state.asOf) loadFiles();
	render();
	if (n == null) return;
	try {
		const base = state.diff;
		const view = await api("request", params({ n, turn: state.trend.byTurn ? 1 : 0, base }));
		if (state.request === n) state.view = { ...view, base };
	} catch (error) {
		setError(error.message);
		state.request = null;
	}
	render();
}

async function openItem(i) {
	const live = state.request == null;
	const row = (live ? state.data.current : state.view?.rows)?.[i];
	if (!row) return;
	const key = keyOf(row);
	if (state.openItems.delete(key)) return render();
	state.openItems.add(key);
	render();
	if (state.texts.has(key)) return;
	try {
		const { text, call } = await api("text", params(live ? { i, v: state.data.version } : { i, n: state.request }));
		state.texts.set(key, { call, json: prettyJson(text), text: text ?? `${row.preview}\n\n(Only this preview is available. The item was not found in the saved session.)` });
		if (state.texts.size > MAX_TEXTS) state.texts.delete(state.texts.keys().next().value);
	} catch {
		// The context changed after the page loaded it.
		state.openItems.delete(key);
		load();
	}
	render();
}

async function openSession(file, title) {
	state.session = file ? { file, title } : null;
	state.data = null;
	state.request = null;
	state.view = null;
	state.openItems.clear();
	state.run = null;
	state.openRuns.clear();
	state.outputs.clear();
	setLens({});
	$("pick").value = "";
	state.task = null;
	state.then = null;
	state.tool = null;
	state.agent = null;
	state.chains.clear();
	painted.clear();
	location.hash = "";
	scrollTo(0, 0);
	await load();
}

let reading = 0;
async function loadInsights() {
	const mine = ++reading;
	state.insights = null;
	state.shown = SESSIONS_STEP;
	render();
	try {
		const uses = state.uses ? `${state.uses.kind}:${state.uses.name}` : "";
		const insights = await api("insights", { days: state.days, day: state.day ?? "", until: state.until ?? "", project: $("project").checked ? 1 : 0, sort: $("sort").value, uses });
		if (mine === reading) state.insights = insights;
	} catch (error) {
		setError(error.message);
	}
	render();
}

/** Reads the files as they were after the request of the Context Browser, when File Activity shows them so. */
async function loadFiles() {
	const n = state.request;
	state.then = null;
	if (!state.asOf || n == null) return;
	try {
		const { files } = await api("files", params({ n }));
		if (state.asOf && state.request === n) state.then = { n, files };
	} catch (error) {
		setError(error.message);
	}
	render();
}

/** Reads what the picked agent was asked and answered, its tasks and its last events. */
async function loadAgent() {
	const id = state.agent;
	let info;
	try {
		info = await api("agent", params({ id }));
	} catch (error) {
		info = { error: error.message };
	}
	if (state.agent === id) state.agentInfo = { id, ...info };
	render();
}

/** Changes how the content of the opened item `i` shows: `change` gets what state.viewers has for the item and gives what to set. */
function setViewer(i, change) {
	const row = shownRow(i);
	if (!row) return;
	const key = keyOf(row);
	const now = state.viewers.get(key) ?? {};
	state.viewers.set(key, { ...now, ...change(now) });
	render();
	// The current match of the find box comes into view.
	document.querySelector(`#browser [data-find="${i}"]`)?.parentElement.nextElementSibling.querySelector("mark.at")?.scrollIntoView({ block: "nearest" });
}
function toggle(set, value) {
	if (!set.delete(value)) set.add(value);
	render();
}

const actions = {
	page(el) {
		location.hash = el.dataset.page === "insights" ? "#insights" : "";
	},
	request: (el) => selectRequest(Number(el.dataset.n)),
	/** Opens a request that the picker of the Context Browser found. */
	goto(el) {
		$("pick").value = "";
		selectRequest(Number(el.dataset.n));
	},
	/** Goes to the card, or to the part of a card, that a figure belongs to. */
	go(el) {
		const { to, key, value, lens, name } = el.dataset;
		// A figure about a part of a card sets the filter of that card.
		if (key) state[key] = value;
		if (lens) setLens(JSON.parse(lens));
		if (name && name !== state.tool) actions.tool(el);
		render();
		$(to)?.scrollIntoView({ behavior: "smooth" });
	},
	step(el) {
		const numbers = (state.data?.requests ?? []).map((request) => request.n);
		const next = (state.request == null ? numbers.length : numbers.indexOf(state.request)) + Number(el.dataset.by);
		if (next >= 0 && next <= numbers.length) selectRequest(numbers[next] ?? null);
	},
	trend(el) {
		const key = el.dataset.key;
		state.trend[key] = !state.trend[key];
		// The server makes the bars; the width is a matter of the page.
		if (key === "fit") return render();
		// The lines under the chart tell of a request or of a human input: load() reads the request again.
		if (key === "byTurn") state.view = null;
		load();
	},
	/** Shows every bar of the trend, or again only the last ones that the view default allows. */
	bars() {
		state.trend.whole = !state.trend.whole;
		render();
	},
	treemap() {
		state.treemap = !state.treemap;
		render();
	},
	/** Opens an item of the treemap in the Context Browser, which shows the current context for it. */
	async cell(el) {
		if (state.request != null) await selectRequest(null);
		actions.band(el);
	},
	order(el) {
		state.toolOrder = el.dataset.order;
		load();
	},
	files(el) {
		state.fileOrder = el.dataset.order;
		render();
	},
	/** Shows the files as they were after the request of the Context Browser, or again as they are now. */
	asOf() {
		state.asOf = !state.asOf;
		render();
		loadFiles();
	},
	/** A chip: sets the value that it chooses. */
	pick(el) {
		state[el.dataset.key] = el.dataset.value;
		render();
	},
	/** Highlights a run of Command Executions: the slowest, or the failed runs one after the other, the newest first. */
	run(el) {
		const commands = state.data.commands;
		const failed = commands.map((_, i) => i).filter((i) => commands[i].ok === false).reverse();
		const run = el.dataset.to === "slowest" ? slowest(commands) : failed[(failed.indexOf(state.run) + 1) % failed.length];
		if (!commands[run]) return;
		state.run = run;
		// A run that the lens filters out is not in the list.
		if (!commandRows(commands, state.lens).includes(run)) setLens({ slowest: state.lens.slowest });
		render();
		document.querySelector("#commands .hit")?.scrollIntoView({ block: "center" });
	},
	/** Sets parts of the lens of Command Executions, or the whole lens. */
	lens(el) {
		setLens({ ...(el.dataset.whole ? {} : state.lens), ...JSON.parse(el.dataset.lens) });
		render();
	},
	/** Shows the whole command of a run and its output. The same run again hides them. */
	async output(el) {
		const i = Number(el.dataset.i);
		toggle(state.openRuns, i);
		if (!state.openRuns.has(i) || state.outputs.get(i)?.text != null) return;
		let output;
		try {
			output = await api("output", params({ i }));
		} catch (error) {
			output = { error: error.message };
		}
		state.outputs.set(i, output);
		render();
	},
	earliest() {
		state.earliest = !state.earliest;
		render();
	},
	event: (el) => toggle(state.openEvents, el.dataset.key),
	/** Opens or closes a task. An opened task reads the tasks that it waits for. */
	async task(el) {
		const { id } = el.dataset;
		toggle(state.openTasks, id);
		if (!state.openTasks.has(id) || !state.data.tasks.some((task) => task.id === id)) return;
		try {
			state.chains.set(id, (await api("chain", params({ id }))).ids);
			render();
		} catch (error) {
			setError(error.message);
		}
	},
	/** Shows what a subagent was asked and answered, its tasks and its last events. The same agent again hides them. */
	agent(el) {
		state.agent = state.agent === el.dataset.id ? null : el.dataset.id;
		state.agentInfo = null;
		render();
		if (state.agent) loadAgent();
	},
	/** Shows the description and the parameters of a tool under the tool list. The same tool again hides them. */
	async tool(el) {
		const { name } = el.dataset;
		state.tool = state.tool === name ? null : name;
		state.toolDoc = null;
		render();
		if (!state.tool) return;
		let doc;
		try {
			doc = await api("tool", params({ name }));
		} catch (error) {
			doc = { error: error.message };
		}
		if (state.tool === name) state.toolDoc = { name, ...doc };
		render();
	},
	/** Shows the task that blocks another one. */
	blocker(el) {
		state.task = el.dataset.id;
		const item = state.data.board.flatMap((group) => group.items).find((each) => each.id === state.task);
		// A task that is not about the picked agent is not on its board.
		if (narrowed() && !narrowed().board.some((group) => group.items.some((each) => each.id === state.task))) state.agent = null;
		if (state.taskState && item?.state !== state.taskState) state.taskState = "";
		render();
		document.querySelector("#board .hit")?.scrollIntoView({ block: "center" });
	},
	/** Lists only the sessions that used a tool, a program or a skill. The same one again, or no name, lists all sessions. */
	uses(el) {
		const { kind, name } = el.dataset;
		state.uses = !kind || (state.uses?.kind === kind && state.uses.name === name) ? null : { kind, name };
		loadInsights();
	},
	cat: (el) => toggle(state.openCats, el.dataset.cat),
	item: (el) => openItem(Number(el.dataset.i)),
	/** Shows the content of an opened item as text, as Markdown or as JSON. */
	mode: (el) => setViewer(Number(el.dataset.i), () => ({ mode: el.dataset.mode })),
	/** Goes to the next or the previous match of the find box of an opened item. */
	find: (el) => setViewer(Number(el.dataset.i), (viewer) => ({ at: (viewer.at ?? 0) + Number(el.dataset.by) })),
	/** Copies the content of an opened item as it shows: the text, or the formatted JSON. */
	async copy(el) {
		const row = shownRow(Number(el.dataset.i));
		const entry = row && state.texts.get(keyOf(row));
		if (!entry) return;
		const json = state.viewers.get(keyOf(row))?.mode === "json" && entry.json;
		try {
			await navigator.clipboard.writeText(json || entry.text);
			el.textContent = "Copied";
			setTimeout(() => {
				el.textContent = "Copy";
			}, 1500);
		} catch {
			setError("The browser did not allow the copy.");
		}
	},
	/** Shows the item of a band of the strip: opens its category and its content, and scrolls to it. */
	band(el) {
		const i = Number(el.dataset.i);
		const row = (state.request == null ? state.data.current : state.view?.rows)?.[i];
		if (!row) return;
		state.openCats.add(row.cat);
		if (state.openItems.has(keyOf(row))) render();
		else openItem(i);
		document.querySelector(`#browser .item[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
	},
	/** Shows the first item that entered the context since the request before. */
	added() {
		const i = state.view?.marks?.indexOf("+") ?? -1;
		if (i >= 0) actions.band({ dataset: { i } });
	},
	/** Shows the answer to the selected request: the first item that the next request added. */
	async reply() {
		const requests = state.data.requests;
		const next = requests[requests.findIndex((request) => request.n === state.request) + 1]?.n ?? null;
		await selectRequest(next);
		if (next == null || state.diff !== "input") return actions.added();
		// The diff since the human input marks more than the answer: the diff with the request before tells where the answer starts.
		try {
			const i = (await api("request", params({ n: next }))).marks?.indexOf("+") ?? -1;
			if (i >= 0) actions.band({ dataset: { i } });
		} catch (error) {
			setError(error.message);
		}
	},
	async drop(el) {
		try {
			await api("drop", {}, { ids: JSON.parse(el.dataset.ids), dropped: el.dataset.dropped === "1" });
		} catch (error) {
			setError(error.message);
		}
		load();
	},
	days(el) {
		state.days = el.dataset.days === "all" ? "all" : Number(el.dataset.days);
		state.day = null;
		state.until = null;
		loadInsights();
	},
	today() {
		state.day = state.day === today() && !state.until ? null : today();
		state.until = null;
		loadInsights();
	},
	/** Narrows Insights to a day. With Shift, to the days from the selected day to this one. The selected day again, or no day, shows the whole period. */
	day(el, event) {
		const { day } = el.dataset;
		if (event?.shiftKey && state.day && day && day !== state.day) [state.day, state.until] = [state.day, day].sort();
		else {
			state.day = !day || (state.day === day && !state.until) ? null : day;
			state.until = null;
		}
		loadInsights();
	},
	session: (el) => openSession(el.dataset.file, el.dataset.title),
	back: () => openSession(null),
	file: (el) => toggle(state.openFiles, el.dataset.path),
	/** Shows the result of a tool call: in the request after the one that made the call, or in the current context when no request followed. */
	async result(el) {
		const next = state.data.requests.find((request) => request.n > Number(el.dataset.n))?.n ?? null;
		await selectRequest(next);
		const i = (next == null ? state.data.current : state.view?.rows)?.findIndex((row) => row.id === el.dataset.id) ?? -1;
		if (i >= 0) actions.band({ dataset: { i } });
		else setError("The result is not in this context.");
	},
	kind(el) {
		state.kind = el.dataset.kind;
		render();
	},
	more() {
		state.shown += SESSIONS_STEP;
		render();
	},
};

document.addEventListener("click", (event) => {
	const el = event.target.closest("[data-act]");
	if (el) actions[el.dataset.act]?.(el, event);
});
addEventListener("hashchange", () => {
	state.page = location.hash === "#insights" ? "insights" : "context";
	if (state.page === "insights" && !state.insights) loadInsights();
	else render();
});
$("request").addEventListener("change", (event) => selectRequest(event.target.value ? Number(event.target.value) : null));
for (const id of ["pick", "order", "filter", "search", "group", "fleet-search", "file-filter", "board-search"]) $(id).addEventListener("input", render);
// Enter in the picker opens the first request that it found.
$("pick").addEventListener("keydown", (event) => {
	if (event.key === "Enter") $("picks").querySelector("[data-act]")?.click();
});
$("command-filter").addEventListener("input", (event) => {
	state.lens = { ...state.lens, text: event.target.value.trim() };
	render();
});
// The find box of an opened item: the item is drawn again with the matches marked. Enter goes to the next match, with Shift to the one before.
document.addEventListener("input", (event) => {
	const i = event.target.dataset.find;
	if (i != null) setViewer(Number(i), () => ({ find: event.target.value, at: 0 }));
	// The search box of the tools that a request declared.
	if (event.target.dataset.decls != null) {
		state.declFind = event.target.value;
		render();
	}
});
document.addEventListener("keydown", (event) => {
	const i = event.target.dataset.find;
	if (i != null && event.key === "Enter") actions.find({ dataset: { i, by: event.shiftKey ? -1 : 1 } });
});
$("base").addEventListener("change", (event) => {
	state.diff = event.target.value;
	if (state.request == null) render();
	else selectRequest(state.request);
});
// A view default is saved when it is chosen, and the page shows it at once.
$("choices").addEventListener("change", async (event) => {
	const { setting } = event.target.dataset;
	const value = event.target.value;
	try {
		const outcome = await api("setting", {}, { setting, value });
		$("choices-note").textContent = outcome.message;
		if (outcome.level !== "error") {
			applyDefaults({ [setting]: value });
			// The diff and the lines under the trend are those of the request: load() reads it again.
			if (setting === "trend" || setting === "diff") state.view = null;
			// Insights reads the sessions of the period when it opens.
			if (setting === "period") state.insights = null;
		}
	} catch (error) {
		$("choices-note").textContent = error.message;
	}
	// After an error the select shows the stored value again.
	painted.delete("choices");
	load();
});
for (const id of ["project", "sort"]) $(id).addEventListener("change", loadInsights);

const form = $("settings-form");
form.addEventListener("input", () => {
	form.dataset.dirty = "1";
});
form.addEventListener("submit", async (event) => {
	event.preventDefault();
	const notes = [];
	let failed = false;
	for (const field of form.querySelectorAll("[name]")) {
		if (field.value === field.dataset.was) continue;
		try {
			const outcome = await api("setting", {}, { setting: field.name, value: field.value });
			notes.push(outcome.message);
			if (outcome.level === "error") failed = true;
			else field.dataset.was = field.value;
		} catch (error) {
			notes.push(error.message);
			failed = true;
		}
	}
	$("settings-note").textContent = notes.join(" ") || "Nothing changed.";
	// After an error the form keeps what the user typed.
	if (!failed) {
		delete form.dataset.dirty;
		delete form.dataset.seen;
	}
	load();
});

$("other").innerHTML = `This is a saved session. It is read-only. <a data-act="back">Back to the current session</a>`;
// The server sends a message when the current session changed.
const events = new EventSource(`api/events?t=${encodeURIComponent(token)}`);
events.onmessage = () => {
	if (!state.session) load();
};
events.onerror = () => setError("The connection to pi is lost. The page shows the last state it loaded. Run /context web again when pi is back.");
events.onopen = () => setError("");
load();
if (state.page === "insights") loadInsights();
