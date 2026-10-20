import { createServer } from "node:net";
import type { RpcConnectionSink } from "./connection-handler.ts";
import type { ClientOccupancy } from "./host-client-occupancy.ts";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS } from "./jsonl.ts";
import { PublicRpcConnection } from "./rpc-public-auth.ts";
import type { RpcPublicEndpoint } from "./rpc-public-key.ts";
import type { SessionCommandRouter } from "./session-command-router.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";
import { socketSink } from "./socket-sink.ts";
import { authenticateSocket } from "./socket-transport.ts";

export interface HostSocketConnection {
	readonly id: string;
	readonly sink: RpcConnectionSink;
	readonly detach: () => void;
	readonly close: () => void;
}

/** One socket's framing, auth gate, writer registration, and attachment release. */
export function createHostSocketServer(options: {
	readonly endpoint: RpcPublicEndpoint | undefined;
	readonly secret: Uint8Array | undefined;
	readonly accepting: () => boolean;
	readonly writer: SessionEventWriter;
	readonly router: SessionCommandRouter;
	readonly handle: (line: string) => Promise<void>;
	readonly occupancy: ClientOccupancy;
	readonly connections: Map<string, HostSocketConnection>;
}) {
	const { writer, router, occupancy, connections } = options;
	let nextConnection = 0;
	return createServer((socket) => {
		const auth = options.endpoint ? new PublicRpcConnection(socket, options.endpoint) : undefined;
		const accept = (): void => {
			if (!options.accepting()) {
				socket.destroy();
				return;
			}
			const id = `socket-${++nextConnection}`;
			const transport = socketSink(socket);
			const sink = auth
				? { ...transport, writeRaw: (chunk: string) => transport.writeRaw(auth.response(chunk)) }
				: transport;
			writer.registerConnection(id, sink);
			occupancy.admit(socket);
			const report = (cause: unknown) =>
				process.stderr.write(
					`senpi rpc connection ${id} failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
				);
			const detachReader = attachJsonlLineReader(
				auth?.input ?? socket,
				(line) => {
					// Re-entrant extension_ui_response must resolve an already awaiting command.
					void writer.withConnection(id, () => options.handle(line)).catch(report);
				},
				{
					maxLineLength: MAX_RPC_LINE_CHARACTERS,
					onOversizedLine: () => {
						void writer
							.withConnection(id, () =>
								writer.enqueueControl({
									type: "response",
									command: "parse",
									success: false,
									error: `RPC input line exceeds ${MAX_RPC_LINE_CHARACTERS} characters.`,
								}),
							)
							.catch(report);
					},
				},
			);
			let detached = false;
			const detach = () => {
				if (detached) return;
				detached = true;
				detachReader();
				writer.unregisterConnection(id);
				connections.delete(id);
				occupancy.release(socket);
				// Release on the command chain, after in-flight work, even without close_session.
				void router.releaseConnection(id).catch((cause) => {
					process.stderr.write(
						`senpi rpc connection ${id} release failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
					);
				});
			};
			connections.set(id, { id, sink, detach, close: () => socket.destroy() });
			socket.once("close", detach);
			socket.once("error", detach);
		};
		if (options.secret) authenticateSocket(socket, options.secret, accept);
		else accept();
	});
}
