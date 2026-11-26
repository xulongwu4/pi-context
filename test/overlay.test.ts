import { expect, test } from "bun:test";
import { assistant, call, openOverlay, result, viewOf, visibleWidth } from "./overlay.ts";

// A PNG of 1×1 pixels.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const messages = [
	{ role: "user", content: [{ type: "text", text: "look at this picture" }, { type: "image", data: PNG, mimeType: "image/png" }], timestamp: 1000 },
	assistant(2000, 100, [
		call("c1", "bash", { command: "sleep 1", timeout: 30 }),
		call("c2", "write", { path: "/work/lib/zeta.ts", content: "a\nb" }),
		call("c3", "read", { path: "/work/src/alpha.ts" }),
	]),
	result(3000, "c1", "bash", "done"),
	result(3100, "c2", "write", "Wrote 2 lines"),
	result(3200, "c3", "read", "export const a = 1;"),
	assistant(4000, 150, [{ type: "text", text: "All done." }]),
];
const agents: any[] = [
	{ id: "a1", type: "worker", description: "build the thing", status: "running", startedAt: 5000 },
	{ id: "a2", type: "scout", description: "read the docs", status: "completed", startedAt: 1000, completedAt: 4000 },
];
const data = viewOf(messages, { agents });

/** The items that the list of the Current tab shows, by their label. */
const items = (body: string[]) => body.filter((line) => /^[▶ ] #\d/.test(line)).map((line) => line.replace(/^.*@?\d?\s{2}(?=\w+( \w+)?:)/, "").replace(/:.*$/, ""));

test("the overlay opens on the tab asked for, and the arrow and tab keys change the tab", () => {
	const screen = openOverlay(data);
	expect(screen.title()).toStartWith("Stats │ Current │ Hints");
	expect(screen.body()[0]).toBe("Context window");
	expect(screen.press("right").body()[0]).toBe("Composition");
	expect(screen.press("left").body()[0]).toBe("Context window");
	expect(screen.press("tab").body()[0]).toBe("Composition");
	expect(screen.log.renders).toBe(3);
	expect(openOverlay(data, { tab: "Events" }).body()[0]).toStartWith("No injection, compaction");
});

test("the overlay draws a frame of the width of the terminal, with a body of 85% of its rows", () => {
	for (const [rows, width] of [
		[20, 90],
		[50, 200],
	]) {
		for (const tab of ["Stats", "Current", "Trend", "Files", "Commands", "Tools", "Fleet", "Settings"] as const) {
			const lines = openOverlay(data, { tab, rows, width }).lines();
			// The frame, the tab bar and the key hints take 5 lines.
			expect(lines).toHaveLength(Math.floor(rows * 0.85));
			expect(lines.map((line) => visibleWidth(line))).toEqual(lines.map(() => width));
			expect(lines[0]).toStartWith("╭");
			expect(lines.at(-1)).toStartWith("╰");
		}
	}
});

test("the Stats tab counts the human inputs and the file operations", () => {
	const body = openOverlay(data).body();
	expect(body).toContain("  Human inputs 1   Requests 2   Tool calls 3 (0 errors)   Cost $0.0200");
	expect(body).toContain("  File reads 1   Writes 1");
});

test("the filter of the Current tab keeps the items with the text, and escape clears it before it closes the overlay", () => {
	const screen = openOverlay(data, { tab: "Current" });
	expect(items(screen.body())).toEqual(["call write", "call bash", "call read", "user", "result read", "result write", "answer", "result bash"]);
	screen.press("/").type("write");
	expect(screen.hint()).toBe("Filter: write▏  enter keep  esc clear");
	expect(items(screen.body())).toEqual(["call write", "result write"]);
	screen.press("backspace", "backspace", "backspace", "backspace", "backspace").type("done").press("enter");
	expect(items(screen.body())).toEqual(["answer", "result bash"]);
	// The keys act on the list again.
	expect(screen.hint()).toStartWith('filter "done" (esc clears)  ←/→ tab  ↑/↓ select  enter inspect');
	expect(items(screen.press("escape").body())).toHaveLength(8);
	expect(screen.log.closed).toEqual([]);
	screen.press("escape");
	expect(screen.log.closed).toEqual([undefined]);
});

test("the inspector shows an item with a line for each of its images, and escape goes back to the list", () => {
	const screen = openOverlay(data, { tab: "Current" });
	screen.press("/").type("look").press("enter", "enter");
	expect(screen.title()).toBe("User messages · user · 28 characters");
	expect(screen.body()).toEqual(["Image 1: image/png · 1×1 px · 70 B · ≈1 tokens", "", "look at this picture [image]"]);
	expect(screen.hint()).toBe("↑/↓ scroll  esc back");
	screen.press("escape");
	expect(screen.title()).toStartWith("Stats │ Current");
	expect(items(screen.body())).toEqual(["user"]);
	expect(screen.log.closed).toEqual([]);
});

test("the Current tab drops a tool result, and nothing else", () => {
	const screen = openOverlay(data, { tab: "Current" });
	screen.press("d");
	expect(screen.hint()).toBe("Only tool results can be dropped.");
	expect(screen.log.dropped).toEqual([]);
	screen.press("down", "down", "down", "down", "down");
	expect(screen.body().find((line) => line.startsWith("▶"))).toContain("result write: Wrote 2 lines");
	screen.press("d");
	expect(screen.log.dropped).toEqual([{ ids: ["c2"], dropped: true }]);
	expect(screen.hint()).toStartWith("Dropped: from the next request on, the model gets a stub.");
});

test("the Commands tab shows a command with its time limit, and how much output the session holds", () => {
	const screen = openOverlay(data, { tab: "Commands" });
	expect(screen.body()).toContain("  sleep ×1");
	screen.press("enter");
	expect(screen.title()).toStartWith("Command · request #1 1.1 · ");
	expect(screen.body()).toEqual(["sleep 1", "", "timeout 30s · 1 line · 4 characters", "", "Output:", "done"]);
	expect(screen.press("escape").body()).toContain("  sleep ×1");
});

test("the Files tab changes the order of the files, and starts in the order of the settings", () => {
	const paths = (body: string[]) => body.filter((line) => line.includes("/work/")).map((line) => line.slice(line.indexOf("/work/")));
	const screen = openOverlay(data, { tab: "Files" });
	const orders: string[] = [];
	for (let i = 0; i < 5; i++) {
		orders.push(screen.body()[1]);
		if (orders[i] === "  Order: by path.") expect(paths(screen.body())).toEqual(["/work/lib/zeta.ts", "/work/src/alpha.ts"]);
		if (orders[i] === "  Order: by file name.") expect(paths(screen.body())).toEqual(["/work/src/alpha.ts", "/work/lib/zeta.ts"]);
		screen.press("s");
	}
	expect(orders).toEqual(["  Order: most operations first.", "  Order: last used first.", "  Order: by path.", "  Order: by file name.", "  Order: most changed lines first."]);
	expect(screen.body()[1]).toBe(orders[0]);

	const set = openOverlay(viewOf(messages, { config: { budget: 5, fileOrder: "file" } }), { tab: "Files" });
	expect(set.body()[1]).toBe("  Order: by file name.");
	// The operations of the selected file.
	set.press("enter");
	expect(set.body()[0]).toBe("/work/src/alpha.ts");
	expect(set.body()[1]).toStartWith("  Reads 1   Writes 0   Edits 0   Searches 0   Images 0");
	expect(paths(set.press("escape").body())).toHaveLength(2);
});

test("the Fleet tab lists the subagents, or only those that run", () => {
	const screen = openOverlay(data, { tab: "Fleet" });
	const names = () => screen.body().filter((line) => /^[▶ ] [●✓]/.test(line)).map((line) => line.slice(4));
	expect(screen.body()).toContain("Subagents (2)");
	expect(names()).toEqual(["worker  build the thing  a1", "scout  read the docs  a2"]);
	expect(screen.hint()).toContain("k running only");
	screen.press("k");
	expect(screen.body()).toContain("Running subagents (1 of 2)");
	expect(names()).toEqual(["worker  build the thing  a1"]);
	expect(screen.hint()).toContain("k every agent");
	screen.press("k");
	expect(names()).toHaveLength(2);

	const idle = openOverlay(viewOf(messages, { agents: [agents[1]] }), { tab: "Fleet" }).press("k");
	expect(idle.body()).toContain("Running subagents (0 of 1)");
	expect(idle.body().join("\n")).toContain("No subagent runs now.");
	// The other views of the tab.
	expect(screen.press("v").body()).toContain("Timeline (earliest first)");
	expect(screen.press("v").body()).toContain("  [all 2]   in progress 1   pending 0   done 1");
});

test("the Settings tab closes the overlay with the setting to edit or to clear, and opens on the setting that was chosen last", () => {
	const edit = openOverlay(data, { tab: "Settings" });
	expect(edit.body().find((line) => line.startsWith("▶"))).toStartWith("▶ Context warning");
	edit.press("down", "enter");
	expect(edit.log.closed).toEqual([{ setting: "compact", clear: false }]);

	const clear = openOverlay(data, { tab: "Settings" });
	expect(clear.body().find((line) => line.startsWith("▶"))).toStartWith("▶ Auto-compact");
	clear.press("x");
	expect(clear.log.closed).toEqual([{ setting: "compact", clear: true }]);
});

test("q closes the overlay from any tab", () => {
	for (const tab of ["Stats", "Trend", "Fleet"] as const) {
		const screen = openOverlay(data, { tab }).press("q");
		expect(screen.log.closed).toEqual([undefined]);
	}
});
