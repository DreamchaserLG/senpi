import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { getAgentDir } from "../../config.ts";
import { ORIGIN_HOST_INSTANCE_FIELD, originHostInstance } from "./host-observe-request.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import {
	authRecord,
	RPC_AUTH_HEX,
	RPC_LAUNCH_ID,
	RpcEndpointAuthError,
	rpcAuthProof,
	rpcProofMatches,
} from "./rpc-auth-proof.ts";
import { readRpcKeyRecord } from "./rpc-public-key.ts";
import { SOCKET_HANDSHAKE_TIMEOUT_MS } from "./socket-transport.ts";

export interface RpcKeyOptions {
	/** Credential lookup only; never selects the session's configuration profile. */
	readonly keyRoot?: string;
}

const keyRoots = new AsyncLocalStorage<string>();
export function withRpcKeyRoot<T>(root: string, operation: () => T): T {
	return keyRoots.run(root, operation);
}

export function rpcKeyRoot(options: RpcKeyOptions = {}, defaultRoot?: string): string {
	return options.keyRoot ?? keyRoots.getStore() ?? process.env.SENPI_RPC_KEY_ROOT ?? defaultRoot ?? getAgentDir();
}

/** A fresh connection per attempt, including the single refresh after a host's auth_failed. */
export async function connectAuthenticatedRpcSocket(
	path: string,
	first: Readonly<Record<string, unknown>> = {
		type: "get_protocol_info",
		id: "rpc-auth-protocol",
		observe: true,
		[ORIGIN_HOST_INSTANCE_FIELD]: originHostInstance(),
	},
	options: RpcKeyOptions = {},
	timeoutMs = SOCKET_HANDSHAKE_TIMEOUT_MS,
): Promise<{ readonly socket: Socket; readonly protocol: Readonly<Record<string, unknown>> }> {
	const deadline = Date.now() + timeoutMs;
	for (let attempt = 0; ; attempt++) {
		const socket = createConnection(path);
		let connected = false;
		socket.once("connect", () => {
			connected = true;
		});
		// Install error/close handlers before any write, including connect failures.
		try {
			const protocol = await authenticate(
				socket,
				path,
				first,
				rpcKeyRoot(options),
				Math.max(1, deadline - Date.now()),
			);
			return { socket, protocol };
		} catch (cause) {
			socket.destroy();
			if (attempt === 0 && cause instanceof RpcEndpointAuthError && cause.code === "auth_failed") continue;
			if (cause instanceof Error) Object.assign(cause, { rpcSocketConnected: connected });
			throw cause;
		}
	}
}

async function authenticate(
	socket: Socket,
	path: string,
	first: Readonly<Record<string, unknown>>,
	root: string,
	timeoutMs: number,
): Promise<Readonly<Record<string, unknown>>> {
	let pending:
		| {
				readonly id: unknown;
				readonly resolve: (value: Readonly<Record<string, unknown>>) => void;
				readonly reject: (error: Error) => void;
		  }
		| undefined;
	const reject = (error: Error) => pending?.reject(error);
	const onClose = () => reject(new Error(`RPC socket closed during authentication: ${path}`));
	const onError = (error: Error) => reject(error);
	socket.on("error", onError);
	socket.on("close", onClose);
	const detach = attachJsonlLineReader(
		socket,
		(line) => {
			let response: Readonly<Record<string, unknown>> | undefined;
			try {
				response = authRecord(JSON.parse(line));
			} catch {
				return;
			}
			if (response?.type !== "response" || response.id !== pending?.id) return;
			if (response.success === true) pending?.resolve(response);
			else {
				const code = response.errorCode;
				reject(
					code === "auth_failed" || code === "auth_required"
						? new RpcEndpointAuthError(code, `${path}; set SENPI_RPC_KEY_ROOT to the host's agent dir (${root})`)
						: new Error(`RPC authentication probe refused on ${path}: ${String(response.error)}`),
				);
			}
		},
		{ maxLineLength: 1024 * 1024, onOversizedLine: () => socket.destroy() },
	);
	const exchange = (request: Readonly<Record<string, unknown>>) =>
		new Promise<Readonly<Record<string, unknown>>>((resolve, reject) => {
			if (socket.destroyed) {
				reject(new Error(`RPC socket closed during authentication: ${path}`));
				return;
			}
			pending = { id: request.id, resolve, reject };
			// net.Socket queues this write until connect, preserving the caller's own first frame.
			socket.write(serializeJsonLine(request));
		});
	const timer = setTimeout(() => {
		reject(new Error(`RPC authentication timed out on ${path}`));
		socket.destroy();
	}, timeoutMs);
	try {
		const nonce = randomBytes(32).toString("hex");
		const response = await exchange({ ...first, auth: { client_nonce: nonce } });
		const data = authRecord(response.data);
		if (data?.auth === undefined) return response;
		const auth = authRecord(data.auth);
		if (
			typeof auth?.launch_id !== "string" ||
			!RPC_LAUNCH_ID.test(auth.launch_id) ||
			typeof auth.server_nonce !== "string" ||
			!RPC_AUTH_HEX.test(auth.server_nonce)
		)
			throw new RpcEndpointAuthError("host_identity_unproven", path);
		const record = await readRpcKeyRecord(root, auth.launch_id);
		if (socket.destroyed) throw new Error(`RPC authentication timed out on ${path}`);
		if (record === undefined) {
			process.stderr.write(
				`senpi rpc client: no key record for launch ${auth.launch_id} under ${root}; continuing unauthenticated (refused from the next release; set SENPI_RPC_KEY_ROOT to the host's agent dir)\n`,
			);
			return response;
		}
		// readRpcKeyRecord validates this field at the file boundary.
		if (typeof record.key !== "string") throw new RpcEndpointAuthError("unsafe_key_record", root);
		const key = Buffer.from(record.key, "hex");
		if (!rpcProofMatches(rpcAuthProof(key, "server", auth.launch_id, nonce, auth.server_nonce), auth.server_proof))
			throw new RpcEndpointAuthError("host_identity_unproven", path);
		await exchange({
			id: "rpc-authenticate",
			type: "authenticate",
			client_proof: rpcAuthProof(key, "client", auth.launch_id, auth.server_nonce, nonce),
		});
		return response;
	} finally {
		clearTimeout(timer);
		detach();
		socket.off("error", onError);
		socket.off("close", onClose);
	}
}
