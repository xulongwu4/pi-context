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
/** The events that the trend marks on the bar after them. The first that a bar has is shown. */
const MARKS = { compaction: "✂", drop: "▾", restore: "▴" };
const TASK_STATES = [["in_progress", "In progress"], ["pending", "Pending"], ["done", "Done"]];

const state = {
	page: location.hash === "#insights" ? "insights" : "context",
	/** The saved session on show, as { file, title }. Null: the current session. */
	session: null,
	data: null,
	/** Number of the request in the browser. Null: the current context. */
	request: null,
	/** What the server said about that request. */
	view: null,
	/** Context Trend: one bar for each human input, a bar as the change since the bar before, the whole session in the width. */
	trend: { byTurn: false, delta: false, fit: false },
	/** Order of the tools: calls, schema or name. */
	toolOrder: "calls",
	/** Order of the files: ops, recent or name. */
	fileOrder: "ops",
	/** The kind of operation whose files File Activity lists. Empty: every file. */
	fileKind: "",
	/** The status whose runs Command Executions lists. Empty: every run. */
	commandStatus: "",
	/** Index in the commands of the run that Command Executions highlights. */
	run: null,
	/** What the diff of a request compares with: the request before it, or with "input" the last request before its human input. */
	diff: "request",
	/** The part of the replies that the Context Browser keeps: reasoning, toolCalls or answers. Empty: every item. */
	reply: "",
	/** Collaboration Timeline: the earliest event first, and the events whose body is open. */
	earliest: false,
	openEvents: new Set(),
	/** Tasks Board: the state it lists (empty: every state), the open items, and the id of the highlighted task. */
	taskState: "",
	openTasks: new Set(),
	task: null,
	/** Whether the page took the view defaults of the settings. */
	started: false,
	openCats: new Set(),
	openItems: new Set(),
	/** Paths of the files whose operations File Activity lists. */
	openFiles: new Set(),
	/** The opened items as { text, call }; `call` describes the call of a tool result. */
	texts: new Map(),
	/** The kind of event that Context Events lists. Empty: every kind. */
	kind: "",
	insights: null,
	/** Length of the Insights period in days, or "all". */
	days: 30,
	/** The day that Insights is narrowed to, as YYYY-MM-DD. Null: the whole period. */
	day: null,
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
	body.innerHTML = html;
	body.scrollTop = top;
	for (const el of body.querySelectorAll("[data-keep]")) el.scrollLeft = kept.get(el.dataset.keep) ?? el.scrollWidth;
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

const tiles = (list) =>
	`<div class="tiles">${list.map(([value, label, sub = ""]) => `<div class="tile"><b>${esc(value)}</b><span>${esc(label)}</span><small>${esc(sub)}</small></div>`).join("")}</div>`;

/** Names with counts, the largest first. */
function pills(title, items, max = 8) {
	if (items.length === 0) return "";
	const sorted = [...items].sort((a, b) => b[1] - a[1]);
	const more = sorted.length > max ? `<span class="pill muted">+${sorted.length - max} more</span>` : "";
	const shown = sorted.slice(0, max).map(([name, count]) => `<span class="pill">${esc(name)} <b>${count}</b></span>`);
	return `<div class="pills"><span class="muted">${title}</span>${shown.join("")}${more}</div>`;
}

/** A table. Cells are HTML. A heading that starts with ">" aligns its column to the right. */
function table(head, rows, empty = "Nothing yet.") {
	if (rows.length === 0) return `<p class="muted">${empty}</p>`;
	const right = head.map((title) => title.startsWith(">"));
	const cells = (row, tag) => row.map((cell, i) => `<${tag}${right[i] ? ' class="r"' : ""}>${cell}</${tag}>`).join("");
	const titles = cells(head.map((title) => title.replace(/^>/, "")), "th");
	const more = rows.length > MAX_LIST ? `<p class="muted">The first ${MAX_LIST} of ${rows.length}.</p>` : "";
	const lines = rows.slice(0, MAX_LIST).map((row) => `<tr>${cells(row, "td")}</tr>`);
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

/** Index of the run with the longest wall time; -1 when no run has one. */
function slowest(commands) {
	let index = -1;
	commands.forEach((command, i) => {
		if (command.ms != null && (index < 0 || command.ms > commands[index].ms)) index = i;
	});
	return index;
}

const missText = (miss) => `≈${tok(miss.tokens)} tokens billed again, ≈${cost(miss.cost)} extra, after ${dur(miss.idleMs)} without a request`;

// The cards of the Context page. Each returns HTML for the data `d` of a session.

function statsCard(d) {
	const programs = new Map();
	for (const command of d.commands) programs.set(command.program, (programs.get(command.program) ?? 0) + 1);
	const compactions = d.events.filter((event) => /compact/i.test(event.kind)).length;
	const misses = d.cache.misses ? `${d.cache.misses} misses, ≈${cost(d.cache.cost)} extra` : "no misses";
	const top = tiles([
		[d.userInputs, "Human inputs"],
		[d.requests.length, "Requests"],
		[d.toolCalls, "Tool calls", `${d.toolErrors} errors`],
		[cost(d.totals.cost), "Cost"],
		[pct(d.cache.rate, 1), "Read from cache", misses],
		[d.events.length, "Context events", `${compactions} compactions`],
	]);
	return top + pills("Tools", d.tools.map((tool) => [tool.name, tool.calls + tool.nested])) + pills("Programs", [...programs]);
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
	return `<div class="split">${donut(parts, dur(timing.activeMs), "active")}${legend(parts)}</div>`;
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
	return `<div class="between"><span><b class="big">${tok(size)}</b>${window ? " / " + tok(window) : ""} tokens</span>${used}</div><div class="bar">${bar.join("")}${tail}</div>${kept}${legend(parts)}<p class="muted">${note}</p>`;
}

function trendCard(d) {
	const bars = d.trend;
	if (bars.length === 0) return `<p class="muted">No requests yet.</p>`;
	const { byTurn, delta, fit } = state.trend;
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
		const covered = d.requests.slice((bars[i - 1]?.index ?? -1) + 1, bar.index + 1);
		// A compaction, a drop and a restore are marked on the first bar after them.
		const marks = bar.marks ?? [];
		const mark = MARKS[Object.keys(MARKS).find((kind) => marks.includes(kind))];
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
			`#${request.n} · ${clock(request.time)} · ${request.model}`,
			delta ? `change ${bar.value < 0 ? "−" : "+"}${tok(Math.abs(bar.value))}` : "",
			`sent ${tok(request.context)}, ${pct(request.cacheRead, request.context)} from cache · output ${tok(request.output)} · ${cost(request.cost)}`,
			bar.ms == null ? "" : `took ${dur(bar.ms)}`,
			marks.length ? `since the bar before: ${marks.join(", ")}` : "",
			miss ? "cache miss: " + missText(miss) : "",
		];
		const on = covered.some((r) => r.n === state.request);
		return `<div class="col${on ? " on" : ""}" data-act="request" data-n="${request.n}" title="${esc(tip.filter(Boolean).join("\n"))}"><b>${mark ?? (miss ? "!" : "")}</b>${half(more, up, 1)}${down ? half(less, down, -1) : ""}${longest ? `<u style="--h:${((bar.ms ?? 0) / longest) * 100}%"></u>` : ""}</div>`;
	};
	// The selected request: what the provider reported, and the estimates of pi-context with the categories.
	const picked = d.requests.find((request) => request.n === state.request);
	const reported = picked
		? pairs([[`#${picked.n}, provider-reported`, ""], ["Input", tok(picked.input)], ["Cache read", tok(picked.cacheRead)], ["Cache write", tok(picked.cacheWrite)], ["Output", tok(picked.output)]])
		: "";
	// As in the bars, the recorded composition is scaled to the size that the provider reported.
	const recorded = picked?.sums ? CATS.reduce((total, cat) => total + (picked.sums[cat] ?? 0), 0) : 0;
	const estimate = (cat) => (recorded > 0 ? ` ≈${tok(((picked.sums[cat] ?? 0) * picked.context) / recorded)}` : "");
	const key = CATS.map((cat) => `<span class="pill"><i class="dot" style="background:${COLORS[cat]}"></i> ${esc(labels[cat])}${estimate(cat)}</span>`).join("");
	const what = `${delta ? "The change of the tokens sent since the bar before: growth above the line, the rest below it. One bar for" : "Tokens sent by"} ${byTurn ? "the last request of each human input" : "each request"}.`;
	const note = `${what} Click a bar to open the request in the Context Browser. Grey: not recorded by pi-context. ✂ compaction, ▾ drop, ▴ restore, ! cache miss.${longest ? ` The strip under a bar is its duration: the longest took ${dur(longest)}.` : ""}${picked?.sums ? ` ≈ figures: the estimated composition of request #${picked.n}.` : ""}`;
	const axis = `<div class="axis${longest ? " timed" : ""}"><span>${delta ? "+" : ""}${tok(up)}</span><span>${down ? "−" + tok(down) : 0}</span></div>`;
	// What the selected request did. Each line opens what it tells of in the Context Browser.
	const brief = state.view?.brief;
	const line = (name, text, act, title) => `<div ${act} title="${title}"><b>${name}</b><span>${esc(text)}</span></div>`;
	const told = brief
		? `<div class="brief">${line("User", brief.user, brief.first == null ? "" : `data-act="request" data-n="${d.requests[brief.first]?.n}"`, "Open the first request of the human input")}${line("In", brief.added, `data-act="added"`, "Show the first item added since the request before")}${line("Out", brief.reply, `data-act="reply"`, "Show the answer in the context of the next request")}</div>`
		: "";
	return `<div class="trend">${axis}<div class="cols${fit ? " fit" : ""}" data-keep="trend">${bars.map(column).join("")}</div></div>${told}${reported}<div class="pills">${key}</div><p class="muted">${note}</p>`;
}

