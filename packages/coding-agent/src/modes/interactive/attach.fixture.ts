import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachJsonlLineReader, serializeJsonLine } from "../rpc/jsonl.ts";
import { authenticateSocket, createSocketSecret, resolveSocketTransportAddress } from "../rpc/socket-transport.ts";

export async function endpoint() {
	const directory = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "attach-"));
	const path = join(directory, "t-0123456789abcdef.sock");
	const secret = await createSocketSecret(`${path}.secret`);
	const commands: Array<Record<string, unknown>> = [];
	let peer: Socket | undefined;
	const server = createServer((socket) => {
		peer = socket;
		authenticateSocket(socket, secret, () => {
			attachJsonlLineReader(socket, (line) => {
				const command: Record<string, unknown> = JSON.parse(line);
				commands.push(command);
				let data: unknown;
				switch (command.type) {
					case "list_sessions":
						data = {
							sessions: [{ sessionId: "live", durableSessionId: "durable", cwd: "/fixture", status: "open" }],
						};
						break;
					case "attach_session":
						data = { sessionId: "live", attached: true };
						break;
					case "get_state":
						data = { sessionId: "durable", cwd: "/fixture", isStreaming: false, pendingDialogs: [] };
						break;
					case "get_entries":
						data = {
							entries: [
								{
									type: "message",
									id: "history",
									parentId: null,
									timestamp: "2026-01-01",
									message: { role: "user", content: "Previous question", timestamp: 1 },
								},
							],
							leafId: "history",
							next_before: command.before ? undefined : "history",
						};
						break;
					case "subscribe_sessions":
						data = {
							subscriptionId: "sub",
							snapshot: [],
							seq: 0,
							hostGeneration: "fixture",
							hostInstanceId: "fixture",
						};
						break;
					case "release_attachment":
						data = { deferred: false };
						break;
					case "extension_ui_response":
						server.emit("command", command);
						return;
					default:
						data = {};
				}
				socket.write(
					serializeJsonLine({ type: "response", id: command.id, command: command.type, success: true, data }),
				);
				server.emit("command", command);
			});
		});
	});
	const listening = once(server, "listening");
	server.listen(resolveSocketTransportAddress(path, process.platform, secret));
	await listening;
	const close = async () => {
		peer?.destroy();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		await rm(directory, { recursive: true, force: true });
	};
	return {
		close,
		path,
		commands,
		send: (record: object) => peer?.write(serializeJsonLine({ sessionId: "live", ...record })),
		disconnect: () => peer?.destroy(),
		async command(type: string) {
			const signal = AbortSignal.timeout(5000);
			for (;;) {
				const found = commands.find((record) => record.type === type);
				if (found) return found;
				await once(server, "command", { signal });
			}
		},
	};
}
