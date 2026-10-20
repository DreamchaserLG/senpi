import { type ChildProcess, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";
import { hermeticProviderEnv } from "../helpers/rpc-hermetic.ts";
import { killAndWait, reapProcessesUnder } from "../helpers/spawned-host-reaper.ts";

export type Wire = Record<string, unknown>;
export type LaunchPath = "bare" | "direct" | "ensured";
export const cli = join(import.meta.dirname, "../../src/cli.ts");

export async function sandbox() {
	const root = await mkdtemp(join(tmpdir(), "ra-"));
	const agentDir = join(root, "a");
	await mkdir(agentDir, { mode: 0o700 });
	return { root, agentDir, socket: join(root, "s") };
}

export async function launchHost(qa: Awaited<ReturnType<typeof sandbox>>, path: LaunchPath, strict = true) {
	const args =
		path === "bare"
			? ["--mode", "rpc", "--listen", qa.socket]
			: path === "direct"
				? ["--internal-rpc-host-supervisor", "--socket", qa.socket, "--agent-dir", qa.agentDir]
				: ["host", "ensure", "--socket", qa.socket, "--json"];
	const child = spawn(process.execPath, [cli, ...args], {
		cwd: qa.root,
		env: {
			...process.env,
			...hermeticProviderEnv(),
			SENPI_RUNTIME: "node",
			SENPI_CODING_AGENT_DIR: qa.agentDir,
			SENPI_RPC_REQUIRE_TOKEN: strict ? "1" : "0",
			SENPI_RPC_HOST_IDLE_EXIT_MS: "60000",
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	let stdout = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => finish(new Error(`host startup: ${stderr} ${stdout}`)), 30000);
		const onData = () => {
			if (
				stderr.includes(path === "bare" ? "senpi rpc listening on" : "senpi rpc host ready") ||
				(path === "ensured" && stdout.includes('"action"'))
			)
				finish();
		};
		const onExit = () => finish(new Error(`host exited: ${stderr} ${stdout}`));
		const finish = (error?: Error) => {
			clearTimeout(timeout);
			child.stderr?.off("data", onData);
			child.stdout?.off("data", onData);
			child.off("exit", onExit);
			if (error) reject(error);
			else resolve();
		};
		child.stderr?.on("data", onData);
		child.stdout?.on("data", onData);
		child.once("exit", onExit);
	});
	return { child, stderr: () => stderr };
}

export class Peer {
	readonly records: Wire[] = [];
	private readonly notifications = new Set<() => void>();
	readonly closed: Promise<unknown>;
	constructor(readonly socket: Socket) {
		this.closed = new Promise((resolve) => socket.once("close", resolve));
		socket.on("error", () => {});
		attachJsonlLineReader(socket, (line) => {
			this.records.push(JSON.parse(line));
			for (const notify of this.notifications) notify();
		});
	}
	static async connect(path: string) {
		const socket = createConnection(path);
		const peer = new Peer(socket);
		await once(socket, "connect");
		return peer;
	}
	async request(value: Wire) {
		const answer = this.waitFor((record) => record.id === value.id);
		this.socket.write(`${JSON.stringify(value)}\n`);
		return answer;
	}
	waitFor(predicate: (value: Wire) => boolean): Promise<Wire> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => finish(undefined), 5000);
			const notify = () => {
				const found = this.records.find(predicate);
				if (found) finish(found);
			};
			const finish = (found: Wire | undefined) => {
				clearTimeout(timer);
				this.notifications.delete(notify);
				if (found) resolve(found);
				else reject(new Error(`missing response: ${JSON.stringify(this.records)}`));
			};
			this.notifications.add(notify);
			notify();
		});
	}
}

export function proof(key: Buffer, domain: string, ...parts: string[]): string {
	return createHmac("sha256", key)
		.update([domain, ...parts].join("\n"))
		.digest("hex");
}

export async function challenge(peer: Peer) {
	const nonce = randomBytes(32).toString("hex");
	const reply = await peer.request({
		type: "get_protocol_info",
		id: "protocol",
		observe: true,
		auth: { client_nonce: nonce },
	});
	const auth = (reply.data as Wire | undefined)?.auth;
	if (typeof auth !== "object" || auth === null) throw new Error("host did not offer authentication");
	return { nonce, auth: auth as { launch_id: string; server_nonce: string; server_proof: string } };
}

export async function authenticate(peer: Peer, agentDir: string) {
	const { nonce, auth } = await challenge(peer);
	const record = JSON.parse(await readFile(join(agentDir, "rpc", "keys", auth.launch_id), "utf8"));
	const key = Buffer.from(record.key, "hex");
	if (auth.server_proof !== proof(key, "senpi-rpc-server", auth.launch_id, nonce, auth.server_nonce))
		throw new Error("invalid server proof");
	return peer.request({
		type: "authenticate",
		id: "authenticate",
		client_proof: proof(key, "senpi-rpc-client", auth.launch_id, auth.server_nonce, nonce),
	});
}

export async function teardown(root: string, child?: ChildProcess) {
	if (child) await killAndWait(child);
	await reapProcessesUnder(root);
	await rm(root, { recursive: true, force: true });
}