/** Number of the first request that carried the row: the first one made after the message of the row was created. */
const firstRequest = (row) => (row.time == null ? undefined : state.data.requests.find((request) => request.time > row.time)?.n);

/** One item of the context. With `flat`, the item is in a list of all categories and shows its category. */
function itemHtml({ row, i, mark }, factor, canDrop, flat) {
	const key = keyOf(row);
	const open = state.openItems.has(key);
	const button = canDrop && row.id ? dropButton([row.id], !row.dropped) : "";
	const from = firstRequest(row);
	const first = from == null ? "" : `<span class="from" title="Request #${from} was the first to carry this item">@${from}</span>`;
	const category = flat ? `<i class="dot" style="background:${COLORS[row.cat]}" title="${esc(labels[row.cat])}"></i>` : "";
	const line = `<div class="item${row.dropped ? " dropped" : ""}${flat ? " flat" : ""}" data-act="item" data-i="${i}"><span class="mark">${mark}</span><span class="pos" title="Position in the prompt">#${i + 1}</span>${category}<span class="lbl">${esc(row.label)}</span><span class="pv">${esc(row.preview)}</span>${first}${button}<span class="tok">≈${tok(row.tokens * factor)}</span></div>`;
	if (!open) return line;
	const { text = "Loading…", call } = state.texts.get(key) ?? {};
	// A tool result comes with its call: the tool, the outcome, the size of the result and the arguments.
	const badge = call?.status === "error" ? `<span class="bad">error</span>` : `<span class="good">OK</span>`;
	const about = call ? `<div class="call"><b>${esc(call.tool)}</b>${badge}<span class="muted">${call.lines} ${call.lines === 1 ? "line" : "lines"}</span></div>` : "";
	const args = call?.args == null ? "" : `<small class="cap">Arguments</small><pre>${esc(call.args)}</pre><small class="cap">Result</small>`;
	return `${line}${about}${args}<pre>${esc(text)}</pre>`;
}

