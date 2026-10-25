import { spawn } from "node:child_process";
import { Socket } from "node:net";
import { createInterface } from "node:readline";
import { withoutInternalEnv } from "./launch-env-names.ts";
import { managedCommandSchema } from "./managed-launch-wire.ts";

/**
 * A managed launch's POSIX supervisor. It stays alive after the command returns so host-pipe EOF still reaps
 * descendants. Windows also keeps this pipe, while the session-owned Job Object supplies crash cleanup.
 */
export async function runManagedLaunchRole(): Promise<never> {
	const control = new Socket({ fd: 3, readable: true, writable: true });
	const stop = (): never => {
		if (process.platform !== "win32") process.kill(-process.pid, "SIGKILL");
		process.exit(0);
	};
	control.once("end", stop);
	control.once("error", stop);
	control.once("close", stop);
	const lines = createInterface({ input: control });
	lines.once("line", (line) => {
		try {
			const command = managedCommandSchema.parse(JSON.parse(line));
			const child = spawn(command.command, command.args, {
				cwd: command.cwd,
				env: withoutInternalEnv(command.env),
				stdio: ["ignore", "inherit", "inherit"],
				detached: false,
				windowsHide: true,
			});
			child.once("spawn", () => control.write(`${JSON.stringify({ type: "started", pid: child.pid })}\n`));
			child.once("error", (error) =>
				control.write(`${JSON.stringify({ type: "error", message: error.message })}\n`),
			);
			child.once("exit", (exitCode) =>
				control.write(`${JSON.stringify({ type: "completed", exitCode: exitCode ?? 1 })}\n`),
			);
		} catch (error) {
			control.write(
				`${JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) })}\n`,
			);
		}
	});
	return new Promise<never>(() => {});
}
