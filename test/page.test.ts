import { afterAll, expect, test } from "bun:test";
import { rowsOf, sumTokens, type ViewData } from "../src/analyze.ts";
import { type El, servePage } from "./page.ts";
import { assistant, call, rebuilt, result, viewOf } from "./session.ts";

// The web page, run whole in the DOM of ./page.ts against a real server: a test clicks and types as a reader does.

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const config = { a: { b: [1, 2, { "odd key": "line one\nline two" }] }, n: 42 };
/** Three requests. The rows of the context: 0 user, 1 call, 2 the JSON result, 3 to 5 calls, 6 to 8 results, 9 the answer. */
const messages = [
	{ role: "user", content: [{ type: "text", text: "read the config" }, { type: "image", data: PNG, mimeType: "image/png" }], timestamp: 1000 },
	assistant(2000, 100, [call("c1", "read", { path: "/work/config.json" })]),
	result(3000, "c1", "read", JSON.stringify(config)),
	assistant(4000, 400, [call("c2", "bash", { command: "ls -la", timeout: 30 }), call("c3", "write", { path: "/work/src/zeta.ts", content: "a\nb" }), call("c4", "read", { path: "/work/lib/alpha.ts" })]),
	result(5000, "c2", "bash", "a.txt\nb.txt"),
	result(5100, "c3", "write", "Wrote 2 lines"),
	result(5200, "c4", "read", "export const a = 1;"),
	assistant(6000, 600, [{ type: "text", text: "Done." }]),
];
const agents = [
	{ id: "a1", type: "worker", description: "build the thing", status: "running", startedAt: 5000 },
	{ id: "a2", type: "scout", description: "read the docs", status: "completed", startedAt: 1000, completedAt: 4000 },
] as ViewData["agents"];

const pages: { close(): void }[] = [];
afterAll(() => pages.forEach((page) => page.close()));
async function open(told = messages) {
	const page = await servePage(viewOf(told, { ...rebuilt(told), agents }));
	pages.push(page);
	// Nothing is laid out: the trend is 600 wide and shows every bar, and a bar is 100 high.
	page.document.measure = (el, what) => (what !== "clientHeight" ? 600 : el.matches(".stack.dna") ? 100 : 190);
	return page;
}
const image = (el: El): string => el.style.backgroundImage ?? "";
/** The messages with requests as large as their items are estimated: the items of a bar explain its change. */
function sized(told: any[]): any[] {
	const out: any[] = [];
	for (const message of told) out.push(message.role === "assistant" ? assistant(message.timestamp, sumTokens(rowsOf(out, undefined, [], false)), message.content) : message);
	return out;
}
/** A part of a bar that is clear when an item is lit: the item is there. */
const WINDOW = /, transparent [\d.]+% [\d.]+%/;

test("the page shows the session that the server tells", async () => {
	const page = await open();
	expect(page.one("#title").textContent).toBe("Test session");
	expect(page.one("#error").hidden).toBe(true);
	expect(page.all("#trend .col").map((col) => col.dataset.n)).toEqual(["1", "2", "3"]);
	expect(page.texts("#browser .cat b")).toEqual(["User messages 1 items", "Tool calls 4 items", "Tool results 4 items", "Answers 1 items"]);
	expect(page.one("#stats .body").textContent).toContain("3Requests");
});

