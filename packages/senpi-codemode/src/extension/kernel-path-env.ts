import { win32 } from "node:path";
import { getShellConfig, withBundledBunCommands } from "@code-yeongyu/senpi";

export interface KernelPathEnvOptions {
	readonly platform?: NodeJS.Platform;
	readonly env?: NodeJS.ProcessEnv;
	/** Resolves the Git Bash `bash.exe` the bash tool would use; undefined when there is none. */
	readonly resolveGitBash?: () => string | undefined;
	readonly withBundledBun?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
}

/**
 * PATH override for every kernel child, or an empty record when the inherited PATH is already right.
 * Carries the bundled `bun` directory the bash tool's PATH has (omo#9362), plus Git Bash first on win32.
 */
export function kernelPathEntry(options: KernelPathEnvOptions = {}): Record<string, string> {
	const base = options.env ?? process.env;
	const withBun = (options.withBundledBun ?? withBundledBunCommands)(base);
	const env =
		(options.platform ?? process.platform) === "win32"
			? withGitBashFirst(withBun, (options.resolveGitBash ?? resolveGitBashFromShellConfig)())
			: withBun;
	if (env === base) return {};
	const pathKey = pathKeyOf(env);
	const value = env[pathKey];
	return value === undefined ? {} : { [pathKey]: value };
}

// A bare `bash` in a cell resolves through the kernel's PATH, where a default Git for Windows install
// lists only Git\cmd, so System32\bash.exe (the WSL launcher) won and booted WSL (omo#10894). The kernel
// gets the directory of the bash the bash tool runs, so `bash` and `sh` resolve to Git Bash first.
function withGitBashFirst(env: NodeJS.ProcessEnv, gitBash: string | undefined): NodeJS.ProcessEnv {
	if (gitBash === undefined || isWslLauncher(gitBash)) return env;
	const dir = win32.dirname(gitBash);
	const pathKey = pathKeyOf(env);
	const rest = (env[pathKey] ?? "")
		.split(win32.delimiter)
		.filter((entry) => entry !== "" && sameDir(entry, dir) === false);
	return { ...env, [pathKey]: [dir, ...rest].join(win32.delimiter) };
}

function resolveGitBashFromShellConfig(): string | undefined {
	try {
		const config = getShellConfig();
		return config.kind === "bash" || config.kind === "sh" ? config.shell : undefined;
	} catch {
		// getShellConfig throws when no bash exists (or SENPI_GIT_BASH_PATH is missing); the bash tool
		// reports that itself, and the kernel keeps the inherited PATH.
		return undefined;
	}
}

function isWslLauncher(path: string): boolean {
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/i.test(path.replace(/\//g, "\\"));
}

function sameDir(a: string, b: string): boolean {
	const normalize = (dir: string) => win32.normalize(dir).replace(/\\+$/, "").toLowerCase();
	return normalize(a) === normalize(b);
}

function pathKeyOf(env: NodeJS.ProcessEnv): string {
	return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}
