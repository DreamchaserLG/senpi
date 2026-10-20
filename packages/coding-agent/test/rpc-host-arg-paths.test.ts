import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { absoluteHostArgs, withAbsoluteHostArgs } from "../src/modes/rpc/protocol-identity.ts";
import { resolveCliPaths } from "../src/utils/paths.ts";

/**
 * Makes each path-valued host arg absolute against the CALLER's cwd (senpi#3783), with `resolveCliPaths`, the CLI's own
 * rule: every local value resolves whether or not it exists yet, a bare name included (`--session-dir sessions` is
 * `<caller>/sessions`, `--theme dark` is `<caller>/dark`, exactly as the CLI reads them); package specs stay verbatim.
 * The supervisor and its host child run in the agent dir, so a relative value must never reach them unresolved.
 */
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

	it("resolves every local value against the caller, existing or not, and leaves specs and other flags alone", () => {
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
					"--session-dir",
					"sessions",
					"--prompt-template",
					"later.md",
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
			resolve(cwd, "dark"),
			"--skill",
			resolve(cwd, "local-ext"),
			"--session-dir",
			resolve(cwd, "sessions"),
			"--prompt-template",
			resolve(cwd, "later.md"),
			"--session-runtime",
			"./not-a-path-flag",
		]);
	});

	it("is resolveCliPaths for every path-valued flag value", () => {
		const cwd = tempCwd();
		const values = ["sessions", "./x.js", "~/y", "file:///abs/z.js", "npm:a", "git:h/p", "builtin:b", "/abs/w"];
		for (const flag of ["--extension", "-e", "--skill", "--prompt-template", "--theme", "--session-dir"]) {
			const args = values.flatMap((value) => [flag, value]);
			const resolved = absoluteHostArgs(args, cwd).filter((_, index) => index % 2 === 1);
			expect(resolved).toEqual(resolveCliPaths(cwd, values));
		}
	});

	it("resolves against this process's cwd at the ensure/handoff entry", () => {
		const options = withAbsoluteHostArgs({ socket: "/s", hostArgs: ["--extension", "./x.js"] });
		expect(options.hostArgs).toEqual(["--extension", resolve(process.cwd(), "x.js")]);
		const bare: { readonly socket: string; readonly hostArgs?: readonly string[] } = { socket: "/s" };
		expect(withAbsoluteHostArgs(bare)).toBe(bare);
	});
});
