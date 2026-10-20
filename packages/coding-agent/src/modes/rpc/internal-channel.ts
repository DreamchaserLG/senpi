import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { createInternalRecordStream } from "./internal-record-stream.ts";

type Frame = Record<string, unknown>;
const HEX = /^[0-9a-f]{64}$/;

function proof(key: Buffer, label: string, first: string, second: string): string {
	return createHmac("sha256", key).update(`${label}\ninternal\n${first}\n${second}`).digest("hex");
}
function matches(actual: unknown, expected: string): boolean {
	return (
		typeof actual === "string" &&
		HEX.test(actual) &&
		timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"))
	);
}
function object(value: unknown): Frame {
	if (!isObject(value)) throw new Error("auth_failed");
	return value;
}
function isObject(value: unknown): value is Frame {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonce(value: unknown): string {
	if (typeof value !== "string" || !HEX.test(value)) throw new Error("auth_failed");
	return value;
}

/** Shared 8 KiB / 2 s budget, including fragmented frames and bytes coalesced after authentication. */
async function handshake<T>(
	socket: Socket,
	run: (read: () => Promise<Frame>, send: (frame: Frame) => Promise<void>) => Promise<T>,
): Promise<T> {
	let readBytes = 0;
	let ended = false;
	let rejectPending: ((cause: Error) => void) | undefined;
	const fail = (error: Error) => {
		ended = true;
		rejectPending?.(error);
		socket.destroy();
	};
	const timer = setTimeout(() => fail(new Error("internal_auth_timeout")), 2000);
	timer.unref();
	const onError = (error: Error) => fail(error);
	const onClose = () => fail(new Error("internal_hop_lost"));
	socket.on("error", onError);
	socket.once("close", onClose);
	const read = (): Promise<Frame> =>
		new Promise((resolve, reject) => {
			if (ended) return reject(new Error("internal_hop_lost"));
			let buffer = Buffer.alloc(0);
			rejectPending = (cause) => {
				socket.off("data", data);
				reject(cause);
			};
			const data = (chunk: Buffer) => {
				const newline = chunk.indexOf(10);
				const used = newline === -1 ? chunk.length : newline + 1;
				readBytes += used;
				if (readBytes > 8192) return fail(new Error("internal_auth_oversized"));
				buffer = Buffer.concat([buffer, chunk.subarray(0, used)]);
				if (newline === -1) return;
				socket.pause();
				socket.off("data", data);
				rejectPending = undefined;
				if (used < chunk.length) socket.unshift(chunk.subarray(used));
				try {
					resolve(object(JSON.parse(buffer.toString("utf8"))));
				} catch {
					reject(new Error("auth_failed"));
				}
			};
			socket.on("data", data);
			socket.resume();
		});
	try {
		return await run(
			read,
			(frame) =>
				new Promise<void>((resolve, reject) => {
					socket.write(`${JSON.stringify(frame)}\n`, (error) => (error ? reject(error) : resolve()));
				}),
		);
	} catch (cause) {
		socket.destroy();
		throw cause;
	} finally {
		clearTimeout(timer);
		socket.off("error", onError);
		socket.off("close", onClose);
	}
}

export function connectInternalConnection(socket: Socket, key: Buffer): Promise<Duplex> {
	return handshake(socket, async (read, send) => {
		const clientNonce = randomBytes(32).toString("hex");
		const [response] = await Promise.all([
			read(),
			send({
				id: "internal-protocol",
				type: "get_protocol_info",
				observe: true,
				auth: { client_nonce: clientNonce },
			}),
		]);
		const auth = object(object(response.data).auth);
		const serverNonce = nonce(auth.server_nonce);
		if (
			response.id !== "internal-protocol" ||
			response.success !== true ||
			auth.launch_id !== "internal" ||
			!matches(auth.server_proof, proof(key, "senpi-rpc-server", clientNonce, serverNonce))
		)
			throw new Error("host_identity_unproven");
		const [result] = await Promise.all([
			read(),
			send({
				id: "internal-auth",
				type: "authenticate",
				client_proof: proof(key, "senpi-rpc-client", serverNonce, clientNonce),
			}),
		]);
		if (result.id !== "internal-auth" || result.command !== "authenticate" || result.success !== true)
			throw new Error("auth_failed");
		return createInternalRecordStream(
			socket,
			key,
			Buffer.from(clientNonce, "hex"),
			Buffer.from(serverNonce, "hex"),
			"client",
		);
	});
}

export function acceptInternalConnection(socket: Socket, key: Buffer, protocol: Frame = {}): Promise<Duplex> {
	return handshake(socket, async (read, send) => {
		const first = await read();
		if (first.type !== "get_protocol_info") {
			await send({
				id: first.id,
				type: "response",
				command: first.type,
				success: false,
				error: "auth_required",
				errorCode: "auth_required",
			});
			throw new Error("auth_required");
		}
		const clientNonce = nonce(object(first.auth).client_nonce);
		const serverNonce = randomBytes(32).toString("hex");
		const [frame] = await Promise.all([
			read(),
			send({
				id: first.id,
				type: "response",
				command: first.type,
				success: true,
				data: {
					...protocol,
					capabilities: [...(Array.isArray(protocol.capabilities) ? protocol.capabilities : []), "socket_auth"],
					auth: {
						launch_id: "internal",
						server_nonce: serverNonce,
						server_proof: proof(key, "senpi-rpc-server", clientNonce, serverNonce),
					},
				},
			}),
		]);
		const valid =
			frame.type === "authenticate" &&
			matches(frame.client_proof, proof(key, "senpi-rpc-client", serverNonce, clientNonce));
		await send({
			id: frame.id,
			type: "response",
			command: "authenticate",
			success: valid,
			...(valid ? {} : { error: "auth_failed", errorCode: "auth_failed" }),
		});
		if (!valid) throw new Error("auth_failed");
		return createInternalRecordStream(
			socket,
			key,
			Buffer.from(clientNonce, "hex"),
			Buffer.from(serverNonce, "hex"),
			"server",
		);
	});
}