test("a JSON item shows as a tree: its values open and close, and a value and its path are copied", async () => {
	const page = await open();
	await page.click('#browser [data-act="band"][data-i="2"]');
	// As text at first, below the call that the result answers.
	expect(page.texts("#browser pre")).toContain(JSON.stringify(config));
	await page.click('#browser [data-act="mode"][data-mode="json"]');
	// A line without its copy buttons.
	const lines = () => page.all("#browser .tree .jl").map((line) => line.textContent.slice(0, line.textContent.length - line.querySelector(".jt")!.textContent.length));
	const node = (...path: (string | number)[]) => page.all("#browser .tree .jl.fold").find((line) => line.dataset.path === JSON.stringify(path))!;
	const copy = (what: string, ...path: (string | number)[]) => page.all('#browser [data-act="jcopy"]').find((button) => button.dataset.path === JSON.stringify(path) && button.dataset.what === what)!;
	// Two levels are open at first.
	expect(lines()).toEqual(["▾{2}", "▾a: {1}", "▸b: [3]", "n: 42"]);

	await page.click(node("a", "b"));
	expect(lines()).toEqual(["▾{2}", "▾a: {1}", "▾b: [3]", "0: 1", "1: 2", "▸2: {1}", "n: 42"]);
	await page.click(node("a", "b", 2));
	expect(lines()).toContain('odd key: "line one\\nline two"');

	await page.click(copy("value", "n"));
	await page.click(copy("path", "a", "b", 2, "odd key"));
	await page.click(copy("value", "a", "b", 2, "odd key"));
	await page.click(copy("value"));
	expect(page.copied).toEqual(["42", 'a.b[2]["odd key"]', "line one\nline two", JSON.stringify(config, null, 2)]);
	// A copy does not close the value of its line.
	expect(lines()).toHaveLength(8);

	await page.click(node("a"));
	expect(lines()).toEqual(["▾{2}", "▸a: {1}", "n: 42"]);
	// A value that was opened is open again when the value around it opens.
	await page.click(node("a"));
	expect(lines()).toHaveLength(8);
});

test("a find in a JSON tree opens every value, marks the matches, and keeps the caret in the find box", async () => {
	const page = await open();
	await page.click('#browser [data-act="band"][data-i="2"]');
	await page.click('#browser [data-act="mode"][data-mode="json"]');
	expect(page.all("#browser .tree .jl")).toHaveLength(4);
	await page.type('#browser [data-find="2"]', "line");
	expect(page.all("#browser .tree .jl")).toHaveLength(8);
	const marks = () => page.all("#browser .tree mark").map((mark) => [mark.textContent, mark.classList.contains("at")]);
	expect(marks()).toEqual([["line", true], ["line", false]]);
	expect(page.one("#browser .viewer").textContent).toContain("1 of 2");
	const box = page.one('#browser [data-find="2"]');
	expect(box.value).toBe("line");
	expect(page.document.activeElement).toBe(box);

	await page.key(box, "Enter");
	expect(marks()).toEqual([["line", false], ["line", true]]);
	expect(page.one("#browser .viewer").textContent).toContain("2 of 2");
	await page.key('#browser [data-find="2"]', "Enter", { shiftKey: true });
	expect(marks()).toEqual([["line", true], ["line", false]]);
});

test("an opened item shows its images with their size", async () => {
	const page = await open();
	expect(page.one('#browser [data-act="band"][data-i="0"]').title).toContain("User messages");
	await page.click('#browser [data-act="band"][data-i="0"]');
	expect(page.one('#browser .item[data-i="0"] .pill').textContent).toBe("1 image");
	expect(page.one("#browser .shot img").attrs.get("src")).toBe("data:image/png;base64," + PNG);
	expect(page.one("#browser .shot figcaption").textContent).toBe("image/png · 1×1 px · 70 B · ≈1 tokens");
});

test("the files are ordered by path or by name, and filtered by path", async () => {
	const page = await open();
	const files = () => page.texts("#files tbody .mono");
	expect(files()).toEqual(["/work/config.json", "/work/src/zeta.ts", "/work/lib/alpha.ts"]);
	await page.click('[data-act="files"][data-order="file"]');
	expect(files()).toEqual(["/work/lib/alpha.ts", "/work/config.json", "/work/src/zeta.ts"]);
	expect(page.all('[data-act="files"]').filter((button) => button.classList.contains("on")).map((button) => button.dataset.order)).toEqual(["file"]);
	await page.click('[data-act="files"][data-order="name"]');
	expect(files()).toEqual(["/work/config.json", "/work/lib/alpha.ts", "/work/src/zeta.ts"]);
	await page.type("#file-filter", "zeta");
	expect(files()).toEqual(["/work/src/zeta.ts"]);
});

