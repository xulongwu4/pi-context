import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ViewData } from "../src/analyze.ts";
import { startWeb } from "../src/web.ts";

// A small DOM for the tests of the web page. This repo installs no packages, so the tests bring the part of a browser
// that web/app.js uses: elements read from HTML, the selectors of the page, events that bubble. Nothing is laid out:
// a test tells the sizes that it needs through Doc.measure.

const WEB = join(import.meta.dir, "..", "web");
/** Elements without content. */
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
/** The open elements that the start of an element ends, where HTML lets their end tag out. */
const ENDS: Record<string, string[]> = { option: ["option"], li: ["li"], td: ["td", "th"], th: ["td", "th"], tr: ["td", "th", "tr"] };
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

const decode = (text: string) =>
	text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) =>
		name[0] !== "#" ? (NAMED[name] ?? whole) : String.fromCodePoint(name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1))),
	);
const encode = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const dataName = (key: string) => "data-" + key.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());

type Test = (el: El) => boolean;
const selectors = new Map<string, Test[][]>();

/** One step of a selector: a tag, ids, classes and attributes, as in `button.on[data-act="trend"]`. */
function step(text: string): Test {
	const tests: Test[] = [];
	const rest = text
		.replace(/^[a-z][\w-]*/i, (tag) => {
			tests.push((el) => el.tagName === tag.toLowerCase());
			return "";
		})
		.replace(/#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g, (_whole, id, name, attr, a, b, c) => {
			const value = a ?? b ?? c;
			if (id) tests.push((el) => el.attrs.get("id") === id);
			else if (name) tests.push((el) => el.classList.contains(name));
			else tests.push((el) => (value === undefined ? el.attrs.has(attr) : el.attrs.get(attr) === value));
			return "";
		});
	if (rest) throw new Error(`The DOM of the tests does not know the selector "${text}".`);
	return (el) => tests.every((test) => test(el));
}

/** The alternatives of a selector, each as the steps from the outermost element to the element itself. Steps are apart by spaces only. */
function selectorOf(text: string): Test[][] {
	let known = selectors.get(text);
	if (!known) {
		known = (text.match(/(?:\[[^\]]*\]|[^,[])+/g) ?? []).map((one) => (one.trim().match(/(?:\[[^\]]*\]|[^\s[])+/g) ?? []).map(step));
		selectors.set(text, known);
	}
	return known;
}

