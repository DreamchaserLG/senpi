import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	classifyTurnEnd,
	evaluateTurnEndLiveness,
	repeatsLastStall,
	TURN_END_LIVENESS_ENTRY_TYPE,
	TURN_END_RULES,
	type TurnEndKind,
	type TurnEndLivenessInput,
	type TurnEndLivenessVerdict,
	type WakeExpectation,
} from "../../src/core/extensions/builtin/goal/turn-end-liveness.ts";
import type { AgentEndEvent, ExtensionMode } from "../../src/core/extensions/types.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";

function input(overrides: Partial<TurnEndLivenessInput> = {}): TurnEndLivenessInput {
	return {
		isChildSession: false,
		mode: "tui",
		endedBy: "clean",
		willRetry: false,
		deadlineStop: false,
		goalStopped: false,
		openWork: { kind: "active-goal", goalId: "goal-1" },
		continuationQueued: undefined,
		expectations: [],
		budgetSpent: false,
		providerRetryAtMs: undefined,
		...overrides,
	};
}

const CHILD: WakeExpectation = { kind: "wake-source", source: "senpi-task" };
const MONITOR: WakeExpectation = { kind: "wake-source", source: "terminal-monitors" };
const GOAL_TIMER: WakeExpectation = { kind: "armed-timer", timer: "monitor" };
const RECOVERY: WakeExpectation = { kind: "recovery-staged" };
const QUESTION: WakeExpectation = { kind: "question-to-user" };
const QUEUED: WakeExpectation = { kind: "pending-messages" };

/** One representative input per row of TURN_END_RULES, with the verdict that row must produce. */
const ROWS: ReadonlyArray<readonly [string, string, Partial<TurnEndLivenessInput>, TurnEndLivenessVerdict]> = [
	[
		"retry",
		"the core retries a provider error",
		{ endedBy: "provider-error", willRetry: true },
		{ kind: "continuing", via: "retry" },
	],
	[
		"retry",
		"the core retries a system abort",
		{ endedBy: "system-abort", willRetry: true, deadlineStop: true },
		{ kind: "continuing", via: "retry" },
	],
	[
		"continuation-queued",
		"the goal lane queued a continuation",
		{ continuationQueued: "goal", isChildSession: true },
		{ kind: "continuing", via: "goal" },
	],
	[
		"continuation-queued",
		"the todo backstop nudged",
		{ continuationQueued: "todo-backstop", openWork: { kind: "open-todos", count: 2 } },
		{ kind: "continuing", via: "todo-backstop" },
	],
	[
		"non-interactive",
		"a print run exits even with a live monitor",
		{ mode: "print", expectations: [MONITOR] },
		{ kind: "held", reason: "non-interactive" },
	],
	["non-interactive", "a json run exits", { mode: "json" }, { kind: "held", reason: "non-interactive" }],
	["wake", "a running child will wake the parent", { expectations: [CHILD] }, { kind: "waiting", on: [CHILD] }],
	[
		"wake",
		"the goal's own backstop timer is armed",
		{ expectations: [GOAL_TIMER] },
		{ kind: "waiting", on: [GOAL_TIMER] },
	],
	[
		"wake",
		"a provider recovery is staged",
		{ endedBy: "provider-error", expectations: [RECOVERY] },
		{ kind: "waiting", on: [RECOVERY] },
	],
	["wake", "a queued message will start a turn", { expectations: [QUEUED] }, { kind: "waiting", on: [QUEUED] }],
	["wake", "a completed turn asked the user", { expectations: [QUESTION] }, { kind: "waiting", on: [QUESTION] }],
	[
		"wake",
		"a deadline stop with a running child: the child still delivers",
		{ deadlineStop: true, expectations: [CHILD] },
		{ kind: "waiting", on: [CHILD], heldBy: "deadline-stop" },
	],
	[
		"wake",
		"a user stop with a live monitor: the monitor still delivers",
		{ endedBy: "user-abort", expectations: [MONITOR] },
		{ kind: "waiting", on: [MONITOR], heldBy: "user-abort" },
	],
	[
		"wake",
		"a capped goal with a running child",
		{ goalStopped: true, budgetSpent: true, expectations: [CHILD] },
		{ kind: "waiting", on: [CHILD], heldBy: "goal-stopped" },
	],
	[
		"wake",
		"a child session with a live monitor",
		{ isChildSession: true, expectations: [MONITOR] },
		{ kind: "waiting", on: [MONITOR], heldBy: "child-session" },
	],
	[
		"held",
		"a deadline stop whose only wake is the goal's own timer",
		{ deadlineStop: true, expectations: [GOAL_TIMER, RECOVERY] },
		{ kind: "held", reason: "deadline-stop" },
	],
	[
		"held",
		"a deadline stop with nothing armed",
		{ endedBy: "system-abort", deadlineStop: true },
		{ kind: "held", reason: "deadline-stop" },
	],
	["held", "a user stop with nothing armed", { endedBy: "user-abort" }, { kind: "held", reason: "user-abort" }],
	["held", "a child session with nothing armed", { isChildSession: true }, { kind: "held", reason: "child-session" }],
	[
		"held",
		"a paused or blocked goal with nothing armed",
		{ goalStopped: true },
		{ kind: "held", reason: "goal-stopped" },
	],
	[
		"provider-error",
		"an error that names its reset time, even with nothing open",
		{ endedBy: "provider-error", providerRetryAtMs: 1_800_000, openWork: { kind: "none" } },
		{ kind: "stalled", reason: "provider-error", retryAtMs: 1_800_000 },
	],
	[
		"provider-error",
		"a policy rejection",
		{ endedBy: "policy-rejection" },
		{ kind: "stalled", reason: "provider-error" },
	],
	[
		"provider-error",
		"an errored turn's trailing question is not a wake",
		{ endedBy: "provider-error", providerRetryAtMs: 5_000, expectations: [QUESTION] },
		{ kind: "stalled", reason: "provider-error", retryAtMs: 5_000 },
	],
	[
		"aborted",
		"a system abort with nothing open",
		{ endedBy: "system-abort", openWork: { kind: "none" } },
		{ kind: "stalled", reason: "aborted", abortSource: "system" },
	],
	[
		"aborted",
		"a provider abort",
		{ endedBy: "provider-abort" },
		{ kind: "stalled", reason: "aborted", abortSource: "provider" },
	],
	[
		"aborted",
		"an abort with no attributed source",
		{ endedBy: "unknown-abort", openWork: { kind: "none" } },
		{ kind: "stalled", reason: "aborted" },
	],
	["budget", "a spent guard with open work", { budgetSpent: true }, { kind: "stalled", reason: "budget" }],
	[
		"no-wake",
		"open todos and nothing armed",
		{ openWork: { kind: "open-todos", count: 1 } },
		{ kind: "stalled", reason: "no-wake" },
	],
	["done", "a completed turn with nothing open", { openWork: { kind: "none" } }, { kind: "done" }],
];

