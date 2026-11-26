import { mock } from "bun:test";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { ViewData } from "../src/analyze.ts";
import type { OverlayHost, SettingRequest, Tab } from "../src/overlay.ts";

const TUI_PACKAGE = "@earendil-works/pi-tui";

/** Where pi-tui is: in the packages of this repo when they are installed, else in the pi that is on the PATH. */
function tuiPath(): string {
	const pi = Bun.which("pi");
	for (const from of [import.meta.dir, pi && dirname(realpathSync(pi))]) {
		try {
			if (from) return Bun.resolveSync(TUI_PACKAGE, from);
		} catch {
			// Not there.
		}
	}
	throw new Error(`The overlay tests need ${TUI_PACKAGE}. Install pi, or run "bun install" in this repo.`);
}

// The overlay draws with pi-tui, which pi provides when it loads the extension. This repo installs no packages,
// and `bun test` does not fetch a missing one: the tests name the pi-tui that they found as the package.
const tui: typeof import("@earendil-works/pi-tui") = await import(tuiPath());
mock.module(TUI_PACKAGE, () => tui);
const { ContextOverlay } = (await import("../src/overlay.ts")) as typeof import("../src/overlay.ts");

/** The columns that a line takes on the screen. */
export const { visibleWidth } = tui;
/** The keys of a terminal, as the terminal sends them. */
export const KEYS = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", escape: "\x1b", tab: "\t", backspace: "\x7f" } as const;

export { assistant, call, result, viewOf } from "./session.ts";

/**
 * An overlay over `data` in a terminal of `rows` rows and `width` columns, without a terminal: the keys go in, and the screen comes out as text.
 * The terminal is tall by default, so that the screen shows the whole body of a tab.
 */
export function openOverlay(data: ViewData, { tab, rows = 400, width = 160, host = {} }: { tab?: Tab; rows?: number; width?: number; host?: Partial<OverlayHost> } = {}) {
	/** What the overlay asked of its host. */
	const log = { renders: 0, closed: [] as (SettingRequest | undefined)[], dropped: [] as { ids: string[]; dropped: boolean }[] };
	const tui = { requestRender: () => log.renders++, terminal: { rows } } as unknown as TUI;
	// A theme without colors: the screen is plain text.
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
	const overlay = new ContextOverlay(
		tui,
		theme,
		{
			collect: () => data,
			isLive: () => false,
			loadSummaries: async () => [],
			openSession: () => data,
			setDropped: (ids, dropped) => log.dropped.push({ ids, dropped }),
			cwd: "/work",
			sessionId: () => "s0",
			windowOf: () => 1000,
			configPath: "/work/config.json",
			tab,
			...host,
		},
		(request) => log.closed.push(request),
	);
	// The overlay refreshes on a timer, which a test has no use for.
	overlay.dispose();
	const lines = () => overlay.render(width);
	/** A line of the screen without its frame. */
	const inside = (line: string) => line.slice(2, -2).trimEnd();
	/** Sends a key. A terminal draws the screen before the user presses a key, and the overlay acts on what it drew. */
	const send = (key: string) => {
		lines();
		overlay.handleInput(key);
	};
	return {
		overlay,
		log,
		/** Sends keys: a name of KEYS, or the text of a key. */
		press(...keys: string[]) {
			for (const key of keys) send(KEYS[key as keyof typeof KEYS] ?? key);
			return this;
		},
		/** Types text, one key for each character. */
		type(text: string) {
			for (const key of text) send(key);
			return this;
		},
		lines,
		/** The screen as one text. */
		screen: () => lines().join("\n"),
		/** The lines of the body: the screen without the frame, the tab bar, the key hints and the empty lines at the end. */
		body: () => lines().slice(3, -2).map(inside).join("\n").trimEnd().split("\n"),
		/** The tab bar, or the title of what the inspector shows. */
		title: () => inside(lines()[1]),
		/** The key hints, or the notice in their place. */
		hint: () => inside(lines().at(-2)!),
	};
}
