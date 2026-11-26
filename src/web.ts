import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
	attentionLens,
	attentionOf,
	bare,
	baselineOf,
	briefOf,
	callOf,
	callView,
	diffRows,
	familyTotals,
	filesUpTo,
	fileTotals,
	fullOf,
	LABELS,
	MARK_KINDS,
	placeOf,
	places,
	programRanks,
	type RequestRec,
	replyCounts,
	type Row,
	scaleOf,
	schemaSources,
	sumTokens,
	TOOL_ORDERS,
	tokensPerSecond,
	toolRows,
	toolsAt,
	trendBars,
	type ViewData,
} from "./analyze.ts";
import { CHOICE_SETTINGS, CHOICES, choiceOf, DEFAULT_WARN_PERCENT } from "./config.ts";
import { Dna } from "./dna.ts";
import { viewJson } from "./export.ts";
import { agentDetail, boardOf, chainOf, fleetSummary, narrow } from "./fleet.ts";
import { footerItems } from "./footer.ts";
import { aggregate, type SessionSort } from "./insights.ts";
import type { OverlayHost } from "./overlay.ts";

/** The result of changing a setting, as a message for the user. */
export interface Outcome {
	message: string;
	level: "info" | "error";
}

export interface WebHost extends Pick<OverlayHost, "collect" | "isLive" | "loadSummaries" | "openSession" | "setDropped" | "cwd" | "sessionId" | "windowOf"> {
	/** Title of the current session. */
	title(): string;
	changeSetting(setting: string, value: string): Outcome;
}

export interface WebServer {
	/** Address of the page. It carries the access token. */
	url: string;
	/** Tells the open pages that the session changed. */
	changed(): void;
	close(): void;
}

/** The files of the page, by request path. */
const ASSETS: Record<string, [file: string, type: string]> = {
	"/": ["index.html", "text/html; charset=utf-8"],
	"/app.js": ["app.js", "text/javascript; charset=utf-8"],
	"/style.css": ["style.css", "text/css; charset=utf-8"],
};
const WEB_DIR = new URL("../web/", import.meta.url);
/** Least time between two change notices. Each notice makes an open page load the data again. */
const NOTIFY_MS = 2000;
const MAX_BODY = 1_000_000;
/** Requests whose rebuilt context is kept, so that opening items of a request does not rebuild it each time. */
const MAX_REBUILT = 4;
/** Sessions whose items for the DNA trend are kept. */
const MAX_DNA = 2;
const SORTS: SessionSort[] = ["recent", "cost", "tokens", "context"];
const USE_KINDS = ["tools", "programs", "skills"] as const;

type Route = (query: URLSearchParams, body: any) => unknown;

/** The data of one session, as collected at one time. */
interface View {
	version: number;
	data: ViewData;
	rebuilt: Map<number, Row[]>;
}


function send(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(value ?? {}));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
	let text = "";
	for await (const chunk of req) {
		text += chunk;
		if (text.length > MAX_BODY) throw new Error("The request is too large.");
	}
	return JSON.parse(text || "{}");
}

/** Opens the address in the default browser. A failure is ignored: the caller shows the address as well. */
export function openBrowser(url: string): void {
	const [command, args]: [string, string[]] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["rundll32", ["url.dll,FileProtocolHandler", url]]
				: ["xdg-open", [url]];
	spawn(command, args, { stdio: "ignore", detached: true })
		.on("error", () => {})
		.unref();
}

/**
 * Serves the context page on a free port of 127.0.0.1.
 * Every request for data must carry the token of the address, so other local users and other web pages cannot read the session.
 */
