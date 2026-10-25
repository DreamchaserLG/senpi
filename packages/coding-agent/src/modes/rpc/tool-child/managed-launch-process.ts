import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { Socket } from "node:net";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { TOOL_CHILD_ROLE_ENV } from "./channel.ts";
import { toolChildCommand } from "./launch.ts";
import { withoutInternalEnv } from "./launch-env-names.ts";
import { type ManagedCommand, managedLaunchReply } from "./managed-launch-wire.ts";

export type { ManagedCommand } from "./managed-launch-wire.ts";

export interface HeldManagedLaunch {
	readonly pid: number;
	readonly completed: Promise<number>;
	/** Only called after the session has durably enrolled this shim in its launch containment. */
	release(): Promise<number>;
	close(): Promise<void>;
}

/** The engine shim runs no user code until the owner writes its command on fd 3. */
export async function prepareManagedLaunch(command: ManagedCommand): Promise<HeldManagedLaunch> {
	const reentry = await toolChildCommand();
	await mkdir(dirname(command.logPath), { recursive: true, mode: 0o700 });
	const log = await open(command.logPath, "a", 0o600);
	const child = spawn(reentry.command, [...reentry.args], {
		cwd: command.cwd,
		env: { ...withoutInternalEnv(process.env), [TOOL_CHILD_ROLE_ENV]: "managed-launch" },
		stdio: ["ignore", log.fd, log.fd, "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	});
	const started = Promise.withResolvers<number>();
	const completed = Promise.withResolvers<number>();
	const exited = Promise.withResolvers<void>();
	// The start promise can reject before release (for example ENOENT). Its caller still receives the same rejection.
	void started.promise.catch(() => undefined);
	child.once("error", (error) => {
		started.reject(error);
		completed.resolve(1);
		exited.resolve();
	});
	child.once("exit", (code) => {
		started.reject(new Error(`managed launch shim exited before starting the command (${code})`));
		completed.resolve(code ?? 1);
		exited.resolve();
	});
	await log.close();
	const control = child.stdio[3];
	if (child.pid === undefined || !(control instanceof Socket)) {
		if (child.pid !== undefined) child.kill();
		await exited.promise;
		throw new Error("managed launch shim has no process or control pipe");
	}
	const lines = createInterface({ input: control });
	lines.on("line", (line) => {
		try {
			const reply = managedLaunchReply.parse(JSON.parse(line));
			switch (reply.type) {
				case "started":
					started.resolve(reply.pid);
					break;
				case "completed":
					completed.resolve(reply.exitCode);
					break;
				case "error":
					started.reject(new Error(reply.message));
					completed.resolve(1);
					break;
			}
		} catch (error) {
			started.reject(error);
			completed.resolve(1);
			control.destroy();
		}
	});
	control.on("error", (error) => started.reject(error));
	return {
		pid: child.pid,
		completed: completed.promise,
		release: () => {
			control.write(`${JSON.stringify(command)}\n`);
			return started.promise;
		},
		close: async () => {
			control.destroy();
			await exited.promise;
			lines.close();
		},
	};
}
