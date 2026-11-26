import { readFileSync, writeFileSync } from "node:fs";

export interface Config {
	systemPromptPrefix?: string;
	systemPromptSuffix?: string;
	/** Context use, in percent, at which a warning is shown. 0 disables it. */
	warnPercent?: number;
	/** Context use, in percent, at which pi-context starts compaction when the agent stops. Unset: never. */
	compactPercent?: number;
	/** Session cost, in dollars, at which a warning is shown. Unset: none. */
	budget?: number;
	/** Seconds before the estimated expiry of the prompt cache at which a warning is shown while the agent is idle. Unset: none. */
	expiryWarnSeconds?: number;
	/** What the footer shows, in order. Unset: the context use. */
	footer?: FooterItem[];
	/** View defaults: see {@link CHOICES}. */
	insightsPeriod?: "30" | "7" | "90" | "all";
	trendBy?: "request" | "input";
	trendMode?: "total" | "change";
	trendFit?: "off" | "100" | "200" | "300";
	toolOrder?: "calls" | "schema" | "name";
	fileOrder?: "ops" | "recent" | "name" | "file" | "lines";
	diffBase?: "request" | "input";
}

export const FOOTER_ITEMS = ["context", "cost", "cache", "ttl"] as const;
export type FooterItem = (typeof FOOTER_ITEMS)[number];

export const DEFAULT_WARN_PERCENT = 80;

/**
 * The view defaults: what the tabs and the context page show when they open.
 * Each is one of a few values; the first value applies when none is stored.
 */
export const CHOICES = {
	period: { key: "insightsPeriod", label: "Insights period", values: ["30", "7", "90", "all"], help: "Days that the Insights tab covers when it opens." },
	trend: { key: "trendBy", label: "Trend bars", values: ["request", "input"], help: "One bar of the Context Trend for each request, or for each human input." },
	mode: { key: "trendMode", label: "Trend values", values: ["total", "change"], help: "The Context Trend shows the size of the context, or its change since the bar before." },
	fit: { key: "trendFit", label: "Trend fit", values: ["off", "100", "200", "300"], help: "The page shows the Context Trend whole, or only its last 100, 200 or 300 bars when it opens." },
	tools: { key: "toolOrder", label: "Tool order", values: ["calls", "schema", "name"], help: "Order of the tool list." },
	files: { key: "fileOrder", label: "File order", values: ["ops", "recent", "name", "file", "lines"], help: "Order of the file list: most operations first, last used first, by path, by file name, or most changed lines first." },
	diff: {
		key: "diffBase",
		label: "Diff baseline",
		values: ["request", "input"],
		help: "The Context Browser compares a request with the request before it, or with the last request before the human input it belongs to.",
	},
} as const;
export type ChoiceSetting = keyof typeof CHOICES;
export const CHOICE_SETTINGS = Object.keys(CHOICES) as ChoiceSetting[];

/** The value of a view default. */
export function choiceOf<S extends ChoiceSetting>(config: Config, setting: S): (typeof CHOICES)[S]["values"][number] {
	return config[CHOICES[setting].key] ?? CHOICES[setting].values[0];
}

/** Stores a view default; the first value is not stored. Returns false when `value` is not one of the values. */
export function setChoice(config: Config, setting: ChoiceSetting, value: string): boolean {
	const { key, values } = CHOICES[setting];
	const index = (values as readonly string[]).indexOf(value);
	if (index < 0) return false;
	Object.assign(config, { [key]: index === 0 ? undefined : value });
	return true;
}

export function loadConfig(path: string): Config {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
}

export function saveConfig(path: string, config: Config): void {
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** Joins the prefix and suffix to the prompt. An empty value is disabled. */
export function applyAffixes(prompt: string, config: Config): string {
	return [config.systemPromptPrefix?.trim(), prompt, config.systemPromptSuffix?.trim()].filter(Boolean).join("\n\n");
}