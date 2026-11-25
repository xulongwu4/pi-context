import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type AgentRec, contentText } from "./analyze.ts";

export const FLEET_KINDS = ["delegation", "steer", "result", "notification", "completion", "task"] as const;
export type FleetKind = (typeof FLEET_KINDS)[number];

/** One event of the work with subagents and tasks. */
export interface FleetEvent {
	time: number;
	kind: FleetKind;
	/** Id of the agent that the event concerns, when the session tells it. */
	agent?: string;
	/** What happened, in one line. */
	title: string;
	/** The prompt, the message or the reply. */
	body?: string;
}

/** The event that a tool call of pi-subagents or pi-tasks makes. */
function callEvent(call: any, time: number): FleetEvent | undefined {
	const args = call.arguments ?? {};
	if (call.name === "Agent") return { time, kind: "delegation", title: `${args.subagent_type ?? "agent"}: ${args.description ?? ""}`, body: args.prompt };
	if (call.name === "steer_subagent") return { time, kind: "steer", agent: args.agent_id, title: "message to the agent", body: args.message };
	if (call.name === "get_subagent_result") return { time, kind: "result", agent: args.agent_id, title: "result read" };
	if (call.name === "TaskCreate") return { time, kind: "task", title: `task created: ${args.subject ?? ""}`, body: args.description };
	if (call.name === "TaskUpdate") {
		const changes = [args.status, args.owner && `owner ${args.owner}`].filter(Boolean).join(", ");
		return { time, kind: "task", title: `task #${args.taskId}: ${changes || "updated"}` };
	}
	return undefined;
}

/**
 * The delegations, messages, result reads, notifications and completions of the subagents of one branch,
 * and the changes of its tasks, oldest first. `agents` gives a delegation without an agent id the agent of its type and description.
 */
export function timelineOf(entries: any[], agents: AgentRec[] = []): FleetEvent[] {
	const events: FleetEvent[] = [];
	/** Events that wait for the result of their tool call. */
	const pending = new Map<string, FleetEvent>();
	const completions = new Map<string, FleetEvent>();
	for (const entry of entries) {
		const entryTime = Date.parse(entry.timestamp) || 0;
		if (entry.type === "custom" && entry.customType === "subagents:record" && entry.data?.completedAt) {
			const { id, type, description, status, completedAt, result, error } = entry.data;
			completions.set(id, { time: completedAt, kind: "completion", agent: id, title: `${type}: ${description} — ${status}`, body: result ?? error });
		} else if (entry.type === "custom_message" && (entry.customType === "subagent-notification" || entry.customType === "workflow-result")) {
			const details = entry.details ?? {};
			const title = details.description ? `${details.description} — ${details.status}` : entry.customType;
			events.push({ time: entryTime, kind: "notification", agent: details.id, title, body: contentText(entry.content) });
		}
		if (entry.type !== "message") continue;
		const m = entry.message;
		const time = m.timestamp ?? entryTime;
		const add = (call: any) => {
			const event = callEvent(call, time);
			if (event) events.push(event);
			return event;
		};
		if (m.role === "assistant") {
			for (const call of Array.isArray(m.content) ? m.content : []) {
				const event = call?.type === "toolCall" ? add(call) : undefined;
				if (event) pending.set(call.id, event);
			}
		} else if (m.role === "toolResult") {
			const event = pending.get(m.toolCallId);
			if (event?.kind === "delegation") event.agent = m.details?.agentId;
			if (event?.kind === "result") event.body = contentText(m.content);
			// Calls made by another tool, for example from a script, come without their results.
			for (const nested of m.nestedCalls?.calls ?? []) add(nested);
		}
	}
	events.push(...completions.values());
	const free = agents.filter((agent) => !events.some((event) => event.kind === "delegation" && event.agent === agent.id));
	for (const event of events) {
		if (event.kind !== "delegation" || event.agent) continue;
		const index = free.findIndex((agent) => event.title === `${agent.type}: ${agent.description}`);
		if (index >= 0) event.agent = free.splice(index, 1)[0].id;
	}
	return events.sort((a, b) => a.time - b.time);
}

/** A task of pi-tasks. */
export interface TaskRec {
	id: string;
	subject: string;
	description?: string;
	status: string;
	owner?: string;
	blocks: string[];
	blockedBy: string[];
	updatedAt?: number;
}

function readJson(file: string): any {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return {};
	}
}

/** The file in which pi-tasks keeps the tasks of the session. Undefined when it keeps them in memory. */
export function taskFile(cwd: string, sessionId: string, agentDir: string, env: Record<string, string | undefined> = process.env): string | undefined {
	const named = env.PI_TASKS;
	if (named === "off") return undefined;
	if (named?.startsWith("/")) return named;
	if (named?.startsWith(".")) return resolve(cwd, named);
	if (named) return join(homedir(), ".pi", "tasks", `${named}.json`);
	const scope = readJson(join(cwd, ".pi", "tasks-config.json")).taskScope ?? readJson(join(agentDir, "tasks-config.json")).taskScope ?? "session";
	if (scope === "memory") return undefined;
	if (scope !== "session" && scope !== "session-global") return join(cwd, ".pi", "tasks", "tasks.json");
	const inWorkspace = join(cwd, ".pi", "tasks", `tasks-${sessionId}.json`);
	if (scope === "session" || existsSync(inWorkspace)) return inWorkspace;
	const project = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(agentDir, "tasks", "sessions", project, `tasks-${sessionId}.json`);
}