function browserCard(d) {
	const request = d.requests.find((r) => r.n === state.request);
	const view = request ? state.view : { rows: d.current, factor: d.factor };
	if (!view) return `<p class="muted">Loading…</p>`;
	const head = [];
	if (request) {
		head.push(
			pairs([
				["Time", clock(request.time)],
				["Model", request.model],
				["Sent", tok(request.context)],
				["From cache", pct(request.cacheRead, request.context)],
				["Output", tok(request.output)],
				["Took", request.ms == null ? "?" : dur(request.ms)],
				["Cost", cost(request.cost)],
			]),
		);
		if (request.miss) head.push(`<p class="warn">Cache miss: ${missText(request.miss)}.</p>`);
		if (view.rebuilt) head.push(`<p class="muted">Rebuilt from the session: pi-context has no record of what this request sent.</p>`);
		if (view.marks) {
			const count = (mark) => view.marks.filter((m) => m === mark).length;
			const base = view.base === "input" ? "the last request before the human input" : "the request before";
			head.push(pairs([["Compared with", `#${view.since}, ${base}`], ["+ added", count("+")], ["~ changed", count("~")], ["− removed", view.removed.length]]));
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
	const items = view.rows.map((row, i) => ({ row, i, mark: view.marks?.[i] ?? "" })).filter(({ row }) => passes(row));
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
	if (order === "flat") {
		const badges = CATS.filter(badge).map((cat) => `<span class="pill"><i class="dot" style="background:${COLORS[cat]}"></i> ${esc(labels[cat])} ${badge(cat)}</span>`);
		if (badges.length > 0) head.push(`<div class="pills">${badges.join("")}</div>`);
		const list = items.map((item) => itemHtml(item, view.factor, canDrop, true)).join("");
		return head.join("") + (list || `<p class="muted">Nothing matches.</p>`) + removed;
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
		return open ? title + own.map((item) => itemHtml(item, view.factor, canDrop)).join("") : title;
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
	const rows = [...d.inputs].reverse().map((input) => [
		input.first >= 0 ? `<a data-act="request" data-n="${d.requests[input.first].n}">#${input.n}</a>` : "#" + input.n,
		clock(input.time),
		clip(input.preview),
		input.requests,
		input.toolCalls,
		tok(input.sent),
		tok(input.output),
		cost(input.cost),
		dur(input.ms),
	]);
	return table(["", "Time", "Input", ">Requests", ">Tools", ">Sent", ">Output", ">Cost", ">Took"], rows, "No input yet.");
}

function eventsCard(d) {
	if (d.events.length === 0) return `<p class="muted">No injection, compaction, drop, model or branch events on this branch.</p>`;
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
	const where = (event) => (event.after ? `<a data-act="request" data-n="${event.after}" title="Open the request in the Context Browser">#${event.after}</a>` : "start");
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
			shown.map((event) => [clock(event.time), where(event), esc(event.kind), change(event.delta), esc(event.detail)]),
		)
	);
}

function filesCard(d) {
	const ops = (file) => FILE_KINDS.reduce((sum, [kind]) => sum + file[kind], 0);
	const last = (file) => file.ops.reduce((time, op) => Math.max(time, op.time), 0);
	const names = Object.fromEntries(FILE_KINDS.map(([kind, , name]) => [kind, name]));
	// The orders of fileRows() of src/analyze.ts.
	const orders = { ops: (a, b) => ops(b) - ops(a), recent: (a, b) => last(b) - last(a), name: (a, b) => a.path.localeCompare(b.path) };
	const kind = state.fileKind;
	const kinds = chips("fileKind", [["All", d.files.length, ""], ...FILE_KINDS.map(([each, label]) => [label, d.files.filter((file) => file[each] > 0).length, each])]);
	const added = (n) => (n == null ? "" : `<span class="good">+${n}</span>`);
	const removed = (n) => (n == null ? "" : `<span class="bad">−${n}</span>`);
	const rows = d.files
		.filter((file) => !kind || file[kind] > 0)
		.sort(orders[state.fileOrder] ?? orders.ops)
		.flatMap((file) => {
			const open = state.openFiles.has(file.path);
			const known = file.added + file.removed > 0;
			const name = `<a data-act="file" data-path="${esc(file.path)}" title="Show the operations on the file">${open ? "▾" : "▸"} ${clip(file.path, "mono")}</a>`;
			const row = [name, ...FILE_KINDS.map(([each]) => file[each] || ""), known ? added(file.added) : "", known ? removed(file.removed) : ""];
			if (!open) return [row];
			// Newest first.
			const log = [...file.ops].reverse().map((op) => {
				const result = `<a data-act="result" data-n="${op.request}" data-id="${esc(op.id)}" title="Show the tool result in the Context Browser">#${op.request}</a>`;
				const failed = op.error ? ` <span class="bad">failed</span>` : "";
				const hits = op.hits == null ? "" : `, ${op.hits} ${op.hits === 1 ? "hit" : "hits"}`;
				return [`<span class="op">${clock(op.time)} ${result} ${names[op.op]} by ${esc(op.tool)}${hits}${failed}</span>`, "", "", "", "", "", added(op.added), removed(op.removed)];
			});
			return [row, ...log];
		});
	const note = d.unresolvedEdits ? `<p class="muted">${d.unresolvedEdits} edits by anchor could not be matched to a file.</p>` : "";
	const empty = kind && d.files.length ? "No file with such an operation." : "No file activity yet.";
	return `<div class="controls">${kinds}</div>` + table(["File", ">Reads", ">Writes", ">Edits", ">Searches", ">Images", ">Added", ">Removed"], rows, empty) + note;
}

function commandsCard(d) {
	const programs = new Map();
	for (const command of d.commands) programs.set(command.program, (programs.get(command.program) ?? 0) + 1);
	const status = (ok) => (ok == null ? "" : ok ? `<span class="good">ok</span>` : `<span class="bad">failed</span>`);
	// A short command shows tenths of a second.
	const took = (ms) => (ms == null ? "" : ms < 10_000 ? (ms / 1000).toFixed(1) + "s" : dur(ms));
	const by = (command) =>
		command.id
			? `<a data-act="result" data-n="${command.request}" data-id="${esc(command.id)}" title="Show the tool result in the Context Browser">#${command.request}</a>`
			: `<span class="muted">user</span>`;
	const counts = { ok: 0, failed: 0, unknown: 0 };
	for (const command of d.commands) counts[commandStatus(command)]++;
	// Newest first.
	const listed = d.commands
		.map((command, i) => ({ command, i }))
		.filter(({ command }) => !state.commandStatus || commandStatus(command) === state.commandStatus)
		.reverse();
	// The table shows its first rows: it starts late enough to show the highlighted run.
	const skip = Math.max(0, listed.findIndex(({ i }) => i === state.run) - MAX_LIST + 1);
	const rows = listed
		.slice(skip)
		.map(({ command, i }) => [
			`<span class="run${i === state.run ? " hit" : ""}">${clock(command.time)}</span>`,
			by(command),
			status(command.ok),
			took(command.ms),
			esc(command.program),
			clip(command.command, "mono"),
		]);
	const timed = d.commands.filter((command) => command.ms != null);
	const failed = d.commands.filter((command) => command.ok === false).length;
	const time = timed.length ? `, ${dur(timed.reduce((sum, command) => sum + command.ms, 0))}` : "";
	const title = `${d.commands.length} runs of ${programs.size} programs, ${failed} failed${time}`;
	const statuses = chips("commandStatus", [["All", d.commands.length, ""], ["OK", counts.ok, "ok"], ["Failed", counts.failed, "failed"], ["Unknown", counts.unknown, "unknown"]]);
	const jump = (to, label, any, tip) => `<button data-act="run" data-to="${to}"${any ? "" : " disabled"} title="${tip}">${label}</button>`;
	const jumps = `<span class="muted">Go to</span>${jump("failed", "Failed", counts.failed, "Highlight the newest failed run, then the one before it")}${jump("slowest", "Slowest", timed.length, "Highlight the run with the longest wall time")}`;
	const newer = skip ? `<p class="muted">${skip} newer runs are not listed.</p>` : "";
	const empty = d.commands.length ? "No run with this status." : "No command yet.";
	return pills(title, [...programs]) + `<div class="controls">${statuses}${jumps}</div>` + newer + table(["Time", "Request", "", ">Took", "Program", "Command"], rows, empty);
}

function toolsCard(d) {
	const size = (tokens) => (tokens ? "≈" + tok(tokens) : "");
	const tools = d.toolRows.map((tool) => {
		const undeclared = tool.undeclared + (d.declared.includes(tool.name) ? 0 : tool.unchecked);
		const flag = undeclared ? ` <span class="warn" title="${undeclared} direct calls while the tool was not declared to the model">!</span>` : "";
		return [esc(tool.name) + flag, esc(tool.source), size(tool.schema * d.factor), tool.calls || "", tool.nested || "", tool.errors || "", size(tool.callTokens), size(tool.resultTokens)];
	});
	const sources = d.schemaSources.map((group) => [esc(group.source || "unknown"), group.tools, "≈" + tok(group.tokens * d.factor)]);
	const skills = d.skills.map((skill) => [clip(skill.name), skill.loads, "≈" + tok(skill.tokens)]);
	const models = [...d.models].sort((a, b) => b.cost - a.cost).map((model) => [esc(model.model), model.requests, tok(model.sent), tok(model.output), cost(model.cost)]);
	return [
		table(["Tool", "Source", ">Schema", ">Calls", ">In scripts", ">Errors", ">Arguments", ">Results"], tools, "No tool yet."),
		sources.length ? "<h3>Tool schemas by source</h3>" + table(["Source", ">Tools", ">Tokens"], sources) : "",
		skills.length ? "<h3>Skills</h3>" + table(["Skill", ">Loads", ">Tokens"], skills) : "",
		"<h3>Models</h3>" + table(["Model", ">Requests", ">Sent", ">Output", ">Cost"], models, "No request yet."),
	].join("");
}

// The subagents and the tasks of the session.

function agentsCard(d) {
	if (d.agents.length === 0) return `<p class="muted">No subagent in this session.</p>`;
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
		return `<div class="agent" style="margin-left:${(agent.depth ?? level) * 20}px"><div class="between"><b>${esc(agent.type)}</b><span class="${statusCss(agent.status)}">${esc(agent.status)}</span></div><div>${esc(agent.description)}</div><small class="mono">${esc(agent.model ?? "")}</small>${bar ? `<div class="bar">${bar}</div>` : ""}${pairs(facts)}${error}</div>`;
	};
	return `<div class="agents">${under(undefined, 0).map(card).join("")}</div>`;
}

