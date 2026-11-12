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
const INSIGHT_CARDS = ["i-kpi", "i-week", "i-heat", "i-models", "i-projects", "i-tools", "i-programs", "i-sessions"];
/** Most rows a table shows, and most removed items the browser lists. */
const MAX_LIST = 200;
/** Most item contents kept after they were opened. */
const MAX_TEXTS = 50;
const SESSIONS_STEP = 60;

const state = {
	page: location.hash === "#insights" ? "insights" : "context",
	/** The saved session on show, as { file, title }. Null: the current session. */
	session: null,
	data: null,
	/** Number of the request in the browser. Null: the current context. */
	request: null,
	/** What the server said about that request. */
	view: null,
	openCats: new Set(),
	openItems: new Set(),
	texts: new Map(),
	insights: null,
	days: 30,
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
	return `<div class="between"><span><b class="big">${tok(size)}</b>${window ? " / " + tok(window) : ""} tokens</span>${used}</div><div class="bar">${bar.join("")}</div>${legend(parts)}<p class="muted">${note}</p>`;
}

function trendCard(d) {
	const requests = d.requests;
	if (requests.length === 0) return `<p class="muted">No requests yet.</p>`;
	const max = Math.max(...requests.map((request) => request.context), 1);
	// A compaction is marked on the first request after it.
	const cuts = new Set();
	for (const event of d.events) {
		if (/compact/i.test(event.kind)) cuts.add(requests.find((request) => request.time >= event.time)?.n);
	}
	const column = (request) => {
		const stack = request.sums
			? CATS.filter((cat) => request.sums[cat] > 0).map((cat) => `<i style="flex:${request.sums[cat]};background:${COLORS[cat]}"></i>`).join("")
			: `<i style="flex:1;background:#9ca3af"></i>`;
		const tip = [
			`#${request.n} · ${clock(request.time)} · ${request.model}`,
			`sent ${tok(request.context)}, ${pct(request.cacheRead, request.context)} from cache · output ${tok(request.output)} · ${cost(request.cost)}`,
			cuts.has(request.n) ? "first request after a compaction" : "",
			request.miss ? "cache miss: " + missText(request.miss) : "",
		];
		const mark = cuts.has(request.n) ? "✂" : request.miss ? "!" : "";
		return `<div class="col${request.n === state.request ? " on" : ""}" data-act="request" data-n="${request.n}" title="${esc(tip.filter(Boolean).join("\n"))}"><b>${mark}</b><div class="stack" style="flex:0 0 ${(request.context / max) * 100}%">${stack}</div></div>`;
	};
	const key = CATS.map((cat) => `<span class="pill"><i class="dot" style="background:${COLORS[cat]}"></i> ${esc(labels[cat])}</span>`).join("");
	const note = "Tokens sent by each request. Click a bar to open the request in the Context Browser. Grey: not recorded by pi-context. ✂ compaction, ! cache miss.";
	return `<div class="trend"><div class="axis"><span>${tok(max)}</span><span>0</span></div><div class="cols" data-keep="trend">${requests.map(column).join("")}</div></div><div class="pills">${key}</div><p class="muted">${note}</p>`;
}

