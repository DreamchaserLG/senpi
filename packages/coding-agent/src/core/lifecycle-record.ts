import type { TurnEndLivenessInput } from "./extensions/builtin/goal/turn-end-liveness.ts";
import { readHumanWait, type SyntheticAttention } from "./lifecycle-attention.ts";
import { readLifecycleState } from "./lifecycle-children.ts";
import { readLastStop } from "./lifecycle-stop.ts";
import { readWaitItems } from "./lifecycle-wait-items.ts";
import type { LifecycleHold, LifecycleWaits, SessionLifecycle } from "./session-lifecycle-types.ts";
import { isRecord } from "./work-custody-record.ts";

export interface LifecycleRecord extends Omit<SessionLifecycle, "activity" | "activityRevision"> {
	readonly sessionId: string;
	readonly attentionSeq: number;
	readonly synthetic: readonly SyntheticAttention[];
	readonly epochSealed: boolean;
	readonly settleRequest?: { readonly epoch: number; readonly revision: number };
	readonly runId?: string;
	readonly runActive: boolean;
	readonly interrupted: boolean;
	readonly completedGoalId?: string;
	readonly completedRunId?: string;
	readonly lastTurnEnd?: DurableTurnEnd;
}

export type DurableTurnEnd = Pick<
	TurnEndLivenessInput,
	"endedBy" | "deadlineStop" | "budgetSpent" | "providerRetryAtMs"
>;

/** Restore the wire snapshot and its private high-water marks from owned JSONL. */
export function readLifecycleRecord(value: unknown): LifecycleRecord | undefined {
	if (!isRecord(value)) return undefined;
	const state = readLifecycleState(value.state);
	if (
		!state ||
		typeof value.sessionId !== "string" ||
		typeof value.seq !== "number" ||
		typeof value.epoch !== "number" ||
		(value.epochOrigin !== "human" && value.epochOrigin !== "automatic") ||
		typeof value.humanInputRevision !== "number" ||
		typeof value.selfSettleEligible !== "boolean" ||
		typeof value.runPaused !== "boolean" ||
		typeof value.since !== "string" ||
		(value.role !== "root" && value.role !== "child") ||
		typeof value.rootSessionId !== "string"
	)
		return undefined;
	const synthetic: SyntheticAttention[] = [];
	if (Array.isArray(value.synthetic)) {
		for (const occurrence of value.synthetic) {
			if (!isRecord(occurrence) || typeof occurrence.key !== "string") continue;
			const wait = readHumanWait(occurrence.wait);
			if (wait) synthetic.push({ key: occurrence.key, wait });
		}
	}
	const waitingOn = readWaits(value.waitingOn);
	const holds = readHolds(value.holds);
	const completion = readCompletion(value.completion);
	const failure = readFailure(value.failure);
	const lastTurnEnd = readTurnEnd(value.lastTurnEnd);
	const lastStop = readLastStop(value.lastStop, value.runId);
	return {
		sessionId: value.sessionId,
		state,
		seq: value.seq,
		epoch: value.epoch,
		epochOrigin: value.epochOrigin,
		humanInputRevision: value.humanInputRevision,
		selfSettleEligible: value.selfSettleEligible,
		runPaused: value.runPaused,
		since: value.since,
		role: value.role,
		rootSessionId: value.rootSessionId,
		restoring: true,
		persisted: value.persisted === true,
		attentionSeq: typeof value.attentionSeq === "number" ? value.attentionSeq : 0,
		synthetic,
		epochSealed: value.epochSealed === true,
		runActive: value.runActive === true,
		interrupted: value.interrupted === true,
		...(typeof value.completedGoalId === "string" ? { completedGoalId: value.completedGoalId } : {}),
		...(typeof value.completedRunId === "string" ? { completedRunId: value.completedRunId } : {}),
		...(typeof value.completionId === "string" ? { completionId: value.completionId } : {}),
		...(typeof value.parentSessionId === "string" ? { parentSessionId: value.parentSessionId } : {}),
		...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
		...(typeof value.runId === "string" ? { runId: value.runId } : {}),
		...(waitingOn ? { waitingOn } : {}),
		...(holds ? { holds } : {}),
		...(completion ? { completion } : {}),
		...(failure ? { failure } : {}),
		...(lastTurnEnd ? { lastTurnEnd } : {}),
		...(lastStop ? { lastStop } : {}),
		...(isRecord(value.settleDecision) && typeof value.settleDecision.decisionId === "string"
			? { settleDecision: { decisionId: value.settleDecision.decisionId } }
			: {}),
		...(isRecord(value.settleRequest) &&
		typeof value.settleRequest.epoch === "number" &&
		typeof value.settleRequest.revision === "number"
			? { settleRequest: { epoch: value.settleRequest.epoch, revision: value.settleRequest.revision } }
			: {}),
	};
}

