export function fmtTokens(n: number | null | undefined): string {
	if (n == null) return "?";
	if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return String(Math.round(n));
}

export function fmtDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
	return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

export const fmtCost = (cost: number) => `$${cost.toFixed(cost >= 1 ? 2 : 4)}`;

export const fmtTime = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

/** Local date as YYYY-MM-DD. */
export function fmtDay(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const fmtPercent = (part: number, total: number) => (total > 0 ? `${Math.round((part / total) * 100)}%` : "0%");

export function bar(fraction: number, width: number): string {
	const filled = Math.round(Math.min(1, Math.max(0, fraction || 0)) * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}