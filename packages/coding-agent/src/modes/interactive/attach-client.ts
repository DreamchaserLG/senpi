import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent } from "../json-event.ts";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS, serializeJsonLine } from "../rpc/jsonl.ts";
import { connectRpcClientSocket } from "../rpc/rpc-client-socket.ts";
import { requestDeadlineMs } from "../rpc/rpc-request-deadline.ts";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcQuestionResolvedEvent,
	RpcQuestionUpdatedEvent,
	RpcResponse,
	RpcSessionStatusEvent,
} from "../rpc/rpc-types.ts";

export type AttachRecord = (
	| Exclude<JsonAgentSessionEvent, { type: "message_update" }>
	| (Extract<JsonAgentSessionEvent, { type: "message_update" }> & { readonly message?: AssistantMessage | null })
	| RpcExtensionUIRequest
	| RpcSessionStatusEvent
	| RpcQuestionResolvedEvent
	| RpcQuestionUpdatedEvent
) & { readonly sessionId?: string; readonly entryId?: string };
type Answer = Extract<RpcResponse, { success: true }>;

/** A presentation-only socket client: it cannot spawn or fall back to an in-process runtime. */
export class AttachClient {
	private socket: Socket | undefined;
	private stopReading: (() => void) | undefined;
	private readonly pending = new Map<string, { resolve: (answer: Answer) => void; reject: (error: Error) => void }>();
	private closed = false;
	private readonly onRecord: (record: AttachRecord) => void;
	private readonly onDisconnect: () => void;

	constructor(onRecord: (record: AttachRecord) => void, onDisconnect: () => void) {
		this.onRecord = onRecord;
		this.onDisconnect = onDisconnect;
	}

	async connect(path: string): Promise<void> {
		const socket = await connectRpcClientSocket(path, {});
		this.socket = socket;
		this.stopReading = attachJsonlLineReader(
			socket,
			(line) => {
				const record: RpcResponse | AttachRecord = JSON.parse(line);
				if (record.type === "response") {
					const pending = record.id ? this.pending.get(record.id) : undefined;
					if (!pending) return;
					if (record.id) this.pending.delete(record.id);
					if (record.success) pending.resolve(record);
					else pending.reject(new Error(record.error));
				} else {
					this.onRecord(record);
				}
			},
			{
				maxLineLength: MAX_RPC_LINE_CHARACTERS,
				onOversizedLine: () => socket.destroy(new Error("RPC record exceeds the line limit")),
			},
		);
		socket.once("error", () => socket.destroy());
		socket.once("close", () => {
			this.socket = undefined;
			this.rejectPending();
			if (!this.closed) this.onDisconnect();
		});
	}

	request(command: RpcCommand & { readonly observe?: boolean }): Promise<Answer> {
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`No acknowledgement for ${command.type}; its outcome is unknown`));
			}, requestDeadlineMs(command));
			this.pending.set(id, {
				resolve: (answer) => {
					clearTimeout(timer);
					resolve(answer);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			try {
				this.write({ ...command, id });
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error);
			}
		});
	}

	answer(sessionId: string, response: RpcExtensionUIResponse): void {
		this.write({ ...response, sessionId, answerId: randomUUID() });
	}

	close(): void {
		this.closed = true;
		this.stopReading?.();
		this.socket?.destroy();
		this.socket = undefined;
		this.rejectPending();
	}

	private write(record: object): void {
		if (!this.socket?.writable || this.socket.destroyed) throw new Error("Disconnected");
		this.socket.write(serializeJsonLine(record));
	}

	private rejectPending(): void {
		for (const request of this.pending.values())
			request.reject(new Error("Disconnected; pending command outcome is unknown"));
		this.pending.clear();
	}
}
