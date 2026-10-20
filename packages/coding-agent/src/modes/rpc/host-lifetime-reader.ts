import { closeSync } from "node:fs";
import { Socket } from "node:net";

/** Owns a reopened stdin descriptor. Never parks a Node thread-pool read in process.exit(). */
export function watchHostLifetime(fd: number, gone: () => void, unavailable: () => void): () => void {
	let stopped = false;
	const bun: unknown = Reflect.get(globalThis, "Bun");
	if (typeof bun === "object" && bun !== null && typeof Reflect.get(bun, "file") === "function") {
		const reader: ReadableStreamDefaultReader<Uint8Array> = Reflect.get(bun, "file")(fd).stream().getReader();
		void (async () => {
			try {
				while (!stopped) {
					const { done } = await reader.read();
					if (done) {
						if (!stopped) gone();
						return;
					}
				}
			} catch {
				// A read error is unknown, not supervisor death.
				if (!stopped) unavailable();
			}
		})();
		return () => {
			if (stopped) return;
			stopped = true;
			void reader.cancel().catch(() => undefined);
			closeSync(fd);
		};
	}
	const socket = new Socket({ fd, readable: true, writable: false });
	socket.once("end", () => {
		if (!stopped) gone();
	});
	socket.once("error", () => {
		if (!stopped) unavailable();
	});
	socket.unref();
	socket.resume();
	return () => {
		stopped = true;
		socket.destroy();
	};
}
