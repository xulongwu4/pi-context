import type { Config, FooterItem } from "./config.ts";
import { fmtCost, fmtDuration, fmtTokens } from "./format.ts";

export interface FooterStats {
	usage?: { tokens: number | null; contextWindow: number; percent: number | null };
	cost: number;
	requests: number;
	/** Share of the sent tokens that was read from the prompt cache, 0 to 1. */
	cacheRate: number;
	/** Estimated time at which the prompt cache expires. */
	cacheUntil?: number;
}

/** The footer items to show. A budget adds the cost. */
export function footerItems(config: Config): FooterItem[] {
	const items = config.footer?.length ? config.footer : (["context"] as FooterItem[]);
	return config.budget && !items.includes("cost") ? [...items, "cost"] : items;
}

/**
 * When to warn that the prompt cache is about to expire. Undefined when no warning is due:
 * none is configured, the model does not cache, or the cache has expired.
 */
export function expiryWarnAt(config: Config, stats: FooterStats, now: number): number | undefined {
	const { cacheUntil } = stats;
	if (!config.expiryWarnSeconds || cacheUntil === undefined || cacheUntil <= now) return undefined;
	return Math.max(now, cacheUntil - config.expiryWarnSeconds * 1000);
}

/** The warning that the prompt cache is about to expire. */
export function expiryText(stats: FooterStats, now: number): string {
	const size = stats.usage?.tokens ? `the ${fmtTokens(stats.usage.tokens)} tokens of the context` : "the whole context";
	return `The prompt cache expires in about ${fmtDuration(Math.max(0, (stats.cacheUntil ?? now) - now))}. A request after that sends ${size} without the cache.`;
}

/** Text of the footer status. An item without data is left out. */
export function footerText(config: Config, stats: FooterStats, now: number): string {
	const { usage } = stats;
	const parts = footerItems(config).map((item) => {
		switch (item) {
			case "context":
				return usage?.percent == null ? "" : `ctx ${Math.round(usage.percent)}% ${fmtTokens(usage.tokens)}/${fmtTokens(usage.contextWindow)}`;
			case "cost":
				return fmtCost(stats.cost) + (config.budget ? `/${fmtCost(config.budget)}` : "");
			case "cache":
				return stats.requests > 0 ? `cache ${Math.round(stats.cacheRate * 100)}%` : "";
			case "ttl":
				if (stats.cacheUntil === undefined) return "";
				return stats.cacheUntil > now ? `ttl ${fmtDuration(stats.cacheUntil - now)}` : "ttl expired";
		}
	});
	return parts.filter(Boolean).join(" · ");
}