function itemHtml({ row, i, mark }, factor, canDrop) {
	const key = keyOf(row);
	const open = state.openItems.has(key);
	const button = canDrop && row.id ? dropButton([row.id], !row.dropped) : "";
	const line = `<div class="item${row.dropped ? " dropped" : ""}" data-act="item" data-i="${i}"><span class="mark">${mark}</span><span class="lbl">${esc(row.label)}</span><span class="pv">${esc(row.preview)}</span>${button}<span class="tok">≈${tok(row.tokens * factor)}</span></div>`;
	return open ? `${line}<pre>${esc(state.texts.get(key) ?? "Loading…")}</pre>` : line;
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
			head.push(pairs([[`Since request #${view.since}`, ""], ["+ added", count("+")], ["~ changed", count("~")], ["− removed", view.removed.length]]));
		}
	} else {
		head.push(`<p class="muted">${d.readOnly ? "The context after the last request." : "What the next request is assembled from."}</p>`);
	}
	const needle = $("filter").value.trim().toLowerCase();
	const bySize = $("order").value === "size";
	const items = view.rows
		.map((row, i) => ({ row, i, mark: view.marks?.[i] ?? "" }))
		.filter(({ row }) => !needle || `${row.label} ${row.preview}`.toLowerCase().includes(needle));
	const all = totalOf(sumBy(view.rows));
	const groups = CATS.map((cat) => {
		const own = items.filter((item) => item.row.cat === cat);
		if (own.length === 0) return "";
		if (bySize) own.sort((a, b) => b.row.tokens - a.row.tokens);
		const tokens = own.reduce((sum, item) => sum + item.row.tokens, 0);
		// A filter shows what it found.
		const open = needle ? true : state.openCats.has(cat);
		const change = view.delta?.[cat] ?? 0;
		const delta = change ? `<span class="${change > 0 ? "warn" : "good"}">≈${change > 0 ? "+" : "−"}${tok(Math.abs(change) * view.factor)}</span>` : "";
		const title = `<div class="cat" data-act="cat" data-cat="${cat}"><span>${open ? "▾" : "▸"}</span><i class="dot" style="background:${COLORS[cat]}"></i><b>${esc(labels[cat])} <small>${own.length} items</small></b>${delta}<span class="tok">≈${tok(tokens * view.factor)}</span><span class="share">${pct(tokens, all)}</span></div>`;
		return open ? title + own.map((item) => itemHtml(item, view.factor, !request && !d.readOnly)).join("") : title;
	});
	const gone = (row) =>
		`<div class="item"><span class="mark bad">−</span><span class="lbl">${esc(row.label)}</span><span class="pv">${esc(row.preview)}</span><span class="tok">≈${tok(row.tokens * view.factor)}</span></div>`;
	const removed = view.removed?.length ? `<h3>No longer in the request (${view.removed.length})</h3>${view.removed.slice(0, MAX_LIST).map(gone).join("")}` : "";
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

const eventsCard = (d) =>
	table(
		["Time", "Kind", "Detail"],
		d.events.map((event) => [clock(event.time), esc(event.kind), esc(event.detail)]),
		"No compaction, model or branch events on this branch.",
	);

function filesCard(d) {
	const ops = (file) => file.reads + file.writes + file.edits;
	const rows = [...d.files].sort((a, b) => ops(b) - ops(a)).map((file) => [clip(file.path, "mono"), file.reads || "", file.writes || "", file.edits || ""]);
	const note = d.unresolvedEdits ? `<p class="muted">${d.unresolvedEdits} edits by anchor could not be matched to a file.</p>` : "";
	return table(["File", ">Reads", ">Writes", ">Edits"], rows, "No file activity yet.") + note;
}

function commandsCard(d) {
	const programs = new Map();
	for (const command of d.commands) programs.set(command.program, (programs.get(command.program) ?? 0) + 1);
	const status = (ok) => (ok == null ? "" : ok ? `<span class="good">ok</span>` : `<span class="bad">failed</span>`);
	const rows = [...d.commands].reverse().map((command) => [clock(command.time), status(command.ok), esc(command.program), clip(command.command, "mono")]);
	return pills(`${d.commands.length} runs of ${programs.size} programs`, [...programs]) + table(["Time", "", "Program", "Command"], rows, "No command yet.");
}

function toolsCard(d) {
	const tools = [...d.tools]
		.sort((a, b) => b.calls + b.nested - (a.calls + a.nested))
		.map((tool) => {
			const undeclared = tool.undeclared + (d.declared.includes(tool.name) ? 0 : tool.unchecked);
			const flag = undeclared ? ` <span class="warn" title="${undeclared} direct calls while the tool was not declared to the model">!</span>` : "";
			const size = (tokens) => (tokens ? "≈" + tok(tokens) : "");
			return [esc(tool.name) + flag, tool.calls || "", tool.nested || "", tool.errors || "", size(tool.callTokens), size(tool.resultTokens)];
		});
	const skills = d.skills.map((skill) => [clip(skill.name), skill.loads, "≈" + tok(skill.tokens)]);
	const models = [...d.models].sort((a, b) => b.cost - a.cost).map((model) => [esc(model.model), model.requests, tok(model.sent), tok(model.output), cost(model.cost)]);
	return [
		table(["Tool", ">Calls", ">In scripts", ">Errors", ">Arguments", ">Results"], tools, "No tool call yet."),
		skills.length ? "<h3>Skills</h3>" + table(["Skill", ">Loads", ">Tokens"], skills) : "",
		"<h3>Models</h3>" + table(["Model", ">Requests", ">Sent", ">Output", ">Cost"], models, "No request yet."),
	].join("");
}

