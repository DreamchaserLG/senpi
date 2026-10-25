// senpi#4230: exercise the real engine role and owner pipe without a Windows VM.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareManagedLaunch } from "./managed-launch-process.ts";
import { SessionLaunchSupervisor } from "./session-launch-supervisor.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup() {
	const dir = await mkdtemp(join(tmpdir(), "managed-process-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	return {
		dir,
		command: {
			command: process.execPath,
			args: ["-e", 'process.stdout.write("ran"); process.exit(0)'],
			cwd: dir,
			env: process.env,
			logPath: join(dir, "command.log"),
		},
	};
}

describe.skipIf(process.platform === "win32")("managed foreground process on POSIX", () => {
	it("does not execute user code before containment admission releases it", async () => {
		const { command } = await setup();
		const held = await prepareManagedLaunch(command);
		cleanup.push(() => held.close());

		expect(await readFile(command.logPath, "utf8")).toBe("");
		await held.release();
		await expect(held.completed).resolves.toBe(0);
		expect(await readFile(command.logPath, "utf8")).toBe("ran");
	}, 15_000);

	it("keeps the foreground service alive after start returns and ends it on session close", async () => {
		const { dir, command } = await setup();
		const owner = new SessionLaunchSupervisor({ dir });
		cleanup.push(() => owner.close());
		const launch = await owner.start(
			{ ...command, args: ["-e", 'require("node:net").createServer().listen(0)'] },
			"service:fixture",
		);
		expect(() => process.kill(launch.pid, 0)).not.toThrow();

		await owner.close();

		await expect(launch.completed).resolves.not.toBe(0);
		expect(() => process.kill(launch.pid, 0)).toThrow();
	}, 15_000);
});
