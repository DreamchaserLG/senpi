import type { Credential, OAuthAuth, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { listSlots, type PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, test } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";

// senpi#3841: "Reconnect office" for a provider that does not ask "Name for this account" saved a NEW account
// (login-2, login-3, ...) instead of re-authenticating office. A login FOR a saved account must refresh that
// account in place, for every pooled OAuth provider, and never leave a second credential for the same account.

const oauthProviderIds = builtinProviders()
	.filter((provider) => provider.auth.oauth !== undefined)
	.map((provider) => provider.id);

const pool = (): PooledCredential => ({
	type: "oauth",
	access: "office-old-access",
	refresh: "office-old-refresh",
	expires: 1_000,
	accounts: [
		{ name: "office", source: "login", access: "office-old-access", refresh: "office-old-refresh", expires: 1_000 },
		{ name: "owen", source: "login", access: "owen-access", refresh: "owen-refresh", expires: 2_000 },
	],
});

const freshLogin = (): OAuthAuth => ({
	name: "Fake OAuth",
	login: async (): Promise<Credential> => ({
		type: "oauth",
		access: "office-new-access",
		refresh: "office-new-refresh",
		expires: 9_000,
	}),
});

const callbacks: OAuthLoginCallbacks = {
	onAuth: () => {},
	onDeviceCode: () => {},
	onPrompt: async () => "",
	onSelect: async () => undefined,
};

describe("Reconnect re-authenticates the saved account in place (senpi#3841)", () => {
	test("there are pooled OAuth providers to cover", () => {
		expect(oauthProviderIds.length).toBeGreaterThan(0);
	});

	test.each(oauthProviderIds)(
		"%s: a login for 'office' replaces office and never adds a second account",
		async (id) => {
			const storage = AuthStorage.inMemory({ [id]: pool() });
			storage.registerOAuthProvider(id, freshLogin());

			await storage.login(id, callbacks, { accountName: "office" });

			const slots = listSlots(storage.get(id) as PooledCredential);
			expect(slots.map((slot) => slot.name)).toEqual(["office", "owen"]);
			expect(slots.find((slot) => slot.name === "office")).toMatchObject({
				access: "office-new-access",
				refresh: "office-new-refresh",
				expires: 9_000,
			});
			expect(slots.find((slot) => slot.name === "owen")).toMatchObject({ access: "owen-access" });
			// office was the account the flat fields mirrored, so they now carry its new material.
			expect(storage.get(id)).toMatchObject({ access: "office-new-access", refresh: "office-new-refresh" });
		},
	);

	test("a login for a name the pool doesn't have adds that one account under that name", async () => {
		const id = oauthProviderIds[0] ?? "openai-codex";
		const storage = AuthStorage.inMemory({ [id]: pool() });
		storage.registerOAuthProvider(id, freshLogin());

		await storage.login(id, callbacks, { accountName: "laptop" });

		expect(listSlots(storage.get(id) as PooledCredential).map((slot) => slot.name)).toEqual([
			"office",
			"owen",
			"laptop",
		]);
	});

	test("a login without an account name still adds a new account (Add account)", async () => {
		const id = oauthProviderIds[0] ?? "openai-codex";
		const storage = AuthStorage.inMemory({ [id]: pool() });
		storage.registerOAuthProvider(id, freshLogin());

		await storage.login(id, callbacks);

		expect(listSlots(storage.get(id) as PooledCredential).map((slot) => slot.name)).toEqual([
			"office",
			"owen",
			"login-2",
		]);
	});

	test("an invalid account name is refused before any login runs", async () => {
		const id = oauthProviderIds[0] ?? "openai-codex";
		let ran = false;
		const storage = AuthStorage.inMemory({ [id]: pool() });
		storage.registerOAuthProvider(id, {
			name: "Fake",
			login: async () => {
				ran = true;
				return { type: "oauth", access: "a", refresh: "r", expires: 1 };
			},
		});

		await expect(storage.login(id, callbacks, { accountName: "../office" })).rejects.toThrow(/Invalid account name/);
		expect(ran).toBe(false);
		expect(listSlots(storage.get(id) as PooledCredential).map((slot) => slot.name)).toEqual(["office", "owen"]);
	});
});