/** Identifies an event of the timeline, so that it stays open when the data is loaded again. */
const eventKey = (event) => [event.time, event.kind, event.agent ?? "", event.title].join("|");

function timelineCard(d) {
	if (d.timeline.length === 0) return `<p class="muted">No delegation, message or task event in this session.</p>`;
	// An agent shows as its type; its id is in the tooltip.
	const who = (id) => (id ? (d.agents.find((agent) => agent.id === id)?.type ?? id.slice(0, 8)) : "");
	const needle = $("fleet-search").value.trim().toLowerCase();
	const found = d.timeline.filter((event) => !needle || `${event.kind} ${who(event.agent)} ${event.title} ${event.body ?? ""}`.toLowerCase().includes(needle));
	// The data has the earliest event first.
	if (!state.earliest) found.reverse();
	const line = (event) => {
		const key = eventKey(event);
		const open = event.body && state.openEvents.has(key);
		const row = `<div class="item flat" data-act="event" data-key="${esc(key)}"><span class="fold">${event.body ? (open ? "▾" : "▸") : ""}</span><span class="pos">${clock(event.time)}</span><span class="pill">${esc(event.kind)}</span><span class="lbl" title="${esc(event.agent ?? "")}">${esc(who(event.agent))}</span><span class="sub" title="${esc(event.title)}">${esc(event.title)}</span></div>`;
		return open ? `${row}<pre>${esc(event.body)}</pre>` : row;
	};
	const more = found.length > MAX_LIST ? `<p class="muted">The first ${MAX_LIST} of ${found.length}.</p>` : "";
	return found.length ? `<div class="scroll">${found.slice(0, MAX_LIST).map(line).join("")}</div>${more}` : `<p class="muted">No event matches.</p>`;
}

