import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { terminateProcessTrees } from "../../../../senpi-codemode/src/kernels/js/process-tree-host.ts";
import { hermeticProviderEnv } from "../../helpers/rpc-hermetic.ts";

// Regression coverage for https://github.com/code-yeongyu/senpi/issues/3783
function processCwd(pid: number): string {
	if (process.platform === "linux") return readlinkSync(`/proc/${pid}/cwd`);
	const fields = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
	const name = fields.split("\n").find((line) => line.startsWith("n"));
	if (name === undefined) throw new Error(`no cwd reported for ${pid}`);
	return name.slice(1);
}

describe.skipIf(process.platform === "win32")("RPC host supervisor cwd", () => {
	const created: string[] = [];
	afterEach(() => {
		for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("leaves the caller's directory for its agent dir and spawns the host child there", async () => {
		const root = mkdtempSync(join(tmpdir(), "rpc3783-"));
		created.push(root);
		const caller = join(root, "caller-worktree");
		mkdirSync(caller);
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		const socketPath = join(root, "rpc.sock");
		const childCwdReport = join(root, "child-cwd");
		const tsx = import.meta.resolve("tsx");
		const env: NodeJS.ProcessEnv = {
			...process.env,
			...hermeticProviderEnv(),
			PI_OFFLINE: "1",
			OMO_CODING_AGENT_DIR: agentDir,
			SENPI_CODING_AGENT_DIR: agentDir,
			SENPI_RPC_HOST_COLD_START: "persistent",
		};
		delete env.OMO_RPC_SOCKET_PATH;
		delete env.SENPI_RPC_SOCKET_PATH;
		const supervisor = spawn(
			process.execPath,
			[
				"--import",
				tsx,
				resolve(import.meta.dirname, "../../../src/modes/rpc/host-lifecycle.ts"),
				"--socket",
				socketPath,
				"--agent-dir",
				agentDir,
				"--child-command",
				process.execPath,
				"--child-args",
				JSON.stringify([
					"--import",
					tsx,
					resolve(import.meta.dirname, "../../fixtures/rpc-cwd-reporting-child.ts"),
					childCwdReport,
				]),
			],
			{ cwd: caller, env, stdio: ["ignore", "ignore", "pipe"] },
		);
		const exited = once(supervisor, "exit");
		const stderr = createInterface({ input: supervisor.stderr });
		const ready = (async () => {
			let output = "";
			for await (const line of stderr) {
				output = `${output}${line}\n`.slice(-16_000);
				if (line.includes("senpi rpc host ready on ")) return;
			}
			throw new Error(`supervisor exited before readiness:\n${output}`);
		})();
		try {
			await ready;
			const expected = realpathSync(agentDir);
			if (supervisor.pid === undefined) throw new Error("supervisor has no pid");
			expect(realpathSync(processCwd(supervisor.pid))).toBe(expected);
			expect(realpathSync(readFileSync(childCwdReport, "utf8"))).toBe(expected);
		} finally {
			try {
				if (supervisor.pid !== undefined) {
					await terminateProcessTrees([supervisor.pid], { ownerPid: process.pid, graceMs: 1000 });
				}
				await exited;
			} finally {
				stderr.close();
			}
		}
	}, 45_000);
});
