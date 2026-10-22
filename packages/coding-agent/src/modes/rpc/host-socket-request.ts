/**
 * One request over a shared RPC socket, answered by the line carrying its id. A leaf on purpose: the lifecycle
 * supervisor asks the endpoint who answers it (`host-supersession`), and its import graph has a module budget
 * (`test/supervisor-import-graph.test.ts`), so this file must not reach the protocol-info parser or anything
 * behind it. `host-probe` builds the typed questions on top of it.
 */
import { createConnection, type Socket } from "node:net";
import {
	readSocketSecret,
	resolveSocketTransportAddress,
	sendSocketHandshake,
	socketSecretPath,
} from "./socket-transport.ts";
import { socketNeedsHandshake } from "./tui-socket.ts";

export const PROBE_REQUEST_ID = "ensure-host-probe";

/** One probe's outcome: whether the socket accepted a connection, and the answer if one arrived. */
export interface ProbeOutcome {
	readonly connected: boolean;
	readonly answer: unknown;
	/** The answering connection, left open, when the caller asked to keep it. */
	readonly kept?: Socket;
}

/** Sends one command and returns its `data`, or `undefined` for any failure to get a usable answer. */
export async function requestOnSocket(
	socketPath: string,
	command: Readonly<Record<string, unknown>>,
	timeoutMs: number,
): Promise<unknown> {
	return (await connectAndAsk(socketPath, { id: PROBE_REQUEST_ID, ...command }, timeoutMs)).answer;
}

export async function connectAndAsk(
	socketPath: string,
	request: Readonly<Record<string, unknown>>,
	timeoutMs: number,
	keep = false,
): Promise<ProbeOutcome> {
	let secret: Buffer | undefined;
	if (socketNeedsHandshake(socketPath)) {
		try {
			secret = await readSocketSecret(socketSecretPath(socketPath));
		} catch {
			return { connected: false, answer: undefined };
		}
	}
	return new Promise((resolveProbe) => {
		const socket = createConnection(resolveSocketTransportAddress(socketPath, process.platform, secret));
		let buffer = "";
		let settled = false;
		let connected = false;
		const finish = (value?: unknown): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (keep && value !== undefined && !socket.destroyed) {
				resolveProbe({ connected, answer: value, kept: socket });
				return;
			}
			socket.destroy();
			resolveProbe({ connected, answer: value });
		};
		const timeout = setTimeout(() => finish(), timeoutMs);
		socket.once("connect", () => {
			connected = true;
			socket.write(`${JSON.stringify(request)}\n`);
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) return;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				// A host broadcasts lifecycle records to every connection, so the reply to THIS
				// request is the line carrying its id - not simply the first line that arrives.
				const answer = readAnswer(line);
				if (answer !== undefined) return finish(answer);
			}
		});
		socket.once("error", () => finish());
		socket.once("close", () => finish());
		// Register the error listener before sending the Windows named-pipe handshake.
		// When an idle host has already removed its pipe, the handshake write can
		// surface ENOENT immediately; without the listener this probe escapes instead
		// of becoming the expected "no existing host" result for the next ensure.
		if (secret) sendSocketHandshake(socket, secret);
	});
}

export function readAnswer(text: string, id: string = PROBE_REQUEST_ID): unknown {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || parsed.id !== id || parsed.success !== true) return undefined;
	return parsed.data ?? {};
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
