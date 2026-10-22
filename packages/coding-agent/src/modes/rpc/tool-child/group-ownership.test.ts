// senpi#3566 todo 4: the ledger's group rule (senpi#3020) decides which process groups a teardown may signal.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { readProcessStartTime } from "../../../utils/process-identity.ts";
import {
	classifyGroup,
	defaultGroupProbes,
	type GroupProbes,
	type LedgeredGroup,
	sweepGroups,
} from "./group-ownership.ts";

const START = "Sat Oct 18 05:00:00 2026";
const owned = (pgid: number, leaderStart: string | undefined = START): LedgeredGroup => ({
	launchId: `l${pgid}`,
	pgid,
	leaderStart,
	lifetime: "owned",
});

function fakeProbes(state: { members: Set<number>; alive: Set<number>; starts: Map<number, string> }) {
	const signals: Array<[number, NodeJS.Signals]> = [];
	const probes: GroupProbes = {
		groupHasMembers: (pgid) => state.members.has(pgid),
		isAlive: (pid) => state.alive.has(pid),
		startOf: async (pid) => state.starts.get(pid),
		ownGroup: async () => 1000,
		signalGroup: (pgid, signal) => {
			signals.push([pgid, signal]);
			if (signal === "SIGKILL" || pgid !== 77) state.members.delete(pgid);
		},
		wait: async () => {},
	};
	return { probes, signals };
}

describe("classifyGroup", () => {
	const state = {
		members: new Set([10, 11, 12, 1000]),
		alive: new Set([10, 12]),
		starts: new Map([
			[10, START],
			[12, "Sat Oct 18 06:30:00 2026"],
		]),
	};
	const { probes } = fakeProbes(state);

	it.each([
		["a live leader with the recorded start", owned(10), "sweep"],
		["an exited leader whose group still has members", owned(11), "sweep"],
		["a leader pid reused by another process", owned(12), "leader-reused"],
		["a group with no members", owned(13), "empty"],
		["the server's own group", owned(1000), "own-group"],
		["a detached entry", { ...owned(10), lifetime: "detached" as const }, "detached"],
	])("%s -> %s", async (_label, group, verdict) => {
		expect(await classifyGroup(group, 1000, probes)).toBe(verdict);
	});

	it("signals nothing when the server's own group is unknown", async () => {
		expect(await classifyGroup(owned(10), undefined, probes)).toBe("own-group");
	});
});

describe("sweepGroups", () => {
	it("TERMs swept groups, KILLs the ones that ignore TERM, and never signals released or detached groups", async () => {
		const state = {
			members: new Set([10, 12, 77]),
			alive: new Set([10, 12, 77]),
			starts: new Map([
				[10, START],
				[12, "x"],
				[77, START],
			]),
		};
		const { probes, signals } = fakeProbes(state);
		const outcomes = await sweepGroups(
			[owned(10), owned(12), owned(77), { ...owned(10), launchId: "d", lifetime: "detached" }],
			{ graceMs: 50, killWaitMs: 50, pollMs: 10 },
			probes,
		);
		expect(signals).toEqual([
			[10, "SIGTERM"],
			[77, "SIGTERM"],
			[77, "SIGKILL"],
		]);
		expect(outcomes.map((o) => [o.launchId, o.verdict, o.survived])).toEqual([
			["l10", "sweep", false],
			["l12", "leader-reused", undefined],
			["l77", "sweep", false],
			["d", "detached", undefined],
		]);
	});
});

describe.skipIf(process.platform === "win32")("sweepGroups on real process groups", () => {
	async function groupWithExitedLeader() {
		// The leader backgrounds a sleep (same group) and then blocks on stdin until the test lets it exit.
		const leader = spawn("sh", ["-c", "sleep 300 & read _"], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
		const pgid = leader.pid ?? -1;
		const leaderStart = await readProcessStartTime(pgid);
		const exited = once(leader, "exit");
		leader.stdin?.end();
		await exited;
		return { pgid, leaderStart };
	}

	it("kills an owned group whose leader already exited", async () => {
		const { pgid, leaderStart } = await groupWithExitedLeader();
		expect(defaultGroupProbes.groupHasMembers(pgid)).toBe(true);
		const [outcome] = await sweepGroups([{ launchId: "g", pgid, leaderStart, lifetime: "owned" }], {
			graceMs: 3_000,
			killWaitMs: 3_000,
		});
		expect(outcome).toMatchObject({ verdict: "sweep", survived: false });
		expect(defaultGroupProbes.groupHasMembers(pgid)).toBe(false);
	}, 20_000);

	it("leaves a detached group running", async () => {
		const { pgid, leaderStart } = await groupWithExitedLeader();
		try {
			const [outcome] = await sweepGroups([{ launchId: "g", pgid, leaderStart, lifetime: "detached" }], {
				graceMs: 100,
				killWaitMs: 100,
			});
			expect(outcome?.verdict).toBe("detached");
			expect(defaultGroupProbes.groupHasMembers(pgid)).toBe(true);
		} finally {
			defaultGroupProbes.signalGroup(pgid, "SIGKILL");
		}
	}, 20_000);
});
