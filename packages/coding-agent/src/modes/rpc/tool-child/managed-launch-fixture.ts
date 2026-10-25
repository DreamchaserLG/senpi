import type { GroupProbes } from "./group-ownership.ts";
import type { HeldManagedLaunch, ManagedCommand } from "./managed-launch-process.ts";
import type { Kernel32Job } from "./windows-job.ts";

/** Independent OS model: inheritance copies memberships; terminating a job/group kills all its members. */
export function managedLaunchFixture() {
	let nextPid = 100;
	let nextJob = 0;
	const processes = new Map<number, { alive: boolean; jobs: Set<number>; group: number }>();
	const jobs = new Map<number, { flags: number; parent?: number }>();
	const launches: Array<{
		readonly shim: number;
		target?: number;
		descendant?: number;
		readonly finish: (code: number) => void;
	}> = [];
	const spawn = (parent?: number): number => {
		const pid = ++nextPid;
		const inherited = parent === undefined ? undefined : processes.get(parent);
		processes.set(pid, { alive: true, jobs: new Set(inherited?.jobs), group: inherited?.group ?? pid });
		return pid;
	};
	const kill = (matches: (p: { jobs: Set<number>; group: number }) => boolean): void => {
		for (const process of processes.values()) if (matches(process)) process.alive = false;
	};
	const kernel: Kernel32Job = {
		CreateJobObjectW: () => {
			const handle = ++nextJob;
			jobs.set(handle, { flags: 0 });
			return handle;
		},
		SetInformationJobObject: (handle, _class, info) => {
			const job = jobs.get(Number(handle));
			if (job === undefined) return 0;
			job.flags = new DataView(info.buffer).getUint32(16, true);
			return 1;
		},
		OpenProcess: (_access, _inherit, pid) => `process:${pid}`,
		AssignProcessToJobObject: (handle, processHandle) => {
			const process = processes.get(Number(String(processHandle).slice(8)));
			const id = Number(handle);
			const job = jobs.get(id);
			if (process === undefined || job === undefined || !process.alive) return 0;
			const parent = [...process.jobs].at(-1);
			if (job.parent !== undefined && job.parent !== parent) return 0;
			if (parent !== undefined) job.parent = parent;
			process.jobs.add(id);
			return 1;
		},
		IsProcessInJob: (processHandle, job, result) => {
			const process = processes.get(Number(String(processHandle).slice(8)));
			new DataView(result.buffer).setUint32(0, process?.jobs.has(Number(job)) ? 1 : 0, true);
			return 1;
		},
		QueryInformationJobObject: (handle, _class, result) => {
			const pids = [...processes].filter(([, p]) => p.alive && p.jobs.has(Number(handle))).map(([pid]) => pid);
			const view = new DataView(result.buffer);
			view.setUint32(0, pids.length, true);
			view.setUint32(4, pids.length, true);
			pids.forEach((pid, index) => view.setBigUint64(8 + index * 8, BigInt(pid), true));
			return 1;
		},
		TerminateJobObject: (handle) => {
			kill((p) => p.jobs.has(Number(handle)));
			return 1;
		},
		CloseHandle: (handle) => {
			if (typeof handle === "number") {
				const job = jobs.get(handle);
				if (job !== undefined && (job.flags & 0x2000) !== 0) kill((p) => p.jobs.has(handle));
				jobs.delete(handle);
			}
			return 1;
		},
		GetLastError: () => 5,
		GetCurrentProcess: () => "process:1",
	};
	const groups: GroupProbes = {
		groupHasMembers: (group) => [...processes.values()].some((p) => p.alive && p.group === group),
		isAlive: (pid) => processes.get(pid)?.alive === true,
		startOf: async () => "Mon Oct 19 00:00:00 2026",
		ownGroup: async () => 1,
		signalGroup: (group) => kill((p) => p.group === group),
		wait: async () => {
			throw new Error("The fake OS terminates synchronously; polling would hide a broken stop.");
		},
	};
	const prepare = async (_command: ManagedCommand): Promise<HeldManagedLaunch> => {
		const shim = spawn();
		const completed = Promise.withResolvers<number>();
		const record: {
			readonly shim: number;
			readonly finish: (code: number) => void;
			target?: number;
			descendant?: number;
		} = { shim, finish: completed.resolve };
		launches.push(record);
		return {
			pid: shim,
			completed: completed.promise,
			release: async () => {
				record.target = spawn(shim);
				record.descendant = spawn(record.target);
				return record.target;
			},
			close: async () => {
				const process = processes.get(shim);
				if (process !== undefined) process.alive = false;
			},
		};
	};
	return {
		kernel,
		groups,
		prepare,
		launches,
		processes,
		jobs,
		alive: (pid: number | undefined) => pid !== undefined && processes.get(pid)?.alive === true,
	};
}
