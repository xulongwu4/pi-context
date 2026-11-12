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
