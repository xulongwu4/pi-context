import { readFileSync, writeFileSync } from "node:fs";

export interface Config {
	systemPromptPrefix?: string;
	systemPromptSuffix?: string;
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
