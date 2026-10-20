/**
 * The supervisor leaves its caller's working directory before it does anything else (senpi#3783).
 * A supervisor and its host child outlive the `host ensure` that started them by hours; run from the
 * caller's directory they pin that checkout or worktree. Everything the caller meant relative to its
 * directory is resolved first, so the move changes no path the supervisor or its child reads.
 */
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { SupervisorLaunch } from "./host-lifecycle-launch.ts";

const PATH_VALUED_HOST_FLAGS = new Set([
	"--extension",
	"-e",
	"--skill",
	"--prompt-template",
	"--theme",
	"--session-dir",
]);

const absoluteFrom = (from: string, path: string): string => (isAbsolute(path) ? path : resolve(from, path));

/** A value is rewritten only when it names an existing path, so a package spec or a theme name passes through. */
function absoluteHostArgs(hostArgs: readonly string[], from: string): string[] {
	return hostArgs.map((arg, index) => {
		if (index === 0 || !PATH_VALUED_HOST_FLAGS.has(hostArgs[index - 1]) || isAbsolute(arg)) return arg;
		const candidate = resolve(from, arg);
		return existsSync(candidate) ? candidate : arg;
	});
}

/** Changes the process cwd to `agentDir` (created if missing); the result names it, so the host child is told it. */
export function anchorSupervisorCwd(
	launch: SupervisorLaunch,
	agentDir: string,
): SupervisorLaunch & { readonly agentDir: string } {
	const from = process.cwd();
	const anchoredAgentDir = absoluteFrom(from, agentDir);
	const anchored = {
		...launch,
		socket: absoluteFrom(from, launch.socket),
		hostArgs: absoluteHostArgs(launch.hostArgs, from),
		agentDir: anchoredAgentDir,
		...(launch.bindSocket !== undefined ? { bindSocket: absoluteFrom(from, launch.bindSocket) } : {}),
	};
	mkdirSync(anchoredAgentDir, { recursive: true });
	process.chdir(anchoredAgentDir);
	return anchored;
}
