import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	classifyTurnEnd,
	evaluateTurnEndLiveness,
	repeatsLastStall,
	TURN_END_LIVENESS_ENTRY_TYPE,
	type TurnEndLivenessInput,
} from "../../src/core/extensions/builtin/goal/turn-end-liveness.ts";
import type { AgentEndEvent } from "../../src/core/extensions/types.ts";
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

describe("evaluateTurnEndLiveness (#3863)", () => {
	it("reports a queued goal continuation as continuing", () => {
		expect(evaluateTurnEndLiveness(input({ continuationQueued: "goal" }))).toEqual({
			kind: "continuing",
			via: "goal",
		});
	});

	it("reports a delivered todo nudge as continuing", () => {
		expect(
			evaluateTurnEndLiveness(
				input({ openWork: { kind: "open-todos", count: 2 }, continuationQueued: "todo-backstop" }),
			),
		).toEqual({ kind: "continuing", via: "todo-backstop" });
	});

	it.each([
		["a running child", { kind: "wake-source", source: "senpi-task" }],
		["a live monitor", { kind: "wake-source", source: "terminal-monitors" }],
		["an armed backstop timer", { kind: "armed-timer", timer: "monitor" }],
		["a staged provider recovery", { kind: "recovery-staged" }],
		["a queued message", { kind: "pending-messages" }],
		["an open question to the user", { kind: "question-to-user" }],
	] as const)("waits on %s", (_label, expectation) => {
		expect(evaluateTurnEndLiveness(input({ expectations: [expectation] }))).toEqual({
			kind: "waiting",
			on: [expectation],
		});
	});

	it("is done when no work is open and nothing will re-enter", () => {
		expect(evaluateTurnEndLiveness(input({ openWork: { kind: "none" } }))).toEqual({ kind: "done" });
	});

	it("is stalled with no wake when work is open and nothing will re-enter", () => {
		expect(evaluateTurnEndLiveness(input({ openWork: { kind: "open-todos", count: 1 } }))).toEqual({
			kind: "stalled",
			reason: "no-wake",
		});
	});

	it("is stalled on budget when a guard refused to continue open work", () => {
		expect(evaluateTurnEndLiveness(input({ budgetSpent: true }))).toEqual({ kind: "stalled", reason: "budget" });
	});

	it("records the reset time for a provider-error stall, even with no open work", () => {
		expect(
			evaluateTurnEndLiveness(
				input({ openWork: { kind: "none" }, endedBy: "provider-error", providerRetryAtMs: 1_800_000 }),
			),
		).toEqual({ kind: "stalled", reason: "provider-error", retryAtMs: 1_800_000 });
		expect(evaluateTurnEndLiveness(input({ endedBy: "provider-error" }))).toEqual({
			kind: "stalled",
			reason: "provider-error",
		});
	});

	it.each([
		["user-abort", { endedBy: "user-abort" }],
		["child-session", { isChildSession: true }],
		["non-interactive", { mode: "print" }],
		["non-interactive", { mode: "json" }],
		["deadline-stop", { deadlineStop: true }],
		["goal-stopped", { goalStopped: true }],
	] as const)("holds (%s) open work that nothing re-enters", (reason, overrides) => {
		expect(evaluateTurnEndLiveness(input(overrides))).toEqual({ kind: "held", reason });
	});

	it("never reports a continuation that a lane queued as held", () => {
		expect(evaluateTurnEndLiveness(input({ isChildSession: true, continuationQueued: "goal" }))).toEqual({
			kind: "continuing",
			via: "goal",
		});
	});

	it.each([
		["a retryable provider error", "provider-error"],
		["a system abort the core retries", "system-abort"],
	] as const)("reports %s as continuing via retry, never stalled", (_label, endedBy) => {
		expect(
			evaluateTurnEndLiveness(input({ endedBy, willRetry: true, openWork: { kind: "none" }, budgetSpent: true })),
		).toEqual({ kind: "continuing", via: "retry" });
	});

	it.each([
		["child-session", { isChildSession: true }],
		["user-abort", { endedBy: "user-abort" }],
		["deadline-stop", { deadlineStop: true }],
		["goal-stopped", { goalStopped: true }],
	] as const)("a live wake outranks held (%s)", (_reason, overrides) => {
		const on = [{ kind: "wake-source", source: "terminal-monitors" }] as const;
		expect(evaluateTurnEndLiveness(input({ ...overrides, expectations: on }))).toEqual({ kind: "waiting", on });
	});

	it("holds a print/json run even while a wake source is live, since the run exits", () => {
		expect(
			evaluateTurnEndLiveness(
				input({ mode: "print", expectations: [{ kind: "wake-source", source: "terminal-monitors" }] }),
			),
		).toEqual({ kind: "held", reason: "non-interactive" });
	});

	it("reports a provider error with a staged recovery as waiting on it", () => {
		expect(
			evaluateTurnEndLiveness(input({ endedBy: "provider-error", expectations: [{ kind: "recovery-staged" }] })),
		).toEqual({ kind: "waiting", on: [{ kind: "recovery-staged" }] });
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
		["provider-error", end({ messages: [fauxAssistantMessage("", { stopReason: "error", errorMessage: "529" })] })],
	] as const)("classifies %s", (kind, event) => {
		expect(classifyTurnEnd(event)).toBe(kind);
	});
});

describe("repeatsLastStall (#3863)", () => {
	const stall = (reason: string): SessionEntry =>
		({
			type: "custom",
			id: `s-${reason}`,
			parentId: null,
			timestamp: "2026-10-21T00:00:00.000Z",
			customType: TURN_END_LIVENESS_ENTRY_TYPE,
			data: { verdict: { kind: "stalled", reason }, openWork: { kind: "open-todos", count: 1 } },
		}) as SessionEntry;
	const userMessage: SessionEntry = {
		type: "message",
		id: "u",
		parentId: null,
		timestamp: "2026-10-21T00:00:01.000Z",
		message: { role: "user", content: "keep going", timestamp: 1 },
	} as SessionEntry;
	const verdict = { kind: "stalled", reason: "no-wake" } as const;

	it("skips a stall identical to the last one since the last user message", () => {
		expect(repeatsLastStall([stall("no-wake")], verdict)).toBe(true);
	});

	it("records again after a user message or a different stall", () => {
		expect(repeatsLastStall([stall("no-wake"), userMessage], verdict)).toBe(false);
		expect(repeatsLastStall([stall("budget")], verdict)).toBe(false);
		expect(repeatsLastStall([], verdict)).toBe(false);
	});
});