describe("TURN_END_RULES (#3863): one decision table, one test per row", () => {
	it("covers every row of the table with at least one case", () => {
		expect(new Set(ROWS.map(([id]) => id))).toEqual(new Set(TURN_END_RULES.map((rule) => rule.id)));
	});

	it.each(ROWS)("row %s: %s", (id, _label, overrides, verdict) => {
		const case_ = input(overrides);
		expect(TURN_END_RULES.find((rule) => rule.when(case_))?.id).toBe(id);
		expect(evaluateTurnEndLiveness(case_)).toEqual(verdict);
	});
});

describe("TURN_END_RULES invariants over every stop x hold x open work x wake x queued combination (#3863)", () => {
	const stops: readonly TurnEndKind[] = [
		"clean",
		"user-abort",
		"system-abort",
		"provider-abort",
		"unknown-abort",
		"provider-error",
		"policy-rejection",
	];
	const holds: ReadonlyArray<Partial<TurnEndLivenessInput>> = [
		{},
		{ deadlineStop: true },
		{ goalStopped: true },
		{ isChildSession: true },
		{ budgetSpent: true },
		{ mode: "print" as ExtensionMode },
	];
	const works: ReadonlyArray<TurnEndLivenessInput["openWork"]> = [
		{ kind: "none" },
		{ kind: "active-goal", goalId: "g" },
		{ kind: "open-todos", count: 1 },
	];
	const wakes: ReadonlyArray<readonly WakeExpectation[]> = [[], [CHILD], [GOAL_TIMER], [QUESTION], [QUEUED]];
	const starts: ReadonlyArray<Partial<TurnEndLivenessInput>> = [
		{},
		{ willRetry: true },
		{ continuationQueued: "goal" },
	];
	const cases = stops.flatMap((endedBy) =>
		holds.flatMap((hold) =>
			works.flatMap((openWork) =>
				wakes.flatMap((expectations) =>
					starts.map((start) => input({ endedBy, openWork, expectations, ...hold, ...start })),
				),
			),
		),
	);

	it("enumerates every combination", () => {
		expect(cases).toHaveLength(stops.length * holds.length * works.length * wakes.length * starts.length);
	});

	it("never reports done for a turn that did not complete, or with work open", () => {
		for (const case_ of cases) {
			if (evaluateTurnEndLiveness(case_).kind !== "done") continue;
			expect(case_.endedBy).toBe("clean");
			expect(case_.openWork.kind).toBe("none");
		}
	});

	it("reports continuing exactly when a turn will start from a retry or a queued continuation", () => {
		for (const case_ of cases) {
			const starting = case_.willRetry || case_.continuationQueued !== undefined;
			expect(evaluateTurnEndLiveness(case_).kind === "continuing").toBe(starting);
		}
	});

	it("reports waiting only on a wake that will deliver, never on the goal's own timer during a deadline stop", () => {
		for (const case_ of cases) {
			const verdict = evaluateTurnEndLiveness(case_);
			if (verdict.kind !== "waiting") continue;
			expect(verdict.on.length).toBeGreaterThan(0);
			if (case_.deadlineStop) expect(verdict.on).not.toContainEqual(GOAL_TIMER);
			if (case_.endedBy !== "clean") expect(verdict.on).not.toContainEqual(QUESTION);
		}
	});

	it("never calls a run that exits waiting, and holds or stalls when nothing will deliver", () => {
		for (const case_ of cases) {
			const verdict = evaluateTurnEndLiveness(case_);
			if (case_.mode === "print" && !case_.willRetry && case_.continuationQueued === undefined) {
				expect(verdict).toEqual({ kind: "held", reason: "non-interactive" });
			}
			const nothingDelivers =
				!case_.willRetry &&
				case_.continuationQueued === undefined &&
				(case_.expectations.length === 0 ||
					(case_.deadlineStop && case_.expectations.every((w) => w === GOAL_TIMER)));
			if (nothingDelivers) expect(["held", "stalled", "done"]).toContain(verdict.kind);
		}
	});
});

