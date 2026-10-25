// senpi#4230: service ownership is independent of the tool call that requested it.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { managedLaunchFixture } from "./managed-launch-fixture.ts";
import { SessionLaunchSupervisor } from "./session-launch-supervisor.ts";
import { SessionServicePool, SessionServices } from "./session-services.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(platform: "win32" | "darwin") {
	const dir = await mkdtemp(join(tmpdir(), "session-services-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const os = managedLaunchFixture();
	const pool = new SessionServicePool();
	const session = (name: string) => {
		const owner = new SessionLaunchSupervisor({
			dir: join(dir, name),
			platform,
			kernel: os.kernel,
			groups: os.groups,
			prepare: os.prepare,
		});
		const services = new SessionServices(owner, pool);
		cleanup.push(() => services.close());
		return { owner, services };
	};
	const command = {
		command: "bsk",
		args: ["daemon", "start", "--foreground"],
		cwd: dir,
		env: { BSK_AUTO_START: "0" },
		logPath: join(dir, "browser.log"),
	};
	return { os, session, command };
}

describe.each(["win32", "darwin"] as const)("foreground services on %s", (platform) => {
	it("keeps the registered foreground service after the tool returns and stops it at session end", async () => {
		const { os, session, command } = await setup(platform);
		const { owner, services } = session("one");
		const result = await services.ensure("browser", { command, probe: async () => "missing" });
		expect(result.ownership).toBe("session");
		expect(os.alive(os.launches[0]?.target)).toBe(true);
		await owner.cancel("unrelated-client-call");
		expect(os.alive(os.launches[0]?.target)).toBe(true);

		await services.close();

		expect(os.alive(os.launches[0]?.descendant)).toBe(false);
	});

	it("reuses a pre-existing external daemon without enrolling or killing it", async () => {
		const { os, session, command } = await setup(platform);
		const { services } = session("one");
		const external = await os.prepare(command);
		const pid = await external.release();
		const result = await services.ensure("browser", { command, probe: async () => "available" });
		expect(result.ownership).toBe("external");
		expect(os.launches).toHaveLength(1);
		expect(os.processes.get(pid)?.jobs.size).toBe(0);

		await services.close();

		expect(os.alive(pid)).toBe(true);
		await external.close();
	});

	it("keeps a shared owned service until the final session releases its lease", async () => {
		const { os, session, command } = await setup(platform);
		const first = session("one").services;
		const second = session("two").services;
		await first.ensure("browser", { command, probe: async () => "missing" });
		await second.ensure("browser", { command, probe: async () => "available" });
		await first.close();
		expect(os.alive(os.launches[0]?.target)).toBe(true);

		await second.close();

		expect(os.launches).toHaveLength(1);
		expect(os.alive(os.launches[0]?.descendant)).toBe(false);
	});

	it("shares concurrent startup instead of launching a second daemon", async () => {
		const { os, session, command } = await setup(platform);
		const first = session("one").services;
		const second = session("two").services;
		const probe = Promise.withResolvers<"missing">();
		const firstResult = first.ensure("browser", { command, probe: () => probe.promise });
		const secondResult = second.ensure("browser", { command, probe: async () => "missing" });

		probe.resolve("missing");
		const [a, b] = await Promise.all([firstResult, secondResult]);

		expect(a).toEqual(b);
		expect(os.launches).toHaveLength(1);
	});

	it("shares a verified endpoint across different workspace directories", async () => {
		const { os, session, command } = await setup(platform);
		const first = session("one").services;
		const second = session("two").services;
		await first.ensure("browser", { command, probe: async () => "missing" });
		await second.ensure("browser", {
			command: { ...command, cwd: join(command.cwd, "another-workspace") },
			probe: async () => "available",
		});
		await first.close();
		expect(os.alive(os.launches[0]?.target)).toBe(true);
		await second.close();
		expect(os.alive(os.launches[0]?.target)).toBe(false);
	});

	it("does not release an existing lease when a conflicting ensure lacks identity proof", async () => {
		const { os, session, command } = await setup(platform);
		const { services } = session("one");
		await services.ensure("browser", { command, probe: async () => "missing" });

		await expect(
			services.ensure("browser", {
				command: { ...command, cwd: join(command.cwd, "another-workspace") },
				probe: async () => "missing",
			}),
		).rejects.toMatchObject({ code: "managed_service_conflict" });

		expect(os.alive(os.launches[0]?.target)).toBe(true);
	});

	it("preserves a probe failure instead of treating it as permission to start", async () => {
		const { os, session, command } = await setup(platform);
		const { services } = session("one");
		const native = Object.assign(new Error("fixture IPC permission denied"), { code: "EACCES" });

		await expect(
			services.ensure("browser", {
				command,
				probe: async () => {
					throw native;
				},
			}),
		).rejects.toBe(native);

		expect(os.launches).toHaveLength(0);
	});

	it("does not start a service after its session closes during a probe", async () => {
		const { os, session, command } = await setup(platform);
		const { services } = session("one");
		const probe = Promise.withResolvers<"missing">();
		const pending = services.ensure("browser", { command, probe: () => probe.promise });
		const rejected = expect(pending).rejects.toMatchObject({ code: "managed_launch_cancelled" });

		const closing = services.close();
		probe.resolve("missing");
		await closing;
		await rejected;

		expect(os.launches).toHaveLength(0);
	});

	it("rechecks a borrowed endpoint rather than reporting a stale daemon as available", async () => {
		const { os, session, command } = await setup(platform);
		const { services } = session("one");
		await services.ensure("browser", { command, probe: async () => "available" });

		await expect(services.ensure("browser", { command, probe: async () => "missing" })).rejects.toMatchObject({
			code: "managed_external_service_unavailable",
		});

		expect(os.launches).toHaveLength(0);
	});
});
