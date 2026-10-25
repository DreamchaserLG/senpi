// senpi#4230: managed launches, not legacy raw cp/Bun/PTY launches.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { managedLaunchFixture } from "./managed-launch-fixture.ts";
import type { HeldManagedLaunch } from "./managed-launch-process.ts";
import { SessionLaunchSupervisor } from "./session-launch-supervisor.ts";

const directories: string[] = [];
const supervisors: SessionLaunchSupervisor[] = [];
afterEach(async () => {
	await Promise.all(supervisors.splice(0).map((owner) => owner.close()));
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(platform: "win32" | "darwin") {
	const dir = await mkdtemp(join(tmpdir(), "managed-launch-"));
	directories.push(dir);
	const os = managedLaunchFixture();
	const owner = new SessionLaunchSupervisor({
		dir,
		platform,
		kernel: os.kernel,
		groups: os.groups,
		prepare: os.prepare,
	});
	supervisors.push(owner);
	const start = (callId: string) =>
		owner.start({ command: "foreground-fixture", args: [], cwd: dir, env: {}, logPath: join(dir, callId) }, callId);
	return { os, owner, start };
}

describe.each(["win32", "darwin"] as const)("managed session containment on %s", (platform) => {
	it("cancels one call's tree without ending a sibling or a registered service", async () => {
		const { os, owner, start } = await setup(platform);
		await start("call-a");
		await start("call-b");
		await start("service:browser");

		await owner.cancel("call-a");

		expect(os.launches.map((launch) => os.alive(launch.descendant))).toEqual([false, true, true]);
	});

	it("retains a foreground service after its starting call returns", async () => {
		const { os, start } = await setup(platform);
		await start("service:browser");

		expect(os.alive(os.launches[0]?.target)).toBe(true);
		expect(os.alive(os.launches[0]?.descendant)).toBe(true);
	});

	it("retains owned descendants after normal command completion", async () => {
		const { os, start } = await setup(platform);
		const command = await start("call-a");
		os.launches[0]?.finish(0);

		await expect(command.completed).resolves.toBe(0);

		expect(os.alive(os.launches[0]?.descendant)).toBe(true);
	});

	it("ends every owned tree when the session ends", async () => {
		const { os, owner, start } = await setup(platform);
		await start("call-a");
		await start("service:browser");

		await owner.close();

		expect([...os.processes.values()].some((process) => process.alive)).toBe(false);
		expect(os.jobs.size).toBe(0);
	});

	it("refuses new execution after the session has closed", async () => {
		const { os, owner, start } = await setup(platform);
		await owner.close();

		await expect(start("late-call")).rejects.toMatchObject({ code: "managed_session_closed" });

		expect(os.launches).toHaveLength(0);
	});

	it("puts user code inside its launch containment before releasing it", async () => {
		const { os, start } = await setup(platform);
		await start("call-a");
		await start("call-b");
		const targets = os.launches.map((launch) => os.processes.get(launch.target ?? -1));
		if (platform === "win32") {
			expect(targets.map((p) => p?.jobs.size)).toEqual([2, 2]);
			const first = targets[0]?.jobs ?? new Set<number>();
			const second = targets[1]?.jobs ?? new Set<number>();
			expect([...first].filter((job) => second.has(job))).toHaveLength(1);
		} else {
			expect(targets.map((p) => p?.group)).toEqual(os.launches.map((launch) => launch.shim));
		}
	});

	it("does not release a launch whose call was cancelled during preparation", async () => {
		const { os, owner, start } = await setup(platform);
		await owner.cancel("cancelled-before-start");

		await expect(start("cancelled-before-start")).rejects.toMatchObject({ code: "managed_launch_cancelled" });

		expect(os.launches.every((launch) => launch.target === undefined)).toBe(true);
	});

	it("joins a pending preparation on session close without releasing user code", async () => {
		const { os } = await setup(platform);
		const dir = directories.at(-1);
		if (dir === undefined) throw new Error("fixture directory missing");
		const prepared = Promise.withResolvers<HeldManagedLaunch>();
		const owner = new SessionLaunchSupervisor({
			dir: join(dir, "pending"),
			platform,
			kernel: os.kernel,
			groups: os.groups,
			prepare: () => prepared.promise,
		});
		supervisors.push(owner);
		const command = { command: "fixture", args: [], cwd: dir, env: {}, logPath: join(dir, "pending.log") };
		const pending = owner.start(command, "late");
		const rejected = expect(pending).rejects.toMatchObject({ code: "managed_session_closed" });

		const closed = owner.close();
		prepared.resolve(await os.prepare(command));
		await closed;
		await rejected;

		expect(os.launches.every((launch) => launch.target === undefined)).toBe(true);
		expect([...os.processes.values()].some((process) => process.alive)).toBe(false);
	});
});