test("the agents are all the agents, or the running ones", async () => {
	const page = await open();
	const shown = () => page.texts("#agents .agent b");
	expect(shown()).toEqual(["▸ worker", "▸ scout"]);
	await page.click('[data-act="pick"][data-key="agentState"][data-value="running"]');
	expect(shown()).toEqual(["▸ worker"]);
	await page.click('[data-act="pick"][data-key="agentState"][data-value=""]');
	expect(shown()).toHaveLength(2);
});

test("DNA draws one band for each item of a bar, tells the item under the pointer, lights it in every bar, and a click reveals it", async () => {
	const page = await open();
	expect(page.all(".stack.dna")).toHaveLength(0);
	await page.click('[data-act="trend"][data-key="dna"]');
	const stacks = () => page.all(".stack.dna");
	expect(stacks().map((stack) => stack.dataset.side)).toEqual(["1", "1", "1"]);
	// The bands run upward from the first item, the user message. The first bar holds nothing else.
	expect(image(stacks()[0])).toBe("linear-gradient(to top, #22c55e 0% 100%)");
	expect(image(stacks()[2])).toStartWith("linear-gradient(to top, #22c55e 0% ");
	expect(image(stacks()[2]).split("% ").length).toBeGreaterThan(image(stacks()[1]).split("% ").length);
	expect(page.one("#tip").hidden).toBe(true);

	// The top of the last bar: its last item, which no other bar holds.
	await page.hover(stacks()[2], { clientX: 50, clientY: 5 });
	const tip = page.one("#tip");
	expect(tip.hidden).toBe(false);
	expect(tip.querySelector("b")!.textContent).toBe("result read");
	expect(tip.textContent).toContain("Tool results");
	expect(tip.textContent).toContain("export const a = 1;");
	expect(tip.textContent).toContain("#3");
	expect(stacks().map((stack) => WINDOW.test(image(stack)))).toEqual([false, false, true]);
	expect(stacks().every((stack) => image(stack).includes("var(--card)"))).toBe(true);
	// The bottom: the user message, which every bar holds.
	await page.hover(stacks()[2], { clientX: 50, clientY: 99 });
	expect(page.one("#tip b").textContent).toBe("user");
	expect(stacks().map((stack) => WINDOW.test(image(stack)))).toEqual([true, true, true]);

	await page.hover("body");
	expect(page.one("#tip").hidden).toBe(true);
	expect(stacks().some((stack) => image(stack).includes("var(--card)"))).toBe(false);

	await page.click(stacks()[2], { clientX: 50, clientY: 5 });
	expect(page.get("state").request).toBe(3);
	expect(page.document.shown?.classList.contains("item")).toBe(true);
	expect(page.document.shown?.querySelector(".pv")?.textContent).toBe("export const a = 1;");
});

test("DNA with Changes draws the items that came with a bar", async () => {
	const page = await open(sized(messages));
	await page.click('[data-act="trend"][data-key="dna"]');
	await page.click('[data-act="trend"][data-key="delta"]');
	const stacks = page.all(".stack.dna");
	expect(stacks.map((stack) => stack.dataset.side)).toEqual(["1", "1", "1"]);
	// The user message came with the first bar only.
	expect(stacks.map((stack) => image(stack).includes("#22c55e"))).toEqual([true, false, false]);
	await page.hover(stacks[1], { clientX: 50, clientY: 5 });
	expect(page.one("#tip b").textContent).toBe("result read");
	expect(page.one("#tip").textContent).toContain("came: ");
	expect(page.one("#tip").textContent).toContain("line one");
});