function boardCard(d) {
	const items = d.board.flatMap((group) => group.items);
	if (items.length === 0) return `<p class="muted">No task and no delegation in this session.</p>`;
	const picked = state.taskState;
	const states = chips("taskState", [["All", items.length, ""], ...TASK_STATES.map(([value, label]) => [label, items.filter((item) => item.state === value).length, value])]);
	const line = (item) => {
		const more = item.description || item.reply;
		const open = more && state.openTasks.has(item.id);
		const blockers = item.blockedBy.map((id) => `<a data-act="blocker" data-id="${esc(id)}" title="Show the task">#${esc(id)}</a>`);
		const blocked = blockers.length ? `<span class="warn">blocked by ${blockers.join(", ")}</span>` : "";
		// A delegation has the id of its agent.
		const id = item.agent ? item.id.slice(0, 8) : "#" + item.id;
		const row = `<div class="item flat${item.id === state.task ? " hit" : ""}" data-act="task" data-id="${esc(item.id)}"><span class="fold">${more ? (open ? "▾" : "▸") : ""}</span><span class="pos" title="${esc(item.id)}">${esc(id)}</span><span class="sub" title="${esc(item.subject)}">${esc(item.subject)}</span>${blocked}<span class="${statusCss(item.status)}">${esc(item.status.replace(/_/g, " "))}</span></div>`;
		if (!open) return row;
		const reply = item.reply ? `<small class="cap">Reply</small><pre>${esc(item.reply)}</pre>` : "";
		return row + (item.description ? `<pre>${esc(item.description)}</pre>` : "") + reply;
	};
	const groups = d.board.map((group) => [group.owner, group.items.filter((item) => !picked || item.state === picked)]).filter(([, own]) => own.length > 0);
	const list = groups.map(([owner, own]) => `<h3>${esc(owner)} · ${own.length}</h3>${own.map(line).join("")}`).join("");
	return `<div class="controls">${states}</div>` + (list || `<p class="muted">No task in this state.</p>`);
}