// The Insights page.

const rank = (items, empty) =>
	items.length
		? `<div class="rank">${items.map(([name, count]) => `<span style="--w:${(count / items[0][1]) * 100}%" title="${esc(name)}">${esc(name)}</span><b class="tok">${count}</b>`).join("")}</div>`
		: `<p class="muted">${empty}</p>`;

function renderInsights() {
	for (const button of document.querySelectorAll('[data-act="days"]')) button.classList.toggle("on", Number(button.dataset.days) === state.days);
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
			[ins.activeDays, "Active days"],
		]),
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
	paint("i-tools", rank(ins.tools, "No tool call in the period."));
	paint("i-programs", `<h3>Programs</h3>${rank(ins.programs, "No command in the period.")}<h3>Skills</h3>${rank(ins.skills, "No skill loaded in the period.")}`);
	const needle = $("search").value.trim().toLowerCase();
	const found = ins.sessions.filter((session) => !needle || `${session.name} ${session.cwd}`.toLowerCase().includes(needle));
	const card = (session) => {
		const title = session.name || session.cwd.split("/").pop() || session.cwd;
		const open = session.file ? ` data-act="session" data-file="${esc(session.file)}" data-title="${esc(title)}"` : "";
		return `<div class="session"${open}><b>${esc(title)}</b><small class="mono">${esc(session.cwd)}</small><div class="between"><small>${date(session.end)}</small><span>${session.requests} requests · ${tok(session.tokens)} · ${cost(session.cost)}</span></div></div>`;
	};
	const more = found.length > state.shown ? `<p><button data-act="more">Show more (${found.length - state.shown} left)</button></p>` : "";
	paint("i-sessions", found.length ? `<div class="sessions">${found.slice(0, state.shown).map(card).join("")}</div>${more}` : `<p class="muted">No session matches.</p>`);
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
		footer: d.footer.join(" "),
		prefix: d.config.systemPromptPrefix ?? "",
		suffix: d.config.systemPromptSuffix ?? "",
	};
	for (const [name, value] of Object.entries(values)) {
		form.elements[name].value = value;
		form.elements[name].dataset.was = form.elements[name].value;
	}
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
	fillSettings(d);
	paint("stats", statsCard(d));
	paint("tokens", tokensCard(d));
	paint("timing", timingCard(d));
	paint("current", currentCard(d));
	paint("trend", trendCard(d));
	paint("browser", browserCard(d));
	paint("hints", hintsCard(d));
	paint("turns", turnsCard(d));
	paint("events", eventsCard(d));
	paint("files", filesCard(d));
	paint("commands", commandsCard(d));
	paint("tools", toolsCard(d));
}

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
		const d = await api("data", params());
		labels = d.labels;
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
		const view = await api("request", params({ n }));
		if (state.request === n) state.view = view;
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
		const { text } = await api("text", params(live ? { i, v: state.data.version } : { i, n: state.request }));
		state.texts.set(key, text ?? `${row.preview}\n\n(Only this preview is available. The item was not found in the saved session.)`);
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
		const insights = await api("insights", { days: state.days, project: $("project").checked ? 1 : 0, sort: $("sort").value });
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
	cat: (el) => toggle(state.openCats, el.dataset.cat),
	item: (el) => openItem(Number(el.dataset.i)),
	async drop(el) {
		try {
			await api("drop", {}, { ids: JSON.parse(el.dataset.ids), dropped: el.dataset.dropped === "1" });
		} catch (error) {
			setError(error.message);
		}
		load();
	},
	days(el) {
		state.days = Number(el.dataset.days);
		loadInsights();
	},
	session: (el) => openSession(el.dataset.file, el.dataset.title),
	back: () => openSession(null),
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
for (const id of ["order", "filter", "search"]) $(id).addEventListener("input", render);
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
