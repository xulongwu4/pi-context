import { readFileSync, writeFileSync } from "node:fs";

export interface Config {
	systemPromptPrefix?: string;
	systemPromptSuffix?: string;
	/** Context use, in percent, at which a warning is shown. 0 disables it. */
	warnPercent?: number;
}

export const DEFAULT_WARN_PERCENT = 80;

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