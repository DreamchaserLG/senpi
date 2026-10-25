/**
 * Session ownership for explicit managed commands (senpi#4230). This is outside disposable tool-child generations.
 * Raw cp/Bun/PTY launches are NOT migrated: they still use their existing generation containment.
 */
import { join } from "node:path";
import { DescendantsLedger } from "./descendants.ts";
import { defaultGroupProbes, type GroupProbes, type LedgeredGroup, sweepGroups } from "./group-ownership.ts";
import { type HeldManagedLaunch, type ManagedCommand, prepareManagedLaunch } from "./managed-launch-process.ts";
import { type Kernel32Job, loadKernel32Job, WindowsJob } from "./windows-job.ts";

export class ManagedLaunchError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = "ManagedLaunchError";
		this.code = code;
	}
}

export interface ManagedLaunch {
	readonly id: string;
	readonly pid: number;
	readonly completed: Promise<number>;
}

interface LaunchOwner {
	readonly id: string;
	readonly callId: string;
	readonly held: HeldManagedLaunch;
	readonly job: WindowsJob | undefined;
	readonly group: LedgeredGroup;
	stopping?: Promise<void>;
}

export interface SessionLaunchOptions {
	readonly dir: string;
	readonly platform?: NodeJS.Platform;
	readonly kernel?: Kernel32Job;
	readonly groups?: GroupProbes;
	readonly prepare?: (command: ManagedCommand) => Promise<HeldManagedLaunch>;
}

export class SessionLaunchSupervisor {
	readonly #options: SessionLaunchOptions;
	readonly #ledger: DescendantsLedger;
	readonly #launches = new Map<string, LaunchOwner>();
	readonly #starting = new Set<Promise<ManagedLaunch>>();
	readonly #cancelledCalls = new Set<string>();
	readonly #groups: GroupProbes;
	readonly #platform: NodeJS.Platform;
	#sessionJob: WindowsJob | undefined;
	#kernel: Kernel32Job | undefined;
	#next = 0;
	#closed = false;
	#closing: Promise<void> | undefined;

	constructor(options: SessionLaunchOptions) {
		this.#options = options;
		this.#ledger = new DescendantsLedger(join(options.dir, "managed-launches.ledger"));
		this.#groups = options.groups ?? defaultGroupProbes;
		this.#platform = options.platform ?? process.platform;
	}

	start(command: ManagedCommand, callId: string): Promise<ManagedLaunch> {
		if (this.#closed)
			return Promise.reject(new ManagedLaunchError("managed_session_closed", "the session has ended"));
		const pending = this.#start(command, callId);
		this.#starting.add(pending);
		void pending.then(
			() => this.#starting.delete(pending),
			() => this.#starting.delete(pending),
		);
		return pending;
	}

	async #start(command: ManagedCommand, callId: string): Promise<ManagedLaunch> {
		const id = `managed-${++this.#next}`;
		const held = await (this.#options.prepare ?? prepareManagedLaunch)(command);
		let job: WindowsJob | undefined;
		let owner: LaunchOwner | undefined;
		try {
			this.#checkAdmission(callId);
			if (this.#platform === "win32") {
				this.#kernel ??= this.#options.kernel ?? loadKernel32Job();
				if (this.#kernel === undefined)
					throw new ManagedLaunchError("managed_launch_unsupported", "Windows managed launches require bun:ffi");
				this.#sessionJob ??= WindowsJob.create(this.#kernel);
				this.#sessionJob.assign(held.pid);
				job = WindowsJob.create(this.#kernel);
				job.assign(held.pid);
			}
			const leaderStart = this.#platform === "win32" ? undefined : await this.#groups.startOf(held.pid);
			const group: LedgeredGroup = { launchId: id, pgid: held.pid, leaderStart, lifetime: "owned" };
			owner = { id, callId, held, job, group };
			this.#launches.set(id, owner);
			await this.#ledger.append({
				launchId: id,
				generation: 0,
				origin: "tool",
				api: "cp.spawn",
				containment: this.#platform === "win32" ? "job" : "own-group",
				lifetime: "owned",
				pid: held.pid,
				pgid: held.pid,
				...(leaderStart === undefined ? {} : { leaderStart }),
				atMs: Date.now(),
			});
			this.#checkAdmission(callId);
			const pid = await held.release();
			this.#checkAdmission(callId);
			// Completion releases the caller's waiter, not the ownership of remaining descendants.
			return { id, pid, completed: held.completed };
		} catch (error) {
			if (owner !== undefined) await this.#stop(owner);
			else {
				job?.terminate();
				job?.close();
				await held.close();
			}
			throw error;
		}
	}

	#checkAdmission(callId: string): void {
		if (this.#closed) throw new ManagedLaunchError("managed_session_closed", "the session has ended");
		if (this.#cancelledCalls.has(callId))
			throw new ManagedLaunchError("managed_launch_cancelled", "the owning call was cancelled");
	}

	/** A service uses its own owner key, not the id of a client call that happens to use it. */
	async cancel(callId: string): Promise<void> {
		this.#cancelledCalls.add(callId);
		await Promise.all(
			[...this.#launches.values()].filter((entry) => entry.callId === callId).map((entry) => this.#stop(entry)),
		);
	}

	async stop(id: string): Promise<void> {
		const entry = this.#launches.get(id);
		if (entry !== undefined) await this.#stop(entry);
	}

	#stop(entry: LaunchOwner): Promise<void> {
		entry.stopping ??= (async () => {
			if (entry.job !== undefined) {
				entry.job.terminate();
				entry.job.close();
			} else {
				const outcomes = await sweepGroups([entry.group], { graceMs: 2_000, killWaitMs: 2_000 }, this.#groups);
				if (outcomes.some((outcome) => outcome.survived === true))
					throw new ManagedLaunchError("managed_launch_stop_failed", `${entry.id} still has group members`);
			}
			await entry.held.close();
			this.#launches.delete(entry.id);
		})();
		return entry.stopping;
	}

	close(): Promise<void> {
		this.#closed = true;
		this.#closing ??= (async () => {
			try {
				// Stop admitted starts before joining them: their startup acknowledgement may still be pending.
				await Promise.all([...this.#launches.values()].map((entry) => this.#stop(entry)));
				await Promise.allSettled([...this.#starting]);
				await Promise.all([...this.#launches.values()].map((entry) => this.#stop(entry)));
				await this.#ledger.remove();
			} finally {
				this.#sessionJob?.terminate();
				this.#sessionJob?.close();
			}
		})();
		return this.#closing;
	}
}
