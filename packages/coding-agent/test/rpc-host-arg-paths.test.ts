import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	absoluteHostArgs,
	NON_LOCAL_SPEC_PREFIXES,
	withAbsoluteHostArgs,
} from "../src/modes/rpc/host-lifecycle-launch.ts";
import { isLocalPath } from "../src/utils/paths.ts";

describe("host arg paths (senpi#3783)", () => {
	const created: string[] = [];
	afterEach(() => {
		for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	const tempCwd = () => {
		const dir = mkdtempSync(join(tmpdir(), "rpc3783-args-"));
		created.push(dir);
		return dir;
	};

	it("classifies package specs exactly as isLocalPath does", () => {
		for (const prefix of NON_LOCAL_SPEC_PREFIXES) expect(isLocalPath(`${prefix}x`)).toBe(false);
		for (const spec of ["npm:a", "git:h/p", "github:o/r", "http://h", "https://h", "ssh://h", "builtin:x"]) {
			expect(NON_LOCAL_SPEC_PREFIXES.some((prefix) => spec.startsWith(prefix))).toBe(true);
		}
	});

	it("makes path-valued args absolute against the caller and leaves specs, names and other flags alone", () => {
		const cwd = tempCwd();
		mkdirSync(join(cwd, "local-ext"));
		expect(
			absoluteHostArgs(
				[
					"--extension",
					"./missing/a.js",
					"-e",
					"npm:foo@1",
					"--theme",
					"dark",
					"--skill",
					"local-ext",
					"--session-runtime",
					"./not-a-path-flag",
				],
				cwd,
			),
		).toEqual([
			"--extension",
			resolve(cwd, "missing/a.js"),
			"-e",
			"npm:foo@1",
			"--theme",
			"dark",
			"--skill",
			resolve(cwd, "local-ext"),
			"--session-runtime",
			"./not-a-path-flag",
		]);
	});

	it("resolves against this process's cwd at the ensure/handoff entry", () => {
		const options = withAbsoluteHostArgs({ socket: "/s", hostArgs: ["--extension", "./x.js"] });
		expect(options.hostArgs).toEqual(["--extension", resolve(process.cwd(), "x.js")]);
		const bare: { readonly socket: string; readonly hostArgs?: readonly string[] } = { socket: "/s" };
		expect(withAbsoluteHostArgs(bare)).toBe(bare);
	});
});