function readTurnEnd(value: unknown): DurableTurnEnd | undefined {
	if (!isRecord(value) || typeof value.deadlineStop !== "boolean" || typeof value.budgetSpent !== "boolean")
		return undefined;
	switch (value.endedBy) {
		case "clean":
		case "user-abort":
		case "system-abort":
		case "provider-abort":
		case "unknown-abort":
		case "provider-error":
		case "policy-rejection":
			return {
				endedBy: value.endedBy,
				deadlineStop: value.deadlineStop,
				budgetSpent: value.budgetSpent,
				providerRetryAtMs: typeof value.providerRetryAtMs === "number" ? value.providerRetryAtMs : undefined,
			};
		default:
			return undefined;
	}
}

function readWaits(value: unknown): LifecycleWaits | undefined {
	if (!isRecord(value) || typeof value.children !== "number") return undefined;
	const background: LifecycleWaits["background"][number][] = [];
	if (Array.isArray(value.background)) {
		for (const source of value.background) {
			if (!isRecord(source) || typeof source.source !== "string" || typeof source.activeCount !== "number") continue;
			background.push({
				source: source.source,
				activeCount: source.activeCount,
				...readWaitItems(source.items, source.omittedItems),
				...(typeof source.retryAtMs === "number" ? { retryAtMs: source.retryAtMs } : {}),
			});
		}
	}
	const human = Array.isArray(value.human)
		? value.human.flatMap((request) => {
				const wait = readHumanWait(request);
				return wait ? [wait] : [];
			})
		: [];
	const childSources: NonNullable<LifecycleWaits["childSources"]>[number][] = [];
	if (Array.isArray(value.childSources))
		for (const source of value.childSources) {
			if (!isRecord(source) || typeof source.source !== "string" || typeof source.activeCount !== "number") continue;
			childSources.push({
				source: source.source,
				activeCount: source.activeCount,
				...readWaitItems(source.items, source.omittedItems),
			});
		}
	const reports: NonNullable<LifecycleWaits["childReports"]>[number][] = [];
	if (Array.isArray(value.childReports))
		for (const report of value.childReports) {
			if (!isRecord(report)) continue;
			const state = readLifecycleState(report.state);
			if (
				!state ||
				typeof report.taskId !== "string" ||
				typeof report.childSessionId !== "string" ||
				typeof report.runEpoch !== "number" ||
				!Number.isSafeInteger(report.runEpoch) ||
				report.runEpoch < 0
			)
				continue;
			reports.push({
				taskId: report.taskId,
				childSessionId: report.childSessionId,
				runEpoch: report.runEpoch,
				state,
				...(typeof report.label === "string" ? { label: report.label } : {}),
				...(typeof report.since === "string" && Number.isFinite(Date.parse(report.since))
					? { since: report.since }
					: {}),
			});
		}
	reports.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
	const childReportsOmitted =
		Math.max(0, reports.length - 32) +
		(typeof value.childReportsOmitted === "number" &&
		Number.isSafeInteger(value.childReportsOmitted) &&
		value.childReportsOmitted > 0
			? value.childReportsOmitted
			: 0);
	return {
		children: value.children,
		background,
		human,
		...(childSources.length ? { childSources } : {}),
		...(reports.length ? { childReports: reports.slice(0, 32) } : {}),
		...(childReportsOmitted ? { childReportsOmitted } : {}),
	};
}

function readHolds(value: unknown): readonly LifecycleHold[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.flatMap((hold) => {
		if (!isRecord(hold) || typeof hold.since !== "string") return [];
		switch (hold.kind) {
			case "session_hold":
			case "run_fence":
			case "inherited_hold":
			case "unattended":
				return [{ kind: hold.kind, since: hold.since }];
			default:
				return [];
		}
	});
}

function readCompletion(value: unknown): SessionLifecycle["completion"] {
	if (!isRecord(value) || typeof value.at !== "string") return undefined;
	switch (value.kind) {
		case "goal":
		case "run":
		case "agent":
		case "reply":
			return {
				kind: value.kind,
				at: value.at,
				...(typeof value.goalId === "string" ? { goalId: value.goalId } : {}),
				...(typeof value.runId === "string" ? { runId: value.runId } : {}),
			};
		default:
			return undefined;
	}
}

function readFailure(value: unknown): SessionLifecycle["failure"] {
	if (!isRecord(value)) return undefined;
	switch (value.reason) {
		case "provider_error":
		case "tool_error":
		case "task_error":
		case "lost":
		case "interrupted":
			return {
				reason: value.reason,
				...(typeof value.message === "string" ? { message: value.message } : {}),
				...(typeof value.retryAtMs === "number" ? { retryAtMs: value.retryAtMs } : {}),
				...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
				...(typeof value.runEpoch === "number" ? { runEpoch: value.runEpoch } : {}),
			};
		default:
			return undefined;
	}
}