const TOKEN = /<!--[\s\S]*?-->|<![^>]*>|<\/([\w-]+)\s*>|<([a-z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|[^<]+|</gi;
const ATTR = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/** Adds the nodes of `html` to `parent`. */
function fill(parent: El, html: string): void {
	let at = parent;
	for (const [whole, end, start, attrs, closed] of html.matchAll(TOKEN)) {
		if (start) {
			const tag = start.toLowerCase();
			while (at !== parent && ENDS[tag]?.includes(at.tagName)) at = at.parent!;
			const el = new El(parent.doc, tag);
			for (const [, name, a, b, c] of attrs.matchAll(ATTR)) el.attrs.set(name.toLowerCase(), decode(a ?? b ?? c ?? ""));
			at.appendChild(el);
			if (!closed && !VOID.has(tag)) at = el;
		} else if (end) {
			let open: El | undefined = at;
			while (open && open !== parent && open.tagName !== end.toLowerCase()) open = open.parent;
			if (open && open !== parent) at = open.parent!;
		} else if (!whole.startsWith("<!")) at.nodes.push(decode(whole));
	}
}

export class El {
	readonly doc: Doc;
	readonly attrs = new Map<string, string>();
	nodes: (El | string)[] = [];
	parent?: El;
	scrollTop = 0;
	private left = 0;
	selectionStart = 0;
	selectionEnd = 0;
	readonly style: Record<string, any> = {
		setProperty(name: string, value: string) {
			this[name] = value;
		},
	};
	private readonly listeners = new Map<string, ((event: any) => void)[]>();
	/** What the user typed or chose, and ticked: they are not attributes. */
	private typed?: string;
	private ticked?: boolean;
	declare id: string;
	declare name: string;
	declare title: string;
	declare hidden: boolean;
	declare open: boolean;
	declare disabled: boolean;

	constructor(doc: Doc | undefined, readonly tagName: string) {
		this.doc = doc ?? (this as unknown as Doc);
	}

	get className(): string {
		return this.attrs.get("class") ?? "";
	}
	get classList() {
		const names = () => this.className.split(/\s+/).filter(Boolean);
		const put = (list: string[]) => void this.attrs.set("class", list.join(" "));
		return {
			contains: (name: string) => names().includes(name),
			add: (name: string) => put([...new Set([...names(), name])]),
			remove: (name: string) => put(names().filter((other) => other !== name)),
			toggle: (name: string, on = !names().includes(name)) => {
				put(on ? [...new Set([...names(), name])] : names().filter((other) => other !== name));
				return on;
			},
		};
	}
	get dataset(): Record<string, string> {
		const { attrs } = this;
		const names = () => [...attrs.keys()].filter((name) => name.startsWith("data-")).map((name) => name.slice(5).replace(/-([a-z])/g, (_dash, letter: string) => letter.toUpperCase()));
		return new Proxy({} as Record<string, string>, {
			get: (_target, key) => (typeof key === "string" ? attrs.get(dataName(key)) : undefined),
			set: (_target, key, value) => (attrs.set(dataName(String(key)), String(value)), true),
			has: (_target, key) => attrs.has(dataName(String(key))),
			deleteProperty: (_target, key) => (attrs.delete(dataName(String(key))), true),
			ownKeys: names,
			getOwnPropertyDescriptor: (_target, key) => (attrs.has(dataName(String(key))) ? { value: attrs.get(dataName(String(key))), enumerable: true, configurable: true, writable: true } : undefined),
		});
	}
	/** The fields of a form by name. */
	get elements(): Record<string, El> {
		return Object.fromEntries(this.querySelectorAll("[name]").map((field) => [field.name, field]));
	}

	get value(): string {
		if (this.typed !== undefined) return this.typed;
		if (this.tagName === "select") {
			const options = this.querySelectorAll("option");
			return (options.find((option) => option.attrs.has("selected")) ?? options[0])?.value ?? "";
		}
		if (this.tagName === "option") return this.attrs.get("value") ?? this.textContent;
		return this.tagName === "textarea" ? this.textContent : (this.attrs.get("value") ?? "");
	}
	/** A select takes the value of one of its options only, as in a browser. */
	set value(value: string) {
		const text = String(value);
		this.typed = this.tagName !== "select" || this.querySelectorAll("option").some((option) => option.value === text) ? text : "";
	}
	get checked(): boolean {
		return this.ticked ?? this.attrs.has("checked");
	}
	set checked(on: boolean) {
		this.ticked = on;
	}

	get children(): El[] {
		return this.nodes.filter((node): node is El => typeof node !== "string");
	}
	get parentElement(): El | null {
		return this.parent ?? null;
	}
	get firstElementChild(): El | null {
		return this.children[0] ?? null;
	}
	get previousElementSibling(): El | null {
		const all = this.parent?.children ?? [];
		return all[all.indexOf(this) - 1] ?? null;
	}
	get nextElementSibling(): El | null {
		const all = this.parent?.children ?? [];
		return all[all.indexOf(this) + 1] ?? null;
	}
	appendChild(el: El): El {
		el.remove();
		el.parent = this;
		this.nodes.push(el);
		return el;
	}
	remove(): void {
		if (this.parent) this.parent.nodes = this.parent.nodes.filter((node) => node !== this);
		this.parent = undefined;
	}
	contains(other: El | null | undefined): boolean {
		for (let el = other ?? undefined; el; el = el.parent) if (el === this) return true;
		return false;
	}
	private clear(): void {
		for (const child of this.children) child.parent = undefined;
		this.nodes = [];
		// The options of a select went with what was chosen among them.
		if (this.tagName === "select") this.typed = undefined;
	}
	get textContent(): string {
		return this.nodes.map((node) => (typeof node === "string" ? node : node.textContent)).join("");
	}
	set textContent(text: string) {
		this.clear();
		if (text !== "") this.nodes.push(String(text));
	}
	get innerHTML(): string {
		return this.nodes.map((node) => (typeof node === "string" ? encode(node) : node.outerHTML)).join("");
	}
	set innerHTML(html: string) {
		this.clear();
		fill(this, html);
	}
	get outerHTML(): string {
		const attrs = [...this.attrs].map(([name, value]) => ` ${name}="${encode(value).replace(/"/g, "&quot;")}"`).join("");
		return VOID.has(this.tagName) ? `<${this.tagName}${attrs}>` : `<${this.tagName}${attrs}>${this.innerHTML}</${this.tagName}>`;
	}

	matches(selector: string): boolean {
		return selectorOf(selector).some((steps) => {
			if (!steps.at(-1)?.(this)) return false;
			let up = this.parent;
			for (let i = steps.length - 2; i >= 0; i--) {
				while (up && !steps[i](up)) up = up.parent;
				if (!up) return false;
				up = up.parent;
			}
			return true;
		});
	}
	closest(selector: string): El | null {
		for (let el: El | undefined = this; el; el = el.parent) if (el.matches(selector)) return el;
		return null;
	}
	querySelectorAll(selector: string): El[] {
		const found: El[] = [];
		const walk = (el: El) => {
			for (const child of el.children) {
				if (child.matches(selector)) found.push(child);
				walk(child);
			}
		};
		walk(this);
		return found;
	}
	querySelector(selector: string): El | null {
		return this.querySelectorAll(selector)[0] ?? null;
	}

	addEventListener(type: string, listener: (event: any) => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	/** Tells the event to the element and to each element around it. */
	dispatchEvent(event: Record<string, any>): boolean {
		event.target ??= this;
		event.preventDefault ??= () => {};
		for (let el: El | undefined = this; el; el = el.parent) {
			(el as any)[`on${event.type}`]?.(event);
			for (const listener of el.listeners.get(event.type) ?? []) listener.call(el, event);
		}
		return true;
	}
	click(): void {
		this.dispatchEvent({ type: "click" });
	}
	focus(): void {
		this.doc.activeElement = this;
	}
	setSelectionRange(start: number, end: number): void {
		this.selectionStart = start;
		this.selectionEnd = end;
	}
	scrollIntoView(): void {
		this.doc.shown = this;
	}
	get clientWidth(): number {
		return this.doc.measure(this, "clientWidth");
	}
	get clientHeight(): number {
		return this.doc.measure(this, "clientHeight");
	}
	get scrollWidth(): number {
		return this.doc.measure(this, "scrollWidth");
	}
	get scrollLeft(): number {
		return this.left;
	}
	/** An element scrolls no further than its end, as in a browser. */
	set scrollLeft(left: number) {
		this.left = Math.max(0, Math.min(left, this.scrollWidth - this.clientWidth));
	}
	/** The element is at the top left of the window, with its client size. */
	getBoundingClientRect() {
		const width = this.clientWidth;
		const height = this.clientHeight;
		return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height };
	}
}
for (const name of ["id", "name", "title"]) {
	Object.defineProperty(El.prototype, name, {
		get(this: El) {
			return this.attrs.get(name) ?? "";
		},
		set(this: El, value: string) {
			this.attrs.set(name, String(value));
		},
	});
}
for (const name of ["hidden", "open", "disabled"]) {
	Object.defineProperty(El.prototype, name, {
		get(this: El) {
			return this.attrs.has(name);
		},
		set(this: El, on: boolean) {
			if (on) this.attrs.set(name, "");
			else this.attrs.delete(name);
		},
	});
}

export class Doc extends El {
	activeElement: El | null = null;
	/** The element that the page scrolled into view last. */
	shown: El | null = null;
	/** The size of an element. Nothing is laid out: a test sets this to tell the sizes that the page reads. */
	measure: (el: El, what: "clientWidth" | "clientHeight" | "scrollWidth") => number = () => 0;

	constructor(html: string) {
		super(undefined, "#document");
		fill(this, html);
	}
	get body(): El {
		return this.querySelector("body")!;
	}
	getElementById(id: string): El | null {
		return this.querySelector(`[id="${id}"]`);
	}
	createElement(tag: string): El {
		return new El(this, tag.toLowerCase());
	}
}

/**
 * Loads the web page from the server at `url` into a DOM, as a browser does, and returns the means to use it as a reader does.
 * The page runs web/app.js whole: it reads its data from the server, and a click goes through the listeners of the page.
 */
export async function openPage(url: string) {
	const { origin, search } = new URL(url);
	const document = new Doc(readFileSync(join(WEB, "index.html"), "utf8"));
	/** The work that the page waits for: answers of the server, and frames. */
	let pending = 0;
	const track = <T>(work: Promise<T>): Promise<T> => {
		pending++;
		return work.finally(() => pending--);
	};
	const copied: string[] = [];
	const sources: { url: string; onmessage?: () => void; onerror?: () => void; onopen?: () => void }[] = [];
	const heard = new Map<string, ((event: any) => void)[]>();
	const globals = {
		document,
		location: { search, hash: "" },
		navigator: { clipboard: { writeText: async (text: string) => void copied.push(text) } },
		fetch: (path: string, options?: RequestInit) =>
			track(fetch(new URL(path, `${origin}/`), options).then((response) => ({ ok: response.ok, status: response.status, statusText: response.statusText, json: () => track(response.json()) }))),
		EventSource: class {
			constructor(readonly url: string) {
				sources.push(this);
			}
		},
		requestAnimationFrame: (frame: () => void) =>
			void track(
				new Promise<void>((done) =>
					setTimeout(() => {
						try {
							frame();
						} finally {
							done();
						}
					}, 0),
				),
			),
		addEventListener: (type: string, listener: (event: any) => void) => void heard.set(type, [...(heard.get(type) ?? []), listener]),
		devicePixelRatio: 1,
		innerWidth: 1200,
		innerHeight: 800,
		scrollTo: () => {},
		// A timer of the page does not keep the tests from ending.
		setTimeout: (work: () => void, ms?: number) => setTimeout(work, ms).unref(),
	};
	// The script runs in a function that takes the globals of a browser, and that hands out its own names for the tests to read.
	const source = readFileSync(join(WEB, "app.js"), "utf8");
	const scope = new Function(...Object.keys(globals), `${source}\nreturn (name) => eval(name);`)(...Object.values(globals)) as (name: string) => any;

	/** Waits until the page has nothing to wait for. */
	const settle = async () => {
		for (let idle = 0; idle < 2; ) {
			await new Promise((done) => setTimeout(done, 0));
			idle = pending ? 0 : idle + 1;
		}
	};
	const one = (selector: string): El => {
		const el = document.querySelector(selector);
		if (!el) throw new Error(`Nothing in the page matches "${selector}".`);
		return el;
	};
	const el = (target: string | El) => (typeof target === "string" ? one(target) : target);
	const send = async (target: string | El, event: Record<string, any>) => {
		el(target).dispatchEvent(event);
		await settle();
	};
	await settle();
	return {
		document,
		/** What the page put on the clipboard. */
		copied,
		/** The connection on which the server tells that the session changed. */
		events: sources[0],
		/** A name of web/app.js: a function, the state. */
		get: scope,
		settle,
		/** The first element that matches. It throws when nothing does. */
		one,
		all: (selector: string) => document.querySelectorAll(selector),
		/** The text of the elements that match. */
		texts: (selector: string) => document.querySelectorAll(selector).map((found) => found.textContent.trim()),
		click: (target: string | El, init: Record<string, any> = {}) => send(target, { type: "click", ...init }),
		/** Types text into a field in place of what it holds. */
		async type(target: string | El, value: string) {
			el(target).focus();
			el(target).value = value;
			await send(target, { type: "input" });
		},
		/** Chooses an option of a select, which tells it as a browser does: with an input event, then a change event. */
		async choose(target: string | El, value: string) {
			el(target).value = value;
			await send(target, { type: "input" });
			await send(target, { type: "change" });
		},
		key: (target: string | El, key: string, init: Record<string, any> = {}) => send(target, { type: "keydown", key, ...init }),
		/** Moves the pointer over an element, to a place in the window. */
		hover: (target: string | El, at: { clientX?: number; clientY?: number } = {}) => send(target, { type: "mousemove", clientX: 0, clientY: 0, ...at }),
		/** An event of the window, such as resize. */
		async fire(type: string) {
			for (const listener of heard.get(type) ?? []) listener({ type });
			await settle();
		},
	};
}

/** Serves `data` as the current session, and opens the page on it. `close` ends the server. */
export async function servePage(data: ViewData | (() => ViewData), host: Partial<Parameters<typeof startWeb>[0]> = {}) {
	const collect = typeof data === "function" ? data : () => data;
	const server = await startWeb({
		collect,
		isLive: () => true,
		loadSummaries: async () => [],
		openSession: collect,
		setDropped: () => {},
		cwd: "/work",
		sessionId: () => "s0",
		windowOf: () => 1000,
		title: () => "Test session",
		changeSetting: () => ({ level: "info", message: "Saved." }),
		...host,
	});
	return { ...(await openPage(server.url)), close: () => server.close() };
}