export async function startWeb(host: WebHost): Promise<WebServer> {
	const token = randomBytes(16).toString("hex");
	/** The session files the page may open, with their titles: those that Insights listed. */
	const known = new Map<string, string>();
	const clients = new Set<ServerResponse>();
	let version = 0;
	let current: View | undefined;
	let other: { file: string; view: View } | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** The items of the sessions that showed the DNA trend, by session. */
	const strands = new Map<string, Dna>();

	/** The items of the session of `file`, or of the current session. They outlive the views: a request is read once. */
	function dnaOf(file: string | null): Dna {
		const key = file ?? `id:${host.sessionId()}`;
		const dna = strands.get(key) ?? new Dna();
		// The session asked for last is kept longest.
		strands.delete(key);
		strands.set(key, dna);
		if (strands.size > MAX_DNA) strands.delete(strands.keys().next().value as string);
		return dna;
	}
	/** The current session, or a saved one. A saved session is read again when `fresh` is set. */
	function view(file: string | null, fresh = false): View {
		if (!file) {
			current ??= { version, data: host.collect(), rebuilt: new Map() };
			return current;
		}
		const title = known.get(file);
		if (title === undefined) throw new Error("Unknown session. Open it from the Insights page.");
		if (fresh || other?.file !== file) other = { file, view: { version: 0, data: host.openSession(file, title), rebuilt: new Map() } };
		return other.view;
	}

	function rebuilt(v: View, request: RequestRec): Row[] {
		let rows = v.rebuilt.get(request.n);
		if (!rows) {
			rows = v.data.reconstruct(request);
			v.rebuilt.set(request.n, rows);
			if (v.rebuilt.size > MAX_REBUILT) v.rebuilt.delete(v.rebuilt.keys().next().value as number);
		}
		return rows;
	}

	/** Index of request `n` among the requests of the session. */
	function indexOf(v: View, n: string | null): number {
		const index = v.data.analysis.requests.findIndex((request) => request.n === Number(n));
		if (index < 0) throw new Error("There is no such request.");
		return index;
	}

	/** The content of an item, from the row that carries it: its text and its images. A tool result comes with what {@link callView} tells about its call. */
	function described(row: Row | undefined, rows: Row[]) {
		const { text, images } = row ?? {};
		if (!row?.id || text === undefined) return { text, images };
		return { text, images, call: callView(row, text, callOf(row, rows)?.text) };
	}
	const get: Record<string, Route> = {
		data(query) {
			const file = query.get("session");
			const { data, version: collected } = view(file, true);
			const board = boardOf(data.tasks, data.agents);
			const attention = attentionOf(data.analysis.commands);
			return {
				...viewJson(data),
				trend: trendBars(data.analysis, query.get("turn") === "1", query.get("delta") === "1"),
				toolRows: toolRows(data.analysis.tools, data.schemas, data.sources, TOOL_ORDERS.find((order) => order === query.get("tools"))),
				schemaSources: schemaSources(data.schemas, data.sources),
				version: collected,
				title: data.other ?? host.title(),
				readOnly: !!data.other,
				live: !file && host.isLive(),
				config: data.config,
				footer: footerItems(data.config),
				warnDefault: DEFAULT_WARN_PERCENT,
				labels: LABELS,
				replies: replyCounts(data.current),
				board,
				fleet: fleetSummary(data.agents, data.timeline, board),
				family: familyTotals(data.analysis.totals, data.agents),
				attention,
				// What each entry of the attention list filters the commands by.
				lenses: { slowest: attentionLens(attention, "slowest"), failing: attentionLens(attention, "failing"), repeated: attentionLens(attention, "repeated") },
				places: places(data.analysis),
				programs: programRanks(data.analysis.commands),
				fileOps: fileTotals(data.analysis.files),
				tps: tokensPerSecond(data.analysis.timing),
				rates: data.rates ?? {},
				markKinds: MARK_KINDS,
				choices: CHOICES,
				view: Object.fromEntries(CHOICE_SETTINGS.map((setting) => [setting, choiceOf(data.config, setting)])),
			};
		},
		/** What one request was assembled from, and what changed since the request before it, or with `base=input` since the last request before its human input. */
		request(query) {
			const v = view(query.get("session"));
			const requests = v.data.analysis.requests;
			const index = indexOf(v, query.get("n"));
			const request = requests[index];
			const rows = request.rows ?? rebuilt(v, request);
			const previous = requests[baselineOf(v.data.analysis, index, query.get("base") === "input" ? "input" : "request")];
			const diff = previous ? diffRows(previous.rows ?? rebuilt(v, previous), rows) : undefined;
			return {
				n: request.n,
				time: request.time,
				rebuilt: !request.rows,
				factor: scaleOf(sumTokens(rows), request.context),
				rows: rows.map(bare),
				since: previous?.n,
				marks: diff?.marks,
				removed: diff?.removed.map(bare),
				delta: diff?.delta,
				items: diff?.items,
				brief: briefOf(v.data.analysis, index, query.get("turn") === "1"),
				replies: replyCounts(rows),
				place: placeOf(v.data.analysis, index),
				tools: toolsAt(v.data.analysis, index),
			};
		},
		/**
		 * The items of the bars of the trend, for its DNA mode: the bars are those of `data`, with `last` only the last ones.
		 * The items are numbered, and a page that has the first `items` of numbering `id` gets only the rest.
		 */
		async dna(query) {
			const file = query.get("session");
			const { data } = view(file);
			const { requests } = data.analysis;
			const all = trendBars(data.analysis, query.get("turn") === "1", false).map((bar) => requests[bar.index]);
			const last = Math.max(0, Math.round(Number(query.get("last")) || 0));
			const hidden = last ? Math.max(0, all.length - last) : 0;
			const dna = dnaOf(file);
			const bars = await dna.bars(all.slice(hidden), data.source, query.get("delta") === "1", all[hidden - 1]);
			const had = Math.round(Number(query.get("items")) || 0);
			const from = query.get("id") === dna.id && had > 0 && had <= dna.items.length ? had : 0;
			return { id: dna.id, from, items: dna.items.slice(from), bars };
		},
		/** The whole content of item `i` of request `n`, or of the current context as of version `v`: its text, and its images with their data. A tool result comes with its call. */
		text(query) {
			const v = view(query.get("session"));
			const index = Number(query.get("i"));
			if (!query.has("n")) {
				if (Number(query.get("v")) !== v.version) throw new Error("The context has changed.");
				return described(v.data.current[index], v.data.current);
			}
			const request = v.data.analysis.requests[indexOf(v, query.get("n"))];
			const full = rebuilt(v, request);
			const row = (request.rows ?? full)[index];
			return described(row && fullOf(row, index, full), full);
		},
		/** The whole output of command `i`, as the session holds it. */
		output(query) {
			const { data } = view(query.get("session"));
			const id = data.analysis.commands[Number(query.get("i"))]?.id;
			const text = id === undefined ? undefined : data.resultText?.(id);
			if (text === undefined) throw new Error("The session holds no output of this command.");
			return { text };
		},
		/** The description and the parameters of tool `name`, when pi knows the tool now. */
		tool(query) {
			const doc = view(query.get("session")).data.toolDoc?.(query.get("name") ?? "");
			if (!doc) throw new Error("The tool is not known now.");
			return doc;
		},
		/** The files as they were after request `n`. */
		files(query) {
			const v = view(query.get("session"));
			return { files: filesUpTo(v.data.analysis.files, indexOf(v, query.get("n")) + 1) };
		},
		/** What subagent `id` was asked, what it answered, its tasks and its last events; and the timeline and the board with only what is about it. */
		agent(query) {
			const { data } = view(query.get("session"));
			const agent = data.agents.find((each) => each.id === query.get("id"));
			if (!agent) throw new Error("There is no such subagent.");
			const board = boardOf(data.tasks, data.agents);
			return { ...agentDetail(agent, data.timeline, board), ...narrow(agent, data.timeline, board) };
		},
		/** The tasks that task `id` waits for, directly or through other tasks. */
		chain(query) {
			return { ids: chainOf(view(query.get("session")).data.tasks, query.get("id") ?? "") };
		},
		async insights(query) {
			// "all" is a period without a start.
			const all = query.get("days") === "all";
			const days = all ? Number.POSITIVE_INFINITY : Math.min(365, Math.max(1, Math.round(Number(query.get("days")) || 30)));
			const day = query.get("day") ?? "";
			const until = query.get("until") ?? "";
			// "tools:read" lists only the sessions that used the tool read.
			const [, usedKind, name] = /^(\w+):(.+)$/.exec(query.get("uses") ?? "") ?? [];
			const kind = USE_KINDS.find((each) => each === usedKind);
			const filter = {
				cwd: query.get("project") === "1" ? host.cwd : undefined,
				sort: SORTS.find((sort) => sort === query.get("sort")),
				day: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined,
				until: /^\d{4}-\d{2}-\d{2}$/.test(until) && until > day ? until : undefined,
				uses: kind && name ? { kind, name } : undefined,
			};
			const insights = aggregate(await host.loadSummaries(days, () => {}), Date.now(), days, filter);
			const sessions = insights.sessions.map(({ models, tools, programs, skills, composition, activity, lastUsed, ...session }) => ({
				...session,
				window: host.windowOf(session.model),
				current: session.id === host.sessionId(),
			}));
			for (const session of sessions) if (session.file) known.set(session.file, session.name || session.cwd);
			return { ...insights, days: all ? "all" : days, sessions };
		},
	};

	const post: Record<string, Route> = {
		drop(_query, body) {
			const ids: string[] = Array.isArray(body?.ids) ? body.ids.filter((id: unknown) => typeof id === "string") : [];
			if (ids.length === 0) throw new Error("Give the ids of the tool calls.");
			host.setDropped(ids, body.dropped !== false);
		},
		setting: (_query, body) => host.changeSetting(String(body?.setting), String(body?.value ?? "")),
	};

	function changed(): void {
		version++;
		current = undefined;
		if (clients.size === 0 || timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			for (const client of clients) client.write("data: change\n\n");
		}, NOTIFY_MS);
		timer.unref();
	}

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");
		const asset = ASSETS[url.pathname];
		if (asset && req.method === "GET") {
			res.writeHead(200, { "content-type": asset[1], "cache-control": "no-store" }).end(readFileSync(new URL(asset[0], WEB_DIR)));
			return;
		}
		const name = url.pathname.startsWith("/api/") ? url.pathname.slice(5) : "";
		if (!name) return send(res, 404, { error: "Not found." });
		if (url.searchParams.get("t") !== token) {
			return send(res, 403, { error: "The access token is missing or wrong. Open the address that /context web showed." });
		}
		if (name === "events" && req.method === "GET") {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
			res.write(": connected\n\n");
			clients.add(res);
			req.on("close", () => clients.delete(res));
			return;
		}
		const routes = req.method === "GET" ? get : req.method === "POST" ? post : {};
		if (!Object.hasOwn(routes, name)) return send(res, 404, { error: "Not found." });
		try {
			const result = await routes[name](url.searchParams, req.method === "POST" ? await readBody(req) : undefined);
			if (req.method === "POST") changed();
			send(res, 200, result);
		} catch (error) {
			send(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
	}

	const server = createServer((req, res) => {
		handle(req, res).catch(() => res.destroy());
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	// The server must not keep pi running.
	server.unref();
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/?t=${token}`,
		changed,
		close() {
			clearTimeout(timer);
			for (const client of clients) client.end();
			server.close();
			server.closeAllConnections();
		},
	};
}