// The Insights page.

/** A tally of tools, programs or skills: name, uses, time of the last use. A click on a name lists the sessions that used it. */
const rank = (kind, items, empty) => {
	const on = (name) => (state.uses?.kind === kind && state.uses.name === name ? ' class="on"' : "");
	const line = ([name, count, last]) =>
		`<span${on(name)} data-act="uses" data-kind="${kind}" data-name="${esc(name)}" style="--w:${(count / items[0][1]) * 100}%" title="${esc(name)}: click to list only the sessions that used it">${esc(name)}</span><small title="Last used">${last ? date(last) : ""}</small><b class="tok">${count}</b>`;
	return items.length ? `<div class="rank">${items.map(line).join("")}</div>` : `<p class="muted">${empty}</p>`;
};

/** The local day as YYYY-MM-DD. */
const today = () => {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

/** The days of the period as a calendar: one column per week, Monday first, shaded by the tokens of the day. */
function daysCard(ins) {
	const days = ins.daily;
	if (days.length === 0) return `<p class="muted">No day in the period.</p>`;
	const [year, month, date] = days[0].day.split("-").map(Number);
	const offset = (new Date(year, month - 1, date).getDay() + 6) % 7;
	const weeks = Math.ceil((offset + days.length) / 7);
	const peak = Math.max(...days.map((day) => day.tokens), 1);
	const cell = (day) => {
		if (!day) return "<span></span>";
		const tip = `${day.day}: ${day.requests} requests, ${tok(day.tokens)} tokens, ${cost(day.cost)}`;
		const shade = day.tokens ? `<b style="opacity:${0.2 + (0.8 * day.tokens) / peak}"></b>` : "";
		return `<i${day.day === ins.day ? ' class="on"' : ""} data-act="day" data-day="${day.day}" title="${tip}">${shade}</i>`;
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
	const note = "Click a day to narrow the page to it. Click it again to show the whole period.";
	return `<div class="scroll-x" data-keep="days"><div class="cal months" style="--weeks:${weeks}">${months.join("")}</div><div class="cal" style="--weeks:${weeks}">${cells.join("")}</div></div><p class="muted">${note}</p>`;
}

function renderInsights() {
	for (const button of document.querySelectorAll('[data-act="days"]')) button.classList.toggle("on", button.dataset.days === String(state.days));
	document.querySelector('[data-act="today"]').classList.toggle("on", state.day === today());
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
			ins.day ? [ins.day, "Day"] : [ins.activeDays, "Active days"],
			[pct(ins.cacheRate, 1), "Read from cache"],
			[ins.userInputs, "Human inputs"],
			[ins.toolCalls, "Tool calls"],
			[dur(ins.activeMs), "Active time", "of the recorded turns"],
		]) + (ins.day ? `<p>The figures cover ${ins.day} only. <a data-act="day" data-day="${ins.day}">Show the whole period</a></p>` : ""),
	);
	paint("i-days", daysCard(ins));
	const sent = totalOf(ins.composition.sums);
	const parts = catParts(ins.composition.sums);
	const recorded = `${ins.composition.requests} of ${ins.requests} requests, those recorded by pi-context. Each request sends the whole context again.`;
	paint(
		"i-composition",
		sent ? `<div class="split">${donut(parts, tok(sent), "sent")}${legend(parts)}</div><p class="muted">${recorded}</p>` : `<p class="muted">pi-context recorded no request ${ins.day ? "on this day" : "in the period"}.</p>`,
	);
	const most = Math.max(...ins.week.map((day) => day.tokens), 1);
	const column = (day) =>
		`<div title="${day.requests} requests"><span>${tok(day.tokens)}</span><i style="height:${(day.tokens / most) * 70}%"></i><span>${day.day.slice(5)}</span><span>${cost(day.cost)}</span></div>`;
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
	paint("i-programs", `<h3>Programs</h3>${rank("programs", ins.programs, "No command in the period.")}<h3>Skills</h3>${rank("skills", ins.skills, "No skill loaded in the period.")}`);
	const needle = $("search").value.trim().toLowerCase();
	const found = ins.sessions.filter((session) => !needle || `${session.name} ${session.cwd}`.toLowerCase().includes(needle));
	const card = (session) => {
		const title = session.name || session.cwd.split("/").pop() || session.cwd;
		const open = session.file ? ` data-act="session" data-file="${esc(session.file)}" data-title="${esc(title)}"` : "";
		// The composition of the last recorded request of the session.
		const profile = session.profile ?? [];
		const sum = profile.reduce((total, tokens) => total + tokens, 0);
		const bar = CATS.map((cat, i) => (profile[i] > 0 ? `<i style="width:${(profile[i] / sum) * 100}%;background:${COLORS[cat]}" title="${esc(labels[cat] ?? cat)} ≈${tok(profile[i])}"></i>` : "")).join("");
		const context = `<div class="between"><div class="bar"${sum ? "" : ' title="The composition is not recorded"'}>${bar}</div><small class="tok" title="Tokens that the last request sent">context ${tok(session.context)}</small></div>`;
		return `<div class="session"${open}><b>${esc(title)}</b><small class="mono">${esc(session.cwd)}</small>${context}<div class="between"><small>${date(session.end)}</small><span>${session.requests} requests · ${tok(session.tokens)} · ${cost(session.cost)}</span></div></div>`;
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

/** Makes the page show what view defaults say. `view` has some of period, trend, mode, tools, files and diff. */
function applyDefaults(view) {
	if (view.period) {
		state.days = view.period === "all" ? "all" : Number(view.period);
		state.day = null;
	}
	if (view.trend) state.trend.byTurn = view.trend === "input";
	if (view.mode) state.trend.delta = view.mode === "change";
	if (view.tools) state.toolOrder = view.tools;
	if (view.files) state.fileOrder = view.files;
	if (view.diff) state.diff = view.diff;
}

function syncRequests(d) {
	const select = $("request");
	const made = `${state.session?.file ?? ""}:${d.requests.length}`;
	if (select.dataset.made !== made) {
		select.dataset.made = made;
		const options = [...d.requests].reverse().map((r) => `<option value="${r.n}">#${r.n} · ${clock(r.time)} · ${tok(r.context)}</option>`);
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
	$("base").value = state.diff;
	fillSettings(d);
	if (!d.readOnly) fillChoices(d);
	paint("stats", statsCard(d));
	paint("tokens", tokensCard(d));
	paint("timing", timingCard(d));
	paint("current", currentCard(d));
	for (const button of document.querySelectorAll("[data-act=trend]")) button.classList.toggle("on", state.trend[button.dataset.key]);
	paint("trend", trendCard(d));
	paint("browser", browserCard(d));
	paint("hints", hintsCard(d));
	paint("turns", turnsCard(d));
	paint("events", eventsCard(d));
	for (const button of document.querySelectorAll("[data-act=files]")) button.classList.toggle("on", state.fileOrder === button.dataset.order);
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
		state.texts.set(key, { call, text: text ?? `${row.preview}\n\n(Only this preview is available. The item was not found in the saved session.)` });
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
	state.task = null;
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
		const insights = await api("insights", { days: state.days, day: state.day ?? "", project: $("project").checked ? 1 : 0, sort: $("sort").value, uses });
		if (mine === reading) state.insights = insights;
	} catch (error) {
		setError(error.message);
	}
	render();
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
	order(el) {
		state.toolOrder = el.dataset.order;
		load();
	},
	files(el) {
		state.fileOrder = el.dataset.order;
		render();
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
		// A run that the chips filter out is not in the list.
		if (state.commandStatus && commandStatus(commands[run]) !== state.commandStatus) state.commandStatus = "";
		render();
		document.querySelector("#commands .hit")?.scrollIntoView({ block: "center" });
	},
	earliest() {
		state.earliest = !state.earliest;
		render();
	},
	event: (el) => toggle(state.openEvents, el.dataset.key),
	task: (el) => toggle(state.openTasks, el.dataset.id),
	/** Shows the task that blocks another one. */
	blocker(el) {
		state.task = el.dataset.id;
		const item = state.data.board.flatMap((group) => group.items).find((each) => each.id === state.task);
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
		loadInsights();
	},
	today() {
		state.day = state.day === today() ? null : today();
		loadInsights();
	},
	day(el) {
		state.day = state.day === el.dataset.day ? null : el.dataset.day;
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
	if (el) actions[el.dataset.act]?.(el);
});
addEventListener("hashchange", () => {
	state.page = location.hash === "#insights" ? "insights" : "context";
	if (state.page === "insights" && !state.insights) loadInsights();
	else render();
});
$("request").addEventListener("change", (event) => selectRequest(event.target.value ? Number(event.target.value) : null));
for (const id of ["order", "filter", "search", "group", "fleet-search"]) $(id).addEventListener("input", render);
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