describe("classifyTurnEnd (#3863)", () => {
	const end = (overrides: Partial<AgentEndEvent>): AgentEndEvent => ({
		type: "agent_end",
		messages: [fauxAssistantMessage("done")],
		willRetry: false,
		...overrides,
	});

	it.each([
		["clean", end({})],
		["user-abort", end({ aborted: true, abortSource: "user" })],
		["system-abort", end({ aborted: true, abortSource: "system" })],
		["provider-abort", end({ aborted: true, abortSource: "provider" })],
		[
			"provider-abort",
			end({ abortSource: "provider", messages: [fauxAssistantMessage("", { stopReason: "aborted" })] }),
		],
		["unknown-abort", end({ aborted: true })],
		["unknown-abort", end({ messages: [] })],
		["provider-error", end({ messages: [fauxAssistantMessage("", { stopReason: "error", errorMessage: "529" })] })],
	] as const)("classifies %s", (kind, event) => {
		expect(classifyTurnEnd(event)).toBe(kind);
	});
});

describe("repeatsLastStall (#3863)", () => {
	const stall = (verdict: Record<string, unknown>): SessionEntry =>
		({
			type: "custom",
			id: "s",
			parentId: null,
			timestamp: "2026-10-21T00:00:00.000Z",
			customType: TURN_END_LIVENESS_ENTRY_TYPE,
			data: { verdict: { kind: "stalled", ...verdict }, openWork: { kind: "open-todos", count: 1 } },
		}) as SessionEntry;
	const userMessage = {
		type: "message",
		id: "u",
		parentId: null,
		timestamp: "2026-10-21T00:00:01.000Z",
		message: { role: "user", content: "keep going", timestamp: 1 },
	} as SessionEntry;

	it("skips a stall identical to the last one since the last user message", () => {
		expect(repeatsLastStall([stall({ reason: "no-wake" })], { kind: "stalled", reason: "no-wake" })).toBe(true);
	});

	it("records a provider stall again when its reset time moved", () => {
		const last = [stall({ reason: "provider-error", retryAtMs: 1_000 })];
		expect(repeatsLastStall(last, { kind: "stalled", reason: "provider-error", retryAtMs: 2_000 })).toBe(false);
		expect(repeatsLastStall(last, { kind: "stalled", reason: "provider-error", retryAtMs: 1_000 })).toBe(true);
	});

	it("records again after a user message or a different stall", () => {
		const verdict = { kind: "stalled", reason: "no-wake" } as const;
		expect(repeatsLastStall([stall({ reason: "no-wake" }), userMessage], verdict)).toBe(false);
		expect(repeatsLastStall([stall({ reason: "budget" })], verdict)).toBe(false);
		expect(repeatsLastStall([], verdict)).toBe(false);
	});
});
