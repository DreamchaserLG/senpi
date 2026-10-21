// Turn-end liveness (#3863): names what happens after a turn end from the outcomes the goal lane and the
// todo-owed backstop produced. It never starts or suppresses a turn.

import type { SessionEntry } from "../../../session-manager.ts";
import type { AgentEndEvent, ExtensionMode } from "../../types.ts";
import { didAgentEndCleanly } from "./continuation.ts";
import type { DelayedContinuationKind } from "./monitor-continuation-types.ts";
import { didTerminalPolicyRejectionEndTurn, didTerminalProviderErrorEndTurn } from "./terminal-provider-error.ts";

export const TURN_END_LIVENESS_EVENT = "turn_end_liveness";
/** Durable entry appended only for a `stalled` verdict: the session's last readable resume point. */
export const TURN_END_LIVENESS_ENTRY_TYPE = "turn-end-liveness";

export type TurnEndKind =
	| "clean"
	| "user-abort"
	| "system-abort"
	| "provider-abort"
	| "unknown-abort"
	| "provider-error"
	| "policy-rejection";

/** Something that will re-enter the session by itself. */
export type WakeExpectation =
	| { readonly kind: "wake-source"; readonly source: string }
	| { readonly kind: "armed-timer"; readonly timer: DelayedContinuationKind }
	| { readonly kind: "recovery-staged" }
	| { readonly kind: "pending-messages" }
	| { readonly kind: "question-to-user" };

export type OpenWork =
	| { readonly kind: "active-goal"; readonly goalId: string }
	| { readonly kind: "open-todos"; readonly count: number }
	| { readonly kind: "none" };

export interface TurnEndLivenessInput {
	readonly isChildSession: boolean;
	readonly mode: ExtensionMode;
	readonly endedBy: TurnEndKind;
	/** The core will retry or fall back after this end (`AgentEndEvent.willRetry`). */
	readonly willRetry: boolean;
	/** A turn-deadline stop is never auto-continued; it waits for user input. */
	readonly deadlineStop: boolean;
	/** Paused or blocked goal: it waits for a person by design. */
	readonly goalStopped: boolean;
	readonly openWork: OpenWork;
	/** The lane that queued a hidden continuation at this turn end, if any. */
	readonly continuationQueued: "goal" | "todo-backstop" | undefined;
	readonly expectations: readonly WakeExpectation[];
	/** An existing guard refused to continue: the goal's continuation stopped, or the todo chain hit its cap. */
	readonly budgetSpent: boolean;
	/** The earliest future instant the failed turn's error names (a usage-limit reset). */
	readonly providerRetryAtMs: number | undefined;
}

export type HeldReason = "user-abort" | "child-session" | "non-interactive" | "deadline-stop" | "goal-stopped";

export type StalledReason = "budget" | "provider-error" | "aborted" | "no-wake";

export type TurnEndLivenessVerdict =
	| { readonly kind: "continuing"; readonly via: "retry" | "goal" | "todo-backstop" }
	| { readonly kind: "held"; readonly reason: HeldReason }
	| { readonly kind: "waiting"; readonly on: readonly WakeExpectation[]; readonly heldBy?: HeldReason }
	| { readonly kind: "done" }
	| {
			readonly kind: "stalled";
			readonly reason: StalledReason;
			readonly retryAtMs?: number;
			readonly abortSource?: "system" | "provider";
	  };

const NON_INTERACTIVE_MODES: ReadonlySet<ExtensionMode> = new Set(["print", "json"]);

export function classifyTurnEnd(event: AgentEndEvent): TurnEndKind {
	if (event.aborted === true && event.abortSource === "user") return "user-abort";
	if (event.aborted === true && event.abortSource === "system") return "system-abort";
	if (event.abortSource === "provider") return "provider-abort";
	if (event.aborted === true) return "unknown-abort";
	if (didTerminalPolicyRejectionEndTurn(event)) return "policy-rejection";
	if (didTerminalProviderErrorEndTurn(event)) return "provider-error";
	return didAgentEndCleanly(event.messages) ? "clean" : "unknown-abort";
}

/** A goal-owned wake (the goal lane's own timer or staged recovery); the deadline hold suppresses these. */
function isGoalOwnedWake(expectation: WakeExpectation): boolean {
	return expectation.kind === "armed-timer" || expectation.kind === "recovery-staged";
}

/**
 * The wakes that will really start a turn. A question counts only on a turn that completed (an errored turn's
 * trailing "?" is not a question to answer), and a deadline stop suppresses the goal lane's own timer and
 * recovery. Monitors, background work, child tasks and queued messages still deliver during a deadline hold
 * (the hold is read only by the goal lane), so they stay.
 */
