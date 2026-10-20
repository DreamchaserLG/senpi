import { afterEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ identity: undefined as string | undefined, fail: false, calls: 0 }));
vi.mock("../../src/utils/process-identity.ts", async (original) => ({
	...(await original<typeof import("../../src/utils/process-identity.ts")>()),
	readProcessStartTime: async () => {
		probe.calls++;
		if (probe.fail) throw new Error("identity unavailable");
		return probe.identity;
	},
}));

import { armHostWatchdog, readHostWatchdogConfig } from "../../src/modes/rpc/host-watchdog.ts";

const start = "Tue Oct 20 10:00:00 2026";
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	probe.identity = undefined;
	probe.fail = false;
	probe.calls = 0;
});

// senpi#3795 v7.1: wrappers change ppid, never the recorded supervisor identity.
describe("recorded supervisor lifetime", () => {
	it("does not arm slot three for a supervised POSIX child", () => {
		const config = readHostWatchdogConfig({
			SENPI_RPC_HOST_WATCH_FD: "3",
			SENPI_RPC_HOST_WATCH_PPID: "4242",
			SENPI_RPC_HOST_WATCH_PSTART: start,
		});
		expect(config?.fd).toBe(process.platform === "win32" ? 3 : undefined);
		expect(config?.processStartTime).toBe(start);
	});

	it.each(["wrapper", "missing", "unreadable", "permission"] as const)(
		"keeps a live supervisor up with %s identity",
		async (kind) => {
			vi.useFakeTimers();
			vi.spyOn(process, "kill").mockImplementation(() => {
				if (kind === "permission") throw Object.assign(new Error("denied"), { code: "EPERM" });
				return true;
			});
			probe.identity = kind === "wrapper" ? start : undefined;
			probe.fail = kind === "unreadable";
			const fired = vi.fn();
			const stop = armHostWatchdog({ ppid: 4242, processStartTime: start }, fired);
			try {
				await vi.advanceTimersByTimeAsync(1000);
				expect(fired).not.toHaveBeenCalled();
			} finally {
				stop();
			}
		},
	);

	it.each(["ESRCH", "reuse"] as const)("ends the host on confirmed %s", async (kind) => {
		vi.useFakeTimers();
		vi.spyOn(process, "kill").mockImplementation(() => {
			if (kind === "ESRCH") throw Object.assign(new Error("gone"), { code: "ESRCH" });
			return true;
		});
		probe.identity = "Tue Oct 20 11:00:00 2026";
		const fired = vi.fn();
		const stop = armHostWatchdog({ ppid: 4242, processStartTime: start }, fired);
		try {
			await vi.advanceTimersByTimeAsync(1000);
			expect(fired).toHaveBeenCalledTimes(1);
		} finally {
			stop();
		}
	});
});
