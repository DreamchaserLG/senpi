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

export type TurnEndKind = "clean" | "user-abort" | "system-abort" | "provider-error" | "policy-rejection";

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

export type StalledReason = "budget" | "provider-error" | "no-wake";

export type TurnEndLivenessVerdict =
	| { readonly kind: "continuing"; readonly via: "retry" | "goal" | "todo-backstop" }
	| { readonly kind: "held"; readonly reason: HeldReason }
	| { readonly kind: "waiting"; readonly on: readonly WakeExpectation[] }
	| { readonly kind: "done" }
	| { readonly kind: "stalled"; readonly reason: StalledReason; readonly retryAtMs?: number };

const NON_INTERACTIVE_MODES: ReadonlySet<ExtensionMode> = new Set(["print", "json"]);

export function classifyTurnEnd(event: AgentEndEvent): TurnEndKind {
	if (event.aborted === true && event.abortSource === "user") return "user-abort";
	if (event.aborted === true && event.abortSource === "system") return "system-abort";
	if (didTerminalPolicyRejectionEndTurn(event)) return "policy-rejection";
	if (didTerminalProviderErrorEndTurn(event)) return "provider-error";
	return didAgentEndCleanly(event.messages) ? "clean" : "provider-error";
}

/**
 * Order matters. A turn the core retries, or a continuation a lane queued, is reported first, so the verdict never
 * denies what happens next. A print/json run exits, so nothing re-enters it. Any live re-entry source then wins over
 * the remaining held reasons, which only name why nothing will continue on its own. An errored turn left its request
 * unfinished, so it is never `done`.
 */
export function evaluateTurnEndLiveness(input: TurnEndLivenessInput): TurnEndLivenessVerdict {
	if (input.willRetry) return { kind: "continuing", via: "retry" };
	if (input.continuationQueued !== undefined) return { kind: "continuing", via: input.continuationQueued };
	if (NON_INTERACTIVE_MODES.has(input.mode)) return { kind: "held", reason: "non-interactive" };
	if (input.expectations.length > 0) return { kind: "waiting", on: input.expectations };
	const held = heldReason(input);
	if (held !== undefined) return { kind: "held", reason: held };
	if (input.endedBy === "provider-error" || input.endedBy === "policy-rejection") {
		return input.providerRetryAtMs === undefined
			? { kind: "stalled", reason: "provider-error" }
			: { kind: "stalled", reason: "provider-error", retryAtMs: input.providerRetryAtMs };
	}
	if (input.openWork.kind === "none") return { kind: "done" };
	return { kind: "stalled", reason: input.budgetSpent ? "budget" : "no-wake" };
}

function heldReason(input: TurnEndLivenessInput): HeldReason | undefined {
	if (input.endedBy === "user-abort") return "user-abort";
	if (input.isChildSession) return "child-session";
	if (input.deadlineStop) return "deadline-stop";
	if (input.goalStopped) return "goal-stopped";
	return undefined;
}

/** True when the branch already records this stall since the last user message, so it is not written again. */
export function repeatsLastStall(
	branch: readonly SessionEntry[],
	verdict: Extract<TurnEndLivenessVerdict, { kind: "stalled" }>,
): boolean {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type === "message" && entry.message.role === "user") return false;
		if (entry?.type !== "custom" || entry.customType !== TURN_END_LIVENESS_ENTRY_TYPE) continue;
		const recorded = (entry.data as { verdict?: { reason?: unknown } } | undefined)?.verdict?.reason;
		return recorded === verdict.reason;
	}
	return false;
}
