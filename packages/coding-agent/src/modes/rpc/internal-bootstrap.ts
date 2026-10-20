import { closeSync, openSync, readSync } from "node:fs";

const INTERNAL_KEY_STDIN_ENV = "SENPI_RPC_INTERNAL_KEY_STDIN";
export interface InternalHostBootstrap {
	readonly key: Buffer;
	readonly lifetimeFd?: number;
}

function bootstrap(): InternalHostBootstrap | undefined {
	if (process.platform === "win32" || process.env[INTERNAL_KEY_STDIN_ENV] !== "1") return undefined;
	// Launchers forward stdin; only the engine consumes it. Descendants must never bootstrap again.
	delete process.env[INTERNAL_KEY_STDIN_ENV];
	const key = Buffer.alloc(32);
	const deadline = Date.now() + 2000;
	const pause = new Int32Array(new SharedArrayBuffer(4));
	let offset = 0;
	let lifetimeFd: number | undefined;
	try {
		while (offset < key.length) {
			if (Date.now() >= deadline) throw new Error("internal_key_unavailable");
			try {
				const n = readSync(0, key, offset, key.length - offset, null);
				if (n === 0) throw new Error("internal_key_unavailable");
				offset += n;
			} catch (cause) {
				if (cause instanceof Error && "code" in cause && cause.code === "EAGAIN") {
					Atomics.wait(pause, 0, 0, 5);
					continue;
				}
				throw new Error("internal_key_unavailable", { cause });
			}
		}
		try {
			// close-on-exec: descendants inherit only restored /dev/null, never this lifetime fd.
			lifetimeFd = openSync("/dev/fd/0", "r");
		} catch {
			// Linux socketpair stdin returns ENXIO. Every reopen failure has the same safe fallback.
			process.stderr.write("senpi rpc host: stdin lifetime reopen unavailable; using supervisor identity poll\n");
		}
	} finally {
		closeSync(0);
		const restored = openSync("/dev/null", "r");
		if (restored !== 0) throw new Error("internal_key_unavailable: cannot restore stdin");
	}
	return { key, ...(lifetimeFd === undefined ? {} : { lifetimeFd }) };
}

// Imported before the CLI graph can instantiate process.stdin.
const internalHostBootstrap = bootstrap();
export function getInternalHostBootstrap(): InternalHostBootstrap | undefined {
	return internalHostBootstrap;
}
