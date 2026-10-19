import { serializeJsonLine } from "./jsonl.ts";

export const EVENT_RESYNC_CAPABILITY = "event_resync";
export type ResyncReason = "overflow" | "stall";
export type RpcSessionResyncRequired = {
	readonly type: "resync_required";
	readonly sessionId: string;
	readonly reason: ResyncReason;
	readonly message: unknown;
	readonly closed?: true;
};

export function isCorrelatedReply(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "response" &&
		"id" in value &&
		typeof value.id === "string"
	);
}

class SocketPeerLivenessError extends Error {
	constructor() {
		super("socket peer missed its liveness ping");
		this.name = "SocketPeerLivenessError";
	}
}

/** One gap and one outstanding ping, regardless of how many events the producer emits. */
export class SocketPeerRecovery {
	private reason: ResyncReason | undefined;
	private awaitingPing = false;
	private pingBuffered = false;
	private replyLost = false;
	private readonly write: (line: string) => void;
	private readonly snapshot: (reason: ResyncReason) => () => readonly object[];
	private readSnapshot: (() => readonly object[]) | undefined;

	constructor(write: (line: string) => void, snapshot: (reason: ResyncReason) => () => readonly object[]) {
		this.write = write;
		this.snapshot = snapshot;
		// Negotiate the heartbeat before session traffic can fill the output side.
		// Pulses travel client -> host even while host -> client is backpressured.
		this.pingBuffered = true;
		this.write(serializeJsonLine({ type: "rpc_ping" }));
	}

	get pending(): boolean {
		return this.reason !== undefined;
	}

	shed(reason: ResyncReason): void {
		if (this.reason !== undefined) return;
		this.reason = reason;
		this.readSnapshot = this.snapshot(reason);
	}

	/** A fresh set_client_info is the existing connection-scoped acknowledgement. */
	acknowledge(): void {
		this.awaitingPing = false;
	}

	loseReply(): void {
		this.replyLost = true;
	}

	ping(): void {
		if (this.awaitingPing) throw new SocketPeerLivenessError();
		this.awaitingPing = true;
		if (!this.pingBuffered) {
			this.pingBuffered = true;
			this.write(serializeJsonLine({ type: "rpc_ping" }));
		}
	}

	takeSnapshot(): readonly object[] {
		const reason = this.reason;
		this.reason = undefined;
		this.awaitingPing = false;
		this.pingBuffered = false;
		const snapshot = this.readSnapshot;
		this.readSnapshot = undefined;
		const gap = reason === undefined ? [] : [{ type: "resync_required", reason, replyLost: this.replyLost }];
		this.replyLost = false;
		return [...gap, ...(snapshot?.() ?? [])];
	}
}