/** The tasks in a file of pi-tasks. None when the file is missing or unreadable. */
export function readTasks(file: string | undefined): TaskRec[] {
	const tasks = file ? readJson(file).tasks : undefined;
	if (!Array.isArray(tasks)) return [];
	return tasks.map((task: any) => ({
		id: String(task.id),
		subject: task.subject ?? "",
		description: task.description || undefined,
		status: task.status ?? "pending",
		owner: task.owner || undefined,
		blocks: (task.blocks ?? []).map(String),
		blockedBy: (task.blockedBy ?? []).map(String),
		updatedAt: task.updatedAt,
	}));
}

export const TASK_STATES = ["in_progress", "pending", "done"] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** A task, or a delegation to a subagent, on the board. */
export interface BoardItem {
	id: string;
	subject: string;
	state: TaskState;
	/** The status as pi-tasks or pi-subagents names it. */
	status: string;
	description?: string;
	/** Ids of the unfinished tasks that must finish first. */
	blockedBy: string[];
	/** The final reply of the agent, or its error. */
	reply?: string;
	/** Set for a delegation: the id of the agent. */
	agent?: string;
}

/**
 * The board: the tasks by owner, then the delegations of this session by agent type. With `state`, only the items in that state.
 * A task without an owner is under "unassigned".
 */
export function boardOf(tasks: TaskRec[], agents: AgentRec[], state?: TaskState): { owner: string; items: BoardItem[] }[] {
	const groups = new Map<string, BoardItem[]>();
	const put = (owner: string, item: BoardItem) => {
		if (!state || item.state === state) groups.set(owner, [...(groups.get(owner) ?? []), item]);
	};
	const open = new Set(tasks.filter((task) => task.status !== "completed").map((task) => task.id));
	for (const task of tasks) {
		put(task.owner ?? "unassigned", {
			id: task.id,
			subject: task.subject,
			state: task.status === "completed" ? "done" : task.status === "in_progress" ? "in_progress" : "pending",
			status: task.status,
			description: task.description,
			blockedBy: task.blockedBy.filter((id) => open.has(id)),
		});
	}
	for (const agent of agents) {
		// An agent that another agent started is not a delegation of this session.
		if (agent.parent) continue;
		put(agent.type, {
			id: agent.id,
			subject: agent.description,
			state: agent.status === "running" ? "in_progress" : agent.status === "queued" ? "pending" : "done",
			status: agent.status,
			blockedBy: [],
			reply: agent.result ?? agent.error,
			agent: agent.id,
		});
	}
	return [...groups].map(([owner, items]) => ({ owner, items }));
}

export type Board = ReturnType<typeof boardOf>;

/** The figures of the fleet: its agents and those that run, the items of the board, and the messages to and from the agents. */
export function fleetSummary(agents: AgentRec[], timeline: FleetEvent[], board: Board): { agents: number; running: number; items: number; messages: number } {
	return {
		agents: agents.length,
		running: agents.filter((agent) => agent.status === "running").length,
		items: board.reduce((sum, group) => sum + group.items.length, 0),
		messages: timeline.filter((event) => event.kind === "steer" || event.kind === "notification").length,
	};
}

/** What one agent was asked and answered, the tasks that it or its type owns, and its last events. */
export function agentDetail(agent: AgentRec, timeline: FleetEvent[], board: Board): { prompt?: string; reply?: string; tasks: BoardItem[]; events: FleetEvent[] } {
	return {
		prompt: timeline.find((event) => event.kind === "delegation" && event.agent === agent.id)?.body,
		reply: agent.result ?? agent.error,
		tasks: board.filter((group) => group.owner === agent.id || group.owner === agent.type).flatMap((group) => group.items.filter((item) => !item.agent)),
		events: timeline.filter((event) => event.agent === agent.id).slice(-6),
	};
}

/** Ids of the tasks that must finish before the task `id`: its blockers, then theirs, the nearest first. */
export function chainOf(tasks: TaskRec[], id: string): string[] {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const chain: string[] = [];
	const seen = new Set([id]);
	for (let queue = [id]; queue.length > 0; ) {
		const next: string[] = [];
		for (const blocker of queue.flatMap((each) => byId.get(each)?.blockedBy ?? [])) {
			if (seen.has(blocker)) continue;
			seen.add(blocker);
			chain.push(blocker);
			next.push(blocker);
		}
		queue = next;
	}
	return chain;
}

/** Whether a pending task can start, or waits for other tasks. Undefined for a delegation and for a task that is not pending. */
export function readiness(item: BoardItem): "ready" | "blocked" | undefined {
	if (item.agent || item.state !== "pending") return undefined;
	return item.blockedBy.length > 0 ? "blocked" : "ready";
}