export function effectiveWakes(input: TurnEndLivenessInput): readonly WakeExpectation[] {
	return input.expectations.filter(
		(expectation) =>
			!(expectation.kind === "question-to-user" && input.endedBy !== "clean") &&
			!(input.deadlineStop && isGoalOwnedWake(expectation)),
	);
}

function heldReason(input: TurnEndLivenessInput): HeldReason | undefined {
	if (input.deadlineStop) return "deadline-stop";
	if (input.endedBy === "user-abort") return "user-abort";
	if (input.isChildSession) return "child-session";
	if (input.goalStopped) return "goal-stopped";
	return undefined;
}

function abortSourceOf(endedBy: TurnEndKind): "system" | "provider" | undefined {
	return endedBy === "system-abort" ? "system" : endedBy === "provider-abort" ? "provider" : undefined;
}

export interface TurnEndRule {
	readonly id: string;
	readonly when: (input: TurnEndLivenessInput) => boolean;
	readonly verdict: (input: TurnEndLivenessInput) => TurnEndLivenessVerdict;
}

/**
 * The whole decision, as one ordered table: the first matching row decides. Every input matches a row (the last
 * row has no condition). Rows 1-2 report a turn that will start; 3 a run that exits; 4 a wake that will deliver a
 * turn (with the stop reason, when one applies, as `heldBy`); 5 a stop that waits for a person; 6-9 open work that
 * nothing will bring back; 10 a completed turn with nothing open.
 */
export const TURN_END_RULES: readonly TurnEndRule[] = [
	{ id: "retry", when: (i) => i.willRetry, verdict: () => ({ kind: "continuing", via: "retry" }) },
	{
		id: "continuation-queued",
		when: (i) => i.continuationQueued !== undefined,
		verdict: (i) => ({ kind: "continuing", via: i.continuationQueued ?? "goal" }),
	},
	{
		id: "non-interactive",
		when: (i) => NON_INTERACTIVE_MODES.has(i.mode),
		verdict: () => ({ kind: "held", reason: "non-interactive" }),
	},
	{
		id: "wake",
		when: (i) => effectiveWakes(i).length > 0,
		verdict: (i) => {
			const held = heldReason(i);
			return { kind: "waiting", on: effectiveWakes(i), ...(held !== undefined ? { heldBy: held } : {}) };
		},
	},
	{
		id: "held",
		when: (i) => heldReason(i) !== undefined,
		verdict: (i) => ({ kind: "held", reason: heldReason(i) ?? "goal-stopped" }),
	},
	{
		id: "provider-error",
		when: (i) => i.endedBy === "provider-error" || i.endedBy === "policy-rejection",
		verdict: (i) =>
			i.providerRetryAtMs === undefined
				? { kind: "stalled", reason: "provider-error" }
				: { kind: "stalled", reason: "provider-error", retryAtMs: i.providerRetryAtMs },
	},
	{
		id: "aborted",
		when: (i) => i.endedBy === "system-abort" || i.endedBy === "provider-abort" || i.endedBy === "unknown-abort",
		verdict: (i) => {
			const abortSource = abortSourceOf(i.endedBy);
			return { kind: "stalled", reason: "aborted", ...(abortSource !== undefined ? { abortSource } : {}) };
		},
	},
	{
		id: "budget",
		when: (i) => i.openWork.kind !== "none" && i.budgetSpent,
		verdict: () => ({ kind: "stalled", reason: "budget" }),
	},
	{
		id: "no-wake",
		when: (i) => i.openWork.kind !== "none",
		verdict: () => ({ kind: "stalled", reason: "no-wake" }),
	},
	{ id: "done", when: () => true, verdict: () => ({ kind: "done" }) },
];

export function evaluateTurnEndLiveness(input: TurnEndLivenessInput): TurnEndLivenessVerdict {
	const rule = TURN_END_RULES.find((candidate) => candidate.when(input));
	return (rule ?? TURN_END_RULES[TURN_END_RULES.length - 1]!).verdict(input);
}

/** True when the branch already records this exact stall (reason, reset time, abort source) since the last user message. */
export function repeatsLastStall(
	branch: readonly SessionEntry[],
	verdict: Extract<TurnEndLivenessVerdict, { kind: "stalled" }>,
): boolean {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type === "message" && entry.message.role === "user") return false;
		if (entry?.type !== "custom" || entry.customType !== TURN_END_LIVENESS_ENTRY_TYPE) continue;
		const recorded = (entry.data as { verdict?: Record<string, unknown> } | undefined)?.verdict;
		return (
			recorded?.reason === verdict.reason &&
			recorded.retryAtMs === verdict.retryAtMs &&
			recorded.abortSource === verdict.abortSource
		);
	}
	return false;
}
