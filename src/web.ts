import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { diffRows, LABELS, type RequestRec, type Row, scaleOf, sumTokens, textOf, type ViewData } from "./analyze.ts";
import { DEFAULT_WARN_PERCENT } from "./config.ts";
import { viewJson } from "./export.ts";
import { footerItems } from "./footer.ts";
import { aggregate, type SessionSort } from "./insights.ts";
import type { OverlayHost } from "./overlay.ts";

/** The result of changing a setting, as a message for the user. */
export interface Outcome {
	message: string;
	level: "info" | "error";
}

export interface WebHost extends Pick<OverlayHost, "collect" | "isLive" | "loadSummaries" | "openSession" | "setDropped" | "cwd"> {
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
const SORTS: SessionSort[] = ["recent", "cost", "tokens"];

type Route = (query: URLSearchParams, body: any) => unknown;

/** The data of one session, as collected at one time. */
interface View {
	version: number;
	data: ViewData;
	rebuilt: Map<number, Row[]>;
}

const strip = ({ text, ...row }: Row) => row;

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

	const get: Record<string, Route> = {
		data(query) {
			const file = query.get("session");
			const { data, version: collected } = view(file, true);
			return {
				...viewJson(data),
				version: collected,
				title: data.other ?? host.title(),
				readOnly: !!data.other,
				live: !file && host.isLive(),
				config: data.config,
				footer: footerItems(data.config),
				warnDefault: DEFAULT_WARN_PERCENT,
				labels: LABELS,
			};
		},
		/** What one request was assembled from, and what changed since the request before it. */
		request(query) {
			const v = view(query.get("session"));
			const requests = v.data.analysis.requests;
			const index = indexOf(v, query.get("n"));
			const request = requests[index];
			const rows = request.rows ?? rebuilt(v, request);
			const previous = requests[index - 1];
			const diff = previous ? diffRows(previous.rows ?? rebuilt(v, previous), rows) : undefined;
			return {
				n: request.n,
				time: request.time,
				rebuilt: !request.rows,
				factor: scaleOf(sumTokens(rows), request.context),
				rows: rows.map(strip),
				since: previous?.n,
				marks: diff?.marks,
				removed: diff?.removed.map(strip),
				delta: diff?.delta,
				items: diff?.items,
			};
		},
		/** The whole content of item `i` of request `n`, or of the current context as of version `v`. */
		text(query) {
			const v = view(query.get("session"));
			const index = Number(query.get("i"));
			if (!query.has("n")) {
				if (Number(query.get("v")) !== v.version) throw new Error("The context has changed.");
				return { text: v.data.current[index]?.text };
			}
			const request = v.data.analysis.requests[indexOf(v, query.get("n"))];
			const row = (request.rows ?? rebuilt(v, request))[index];
			return { text: row && textOf(row, index, rebuilt(v, request)) };
		},
		async insights(query) {
			const days = Math.min(365, Math.max(1, Math.round(Number(query.get("days")) || 30)));
			const filter = { cwd: query.get("project") === "1" ? host.cwd : undefined, sort: SORTS.find((sort) => sort === query.get("sort")) };
			const insights = aggregate(await host.loadSummaries(days, () => {}), Date.now(), days, filter);
			const sessions = insights.sessions.map(({ models, tools, programs, skills, ...session }) => session);
			for (const session of sessions) if (session.file) known.set(session.file, session.name || session.cwd);
			return { ...insights, sessions };
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
