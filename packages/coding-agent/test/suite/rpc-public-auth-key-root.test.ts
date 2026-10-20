import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHostArgs } from "../../src/cli/host-command.ts";
import { getAgentDir } from "../../src/config.ts";
import { rpcKeyRoot, withRpcKeyRoot } from "../../src/modes/rpc/rpc-auth-client.ts";

afterEach(() => vi.unstubAllEnvs());

describe.skipIf(process.platform === "win32")("public RPC credential-root selection", () => {
	it("lets an explicit host flag override the environment without changing the profile", () => {
		vi.stubEnv("SENPI_RPC_KEY_ROOT", "/environment-root");
		const profile = getAgentDir();
		const parsed = parseHostArgs(["status", "--rpc-key-root", "/flag-root"]);
		if (typeof parsed === "string") throw new Error(parsed);
		expect(withRpcKeyRoot(parsed.keyRoot ?? "", () => rpcKeyRoot())).toBe("/flag-root");
		expect(getAgentDir()).toBe(profile);
		expect(rpcKeyRoot()).toBe("/environment-root");
	});

	it("gives explicit client options precedence over nested context and environment", () => {
		vi.stubEnv("SENPI_RPC_KEY_ROOT", "/environment-root");
		expect(withRpcKeyRoot("/flag-root", () => rpcKeyRoot({ keyRoot: "/client-root" }))).toBe("/client-root");
	});

	it("preserves separate roots across concurrent asynchronous operations", async () => {
		await Promise.all(
			["/root-a", "/root-b"].map((root) =>
				withRpcKeyRoot(root, async () => {
					await Promise.resolve();
					expect(rpcKeyRoot()).toBe(root);
				}),
			),
		);
	});
});
