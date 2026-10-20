/**
 * Opt-in supervisor-lifetime watchdog for the RPC socket host.
 *
 * A host started under the `host-lifecycle.ts` supervisor must not outlive it.
 * Catchable signals cannot carry that guarantee: `kill -9`, an OOM kill, or a
 * crashed supervisor run no JS handler, and the host is then reparented to init
 * as a permanent orphan holding its private socket forever.
 *
 * POSIX children watch the reopened stdin key pipe, or poll the recorded supervisor's
 * pid and start time when reopening is unavailable. Slot three is not trusted after
 * wrappers/re-exec. Windows and explicit embedding callers retain their fd binding.
 *
 * The bindings are unset for every other host launch, so nothing changes for
 * plain `senpi --mode rpc` runs, hosts started by hand, or embedders.
 */
import { rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { Socket } from "node:net";
import { envValue } from "../../core/brand.ts";
import { processStartTimeMs, readProcessStartTime } from "../../utils/process-identity.ts";
import { recordHostCrash } from "./host-crash-record.ts";
import { HOST_DAEMON_DIR_ENV } from "./host-daemon-paths.ts";
import { HOST_INSTANCE_ID_ENV } from "./host-identity-env.ts";
import { watchHostLifetime } from "./host-lifetime-reader.ts";

/** Inherited fd whose EOF means "the supervisor died"; set by the supervisor only. */
export const HOST_WATCH_FD_ENV = "SENPI_RPC_HOST_WATCH_FD";
/** Supervisor-owned private directory the host removes on watchdog shutdown. */
export const HOST_SCRATCH_DIR_ENV = "SENPI_RPC_HOST_SCRATCH_DIR";
/** Public socket path the supervisor bound; the host removes it ownership-checked. */
export const HOST_PUBLIC_SOCKET_ENV = "SENPI_RPC_HOST_PUBLIC_SOCKET";
/** Fallback binding when no inherited fd is available: poll this pid. */
export const HOST_WATCH_PPID_ENV = "SENPI_RPC_HOST_WATCH_PPID";
export const HOST_WATCH_PSTART_ENV = "SENPI_RPC_HOST_WATCH_PSTART";
/** Poll cadence for the ppid fallback. */
export const HOST_WATCH_PPID_INTERVAL_MS = 250;
export const HOST_CLEANUP_PATHS_ENV = "SENPI_RPC_HOST_CLEANUP_PATHS";

export interface HostWatchdogConfig {
	readonly fd?: number;
	readonly ppid?: number;
	readonly processStartTime?: string;
	readonly lifetimeFd?: number;
	readonly scratchDir?: string;
	readonly cleanupPaths?: readonly string[];
	readonly publicSocket?: string;
	/** Where the WATCHDOG record of this generation goes when the supervisor vanishes (senpi#2566). */
	readonly daemonDir?: string;
	readonly instanceId?: string;
	/**
	 * Runs when the watchdog fires, BEFORE `scratchDir` and `cleanupPaths` are removed. The
	 * host uses it to read state that lives inside the supervisor's private directory and
	 * that its shutdown still needs - the public-socket ownership token above all. A
	 * supervisor killed while the host is still starting up leaves that token unread, and
	 * removing the directory first would turn the public socket into an unprovable orphan.
	 */
	readonly beforeCleanup?: () => Promise<void>;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
	const parsed = Number(value.trim());
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Reads the watchdog configuration from the environment. Returns `undefined`
 * when neither binding is requested, which is the case for every host launch
 * that does not come from the lifecycle supervisor.
 */
export function readHostWatchdogConfig(
	env: Readonly<Record<string, string | undefined>> = process.env,
): HostWatchdogConfig | undefined {
	const ppid = parsePositiveInteger(env[HOST_WATCH_PPID_ENV]);
	// Slot three may have been closed/reused by a launcher. POSIX supervised children never arm it.
	const fd =
		process.platform !== "win32" && ppid !== undefined ? undefined : parsePositiveInteger(env[HOST_WATCH_FD_ENV]);
	if (fd === undefined && ppid === undefined) return undefined;
	const scratchDir = env[HOST_SCRATCH_DIR_ENV];
	const cleanupPaths = env[HOST_CLEANUP_PATHS_ENV]?.split("\n").filter(Boolean);
	const publicSocket = env[HOST_PUBLIC_SOCKET_ENV];
	const daemonDir = env[HOST_DAEMON_DIR_ENV];
	const instanceId = env[HOST_INSTANCE_ID_ENV];
	return {
		fd,
		ppid,
		...(env[HOST_WATCH_PSTART_ENV] ? { processStartTime: env[HOST_WATCH_PSTART_ENV] } : {}),
		scratchDir: scratchDir === undefined || scratchDir === "" ? undefined : scratchDir,
		cleanupPaths,
		publicSocket: publicSocket === "" ? undefined : publicSocket,
		...(daemonDir && instanceId ? { daemonDir, instanceId } : {}),
	};
}

/** Same configuration, resolved through the brand-aware env prefixes. */
export function readHostWatchdogConfigFromBrandEnv(): HostWatchdogConfig | undefined {
	// The lifecycle supervisor intentionally uses the canonical SENPI_RPC_HOST_*
	// names when spawning a child. envValue() resolves branded aliases for normal
	// launches, but must not hide the canonical variables from the supervisor
	// handoff or the lifetime binding is silently disabled.
	return readHostWatchdogConfig({
		[HOST_WATCH_FD_ENV]: process.env[HOST_WATCH_FD_ENV] ?? envValue("RPC_HOST_WATCH_FD"),
		[HOST_WATCH_PPID_ENV]: process.env[HOST_WATCH_PPID_ENV] ?? envValue("RPC_HOST_WATCH_PPID"),
		[HOST_WATCH_PSTART_ENV]: process.env[HOST_WATCH_PSTART_ENV] ?? envValue("RPC_HOST_WATCH_PSTART"),
		[HOST_SCRATCH_DIR_ENV]: process.env[HOST_SCRATCH_DIR_ENV] ?? envValue("RPC_HOST_SCRATCH_DIR"),
		[HOST_PUBLIC_SOCKET_ENV]: process.env[HOST_PUBLIC_SOCKET_ENV] ?? envValue("RPC_HOST_PUBLIC_SOCKET"),
		[HOST_CLEANUP_PATHS_ENV]: process.env[HOST_CLEANUP_PATHS_ENV] ?? envValue("RPC_HOST_CLEANUP_PATHS"),
		[HOST_DAEMON_DIR_ENV]: process.env[HOST_DAEMON_DIR_ENV],
		[HOST_INSTANCE_ID_ENV]: process.env[HOST_INSTANCE_ID_ENV],
	});
}

/**
 * Arms the configured watchdog. `onSupervisorGone` receives the reason and is
 * expected to perform the host's normal clean shutdown; the scratch directory
 * (the supervisor's private socket directory, which no longer has an owner) is
 * removed first so nothing is left behind even if shutdown then hangs.
 *
 * Takes ownership of `config.fd`: disarming (or firing) closes it, so callers
 * must not close it themselves. Returns a disarm function; a no-op when no
 * binding is configured.
 */
export function armHostWatchdog(
	config: HostWatchdogConfig | undefined,
	onSupervisorGone: (reason: string, cleanup?: Promise<void>) => void,
): () => void {
	if (!config) return () => {};
	let stopped = false;
	let fired = false;
	const fire = (reason: string): void => {
		if (stopped || fired) return;
		fired = true;
		disarm();
		// First, before any cleanup: a supervisor that died this way runs no exit handler of its own.
		if (config.daemonDir !== undefined && config.instanceId !== undefined) {
			recordHostCrash(config.daemonDir, {
				at: new Date().toISOString(),
				uptimeMs: Math.round(process.uptime() * 1000),
				kind: "rpc-host-watchdog",
				generation: config.instanceId,
				reason,
			});
		}
		const captured = captureBeforeCleanup(config);
		if (process.platform === "win32") {
			// Arm the host shutdown fallback before attempting metadata cleanup. The
			// synchronous Win32 removal below handles the state files deterministically,
			// while the fallback still covers a named-pipe close that never completes.
			const cleanup = captured.then(() => cleanupWatchdogPaths(config));
			onSupervisorGone(reason, cleanup);
		} else {
			void captured.then(() => cleanupWatchdogPaths(config)).finally(() => onSupervisorGone(reason));
		}
	};
	const disarmers: Array<() => void> = [];
	const disarm = (): void => {
		stopped = true;
		for (const stop of disarmers.splice(0)) stop();
	};
	let polling = false;
	const fallback = (): void => {
		if (stopped || polling || config.ppid === undefined) return;
		polling = true;
		disarmers.push(watchPpid(config.ppid, config.processStartTime, fire));
	};
	if (config.lifetimeFd !== undefined) {
		try {
			disarmers.push(watchHostLifetime(config.lifetimeFd, () => fire("supervisor stdin lifetime closed"), fallback));
		} catch {
			fallback();
		}
	} else fallback();
	if (config.fd !== undefined) disarmers.push(watchFdForEof(config.fd, fire));
	return disarm;
}

/**
 * EOF on the inherited pipe is the primary signal. The supervisor never writes
 * to it, so any readable data is ignored; only close matters. An fd that cannot
 * be opened (never inherited) leaves the binding inert rather than killing a
 * healthy host.
 *
 * The pipe is read through a net.Socket rather than a file stream because the read has to live
 * on the EVENT LOOP, not in libuv's thread pool. A thread-pool read blocks in `read(2)` until the
 * supervisor dies, and `process.exit()` joins the thread pool before it terminates - so a host
 * that decides to exit on its own (an idle exit, or the park-everything drain of a generation
 * handoff) would hang in exit until something killed it. With a socket the same EOF arrives from
 * kqueue/epoll and nothing holds the exit.
 */
function watchFdForEof(fd: number, fire: (reason: string) => void): () => void {
	let stream: Socket;
	let streamFailed = false;
	let fired = false;
	const fireOnce = (reason: string): void => {
		if (fired) return;
		fired = true;
		fire(reason);
	};
	try {
		// The watchdog owns this inherited read end; destroying the socket releases it.
		stream = new Socket({ fd, readable: true, writable: false });
	} catch {
		return () => {};
	}
	stream.resume();
	const onEnd = (): void => fireOnce(`supervisor pipe fd ${fd} closed`);
	const onClose = (): void => {
		if (!streamFailed) onEnd();
	};
	const onError = (): void => {
		streamFailed = true;
	};
	stream.once("end", onEnd);
	// Win32 pipe teardown may report close without end; POSIX invalid-fd close is
	// not supervisor death and remains inert.
	if (process.platform === "win32") stream.once("close", onClose);
	stream.once("error", onError);
	return () => {
		stream.off("end", onEnd);
		stream.off("close", onClose);
		stream.off("error", onError);
		stream.destroy();
	};
}

/**
 * Poll only the recorded supervisor, never process.ppid (a wrapper may be the parent).
 * An absent pid or observed start-time mismatch is death; every observation error is unknown.
 */
function watchPpid(
	supervisorPid: number,
	recordedStart: string | undefined,
	fire: (reason: string) => void,
): () => void {
	// Tests and embedders may bind the watchdog to this process itself; that
	// is a valid live binding rather than evidence of supervisor loss.
	if (supervisorPid === process.pid) return () => {};
	let stopped = false;
	let probing = false;
	const timer = setInterval(() => {
		if (probing || stopped) return;
		probing = true;
		void (async () => {
			try {
				if (!processAlive(supervisorPid)) {
					if (!stopped) fire(`supervisor pid ${supervisorPid} is gone`);
					return;
				}
				if (!recordedStart) return;
				const observed = await readProcessStartTime(supervisorPid, process.platform, 1000);
				const recordedMs = processStartTimeMs(recordedStart);
				const observedMs = observed === undefined ? undefined : processStartTimeMs(observed);
				if (!stopped && recordedMs !== undefined && observedMs !== undefined && recordedMs !== observedMs)
					fire(`supervisor pid ${supervisorPid} start time changed`);
			} catch {
				// Permission, timeout and unreadable/missing start time are unknown, never death.
			} finally {
				probing = false;
			}
		})();
	}, HOST_WATCH_PPID_INTERVAL_MS);
	timer.unref?.();
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		return !(cause instanceof Error && "code" in cause && cause.code === "ESRCH");
	}
}

// A failing capture must never block the cleanup or the shutdown it precedes.
function captureBeforeCleanup(config: HostWatchdogConfig): Promise<void> {
	if (config.beforeCleanup === undefined) return Promise.resolve();
	return Promise.resolve()
		.then(config.beforeCleanup)
		.catch(() => undefined);
}

/**
 * Removes the cleanup paths one at a time, in list order, on every platform: the supervisor puts
 * the registration pointer last (host-cleanup-paths.ts), and it must not vanish before the state
 * it describes (senpi#2241).
 */
export async function cleanupWatchdogPaths(config: HostWatchdogConfig): Promise<void> {
	const paths = [...(config.cleanupPaths ?? []), ...(config.scratchDir ? [config.scratchDir] : [])];
	for (const path of paths) {
		try {
			if (process.platform === "win32")
				rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			else await rm(path, { recursive: true, force: true });
		} catch {}
	}
}