test("a bar whose items are in doubt is hatched, and not with Changes", async () => {
	// The context falls from 12000 to 3000 tokens, and no item left it.
	const told = [
		{ role: "user", content: "go", timestamp: 1000 },
		assistant(2000, 10000, [call("c1", "bash", { command: "ls" })]),
		result(3000, "c1", "bash", "a.txt"),
		assistant(4000, 12000, [call("c2", "bash", { command: "pwd" })]),
		result(5000, "c2", "bash", "/work"),
		assistant(6000, 3000, [{ type: "text", text: "Done." }]),
	];
	const page = await open(told);
	await page.click('[data-act="trend"][data-key="dna"]');
	const doubted = () => page.all("#trend .col").map((col) => col.classList.contains("doubt"));
	expect(doubted()).toEqual([false, false, true]);
	expect(page.all("#trend .col")[2].dataset.tip).toContain("items in doubt since request #3");
	expect(page.all("#trend .col")[1].dataset.tip).not.toContain("doubt");
	expect(page.one("#trend .body").textContent).toContain("A hatched bar");

	await page.click('[data-act="trend"][data-key="delta"]');
	expect(doubted()).toEqual([false, false, false]);
	expect(page.one("#trend .body").textContent).not.toContain("A hatched bar");
});

test("a category with many items has a filter box of its own, which leaves the other categories alone", async () => {
	const calls = Array.from({ length: 10 }, (_, i) => call(`c${i}`, "bash", { command: `cat file-${i}.txt` }));
	const told = [
		{ role: "user", content: "read the files", timestamp: 1000 },
		assistant(2000, 100, calls),
		...calls.map((one, i) => result(3000 + i, one.id, "bash", `content of file ${i}`)),
		assistant(4000, 400, [{ type: "text", text: "Done." }]),
	];
	const page = await open(told);
	const cat = (name: string) => page.all("#browser .cat").find((title) => title.textContent.includes(name))!;
	const labels = (label: string) => page.texts("#browser .item .lbl").filter((text) => text === label).length;
	const box = () => page.one(`#browser [data-cat-find="${cat("Tool calls").dataset.cat}"]`);
	expect(page.all("#browser .catfind")).toHaveLength(0);
	await page.click(cat("User messages"));
	await page.click(cat("Tool calls"));
	await page.click(cat("Tool results"));
	// The user message is alone in its category: no box.
	expect(page.all("#browser .catfind")).toHaveLength(2);
	expect([labels("user"), labels("call bash"), labels("result bash")]).toEqual([1, 10, 10]);

	await page.type(box(), "file-7");
	expect([labels("user"), labels("call bash"), labels("result bash")]).toEqual([1, 1, 10]);
	expect(cat("Tool calls").querySelector("small")!.textContent).toBe("1 of 10 items");
	expect(cat("Tool results").querySelector("small")!.textContent).toBe("10 items");
	expect(box().value).toBe("file-7");
	expect(page.document.activeElement).toBe(box());
	// The strip dims the items that the box leaves out.
	expect(page.all("#browser .strip .off")).toHaveLength(9);

	await page.type(box(), "no such file");
	expect(labels("call bash")).toBe(0);
	expect(page.one("#browser").textContent).toContain("Nothing matches.");
	expect(cat("Tool calls").querySelector("small")!.textContent).toBe("0 of 10 items");

	// A band shows its item, also when the box leaves the item out: the box is cleared.
	await page.click('#browser [data-act="band"][data-i="3"]');
	expect(box().value).toBe("");
	expect(labels("call bash")).toBe(10);
	expect(page.document.shown?.querySelector(".pv")?.textContent).toContain("file-2");

	// A closed category and the one list of all items take no box.
	await page.type(box(), "file-7");
	await page.click(cat("Tool calls"));
	expect(cat("Tool calls").querySelector("small")!.textContent).toBe("10 items");
	expect(page.all("#browser .strip .off")).toHaveLength(0);
	await page.click(cat("Tool calls"));
	expect(labels("call bash")).toBe(1);
	await page.choose("#order", "flat");
	expect(page.all("#browser .catfind")).toHaveLength(0);
	expect(labels("call bash")).toBe(10);
});
