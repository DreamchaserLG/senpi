/**
 * senpi#3684: which accounts the usage poll speaks for, and how it reads the endpoints. Accounts are named
 * as turns name them; a live token is used as stored, an expiring Claude token is renewed through the
 * turn's refresher and written back, a login already rejected is reported instead of re-redeemed, and an
 * expired ChatGPT token is left for a turn to renew. Payload shapes map onto the ids turns report.
 */
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { CredentialStoreBusyError } from "../../../src/core/lockfile-policy.ts";
import { listPollAccounts, SIGN_IN_NEEDED } from "../../../src/core/subscription-limits/usage-accounts.ts";
import { claudeWindowsFromUsage, codexUsage } from "../../../src/core/subscription-limits/usage-endpoints.ts";

const NOW = Date.parse("2026-10-19T04:00:00Z");
const LIVE = NOW + 3_600_000;
const token = (tag: string) => `${tag}-${"t".repeat(48)}`;

function claudeSlot(name: string, expires: number, extra: Record<string, unknown> = {}) {
	return {
		name,
		access: token(`access-${name}`),
		refresh: token(`refresh-${name}`),
		expires,
		source: "login",
		...extra,
	};
}

function storage() {
	return AuthStorage.inMemory({
		"anthropic-subscription": {
			type: "oauth",
			access: "claude-sdk-oauth-managed",
			refresh: "claude-sdk-oauth-managed",
			expires: 4102444800000,
			accounts: [
				claudeSlot("live", LIVE),
				claudeSlot("expiring", NOW + 60_000),
				claudeSlot("rejected", NOW - 1, { blockReason: "auth_error", blockedUntil: LIVE }),
			],
		},
		"chatgpt-subscription": {
			type: "oauth",
			access: token("codex"),
			refresh: token("codex-refresh"),
			expires: NOW - 1,
		},
	} as never);
}

describe("usage poll accounts and payloads (senpi#3684)", () => {
	it("names accounts as turns do and resolves each token the way a turn would", async () => {
		const store = storage();
		const refreshed: string[] = [];
		const accounts = await listPollAccounts({
			store,
			env: (name) => (name === "CLAUDE_CODE_OAUTH_TOKEN" ? token("env") : undefined),
			refresher: async (refresh) => {
				refreshed.push(refresh);
				return { access: token("renewed"), refresh: token("renewed-refresh"), expires: LIVE };
			},
			now: () => NOW,
		});
		const signal = new AbortController().signal;
		const resolved = Object.fromEntries(
			await Promise.all(
				accounts.map(async (entry) => [`${entry.provider}/${entry.account}`, await entry.access(signal)]),
			),
		);

		expect(resolved).toEqual({
			"anthropic-subscription/live": { access: token("access-live") },
			"anthropic-subscription/expiring": { access: token("renewed") },
			"anthropic-subscription/rejected": { error: SIGN_IN_NEEDED },
			"anthropic-subscription/env": { access: token("env") },
			"chatgpt-subscription/default": undefined,
		});
		expect(refreshed).toEqual([token("refresh-expiring")]);
		const stored = await store.read("anthropic-subscription");
		const slots =
			stored !== undefined && "accounts" in stored && Array.isArray(stored.accounts) ? stored.accounts : [];
		expect(slots.find((slot: { name?: string }) => slot.name === "expiring")?.access).toBe(token("renewed"));
	});

	it("a revoked grant stops polling: blocked once, said once, never redeemed again", async () => {
		const store = AuthStorage.inMemory({
			"anthropic-subscription": {
				type: "oauth",
				access: "claude-sdk-oauth-managed",
				refresh: "claude-sdk-oauth-managed",
				expires: 4102444800000,
				accounts: [claudeSlot("revoked", NOW - 1)],
			},
		} as never);
		let refreshes = 0;
		const sources = {
			store,
			env: () => undefined,
			refresher: async () => {
				refreshes += 1;
				throw new Error('OAuth token refresh failed: status=400 {"error":"invalid_grant"}');
			},
			now: () => NOW,
		};
		const signal = new AbortController().signal;

		const first = await (await listPollAccounts(sources))[0]?.access(signal);
		const second = await (await listPollAccounts(sources))[0]?.access(signal);

		expect([first, second]).toEqual([{ error: SIGN_IN_NEEDED }, { error: SIGN_IN_NEEDED }]);
		expect(refreshes).toBe(1);
		const stored = await store.read("anthropic-subscription");
		const slots =
			stored !== undefined && "accounts" in stored && Array.isArray(stored.accounts) ? stored.accounts : [];
		expect(slots[0]).toMatchObject({ blockReason: "auth_error", blockedAt: NOW });
	});

	const revokedStore = () =>
		AuthStorage.inMemory({
			"anthropic-subscription": {
				type: "oauth",
				access: "claude-sdk-oauth-managed",
				refresh: "claude-sdk-oauth-managed",
				expires: 4102444800000,
				accounts: [claudeSlot("work", NOW - 1)],
			},
		} as never);
	const workSlot = async (store: ReturnType<typeof revokedStore>) => {
		const stored = await store.read("anthropic-subscription");
		const slots =
			stored !== undefined && "accounts" in stored && Array.isArray(stored.accounts) ? stored.accounts : [];
		return slots.find((slot: { name?: string }) => slot.name === "work") as {
			blockReason?: string;
			refresh?: string;
		};
	};

	it("an aborted refresh (shutdown) never marks the grant revoked", async () => {
		const store = revokedStore();
		const controller = new AbortController();
		const accounts = await listPollAccounts({
			store,
			env: () => undefined,
			refresher: async () => {
				controller.abort();
				throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
			},
			now: () => NOW,
		});

		expect(await accounts[0]?.access(controller.signal)).toBeUndefined();
		expect((await workSlot(store)).blockReason).toBeUndefined();
	});

	it("a busy credential store is retried next interval, never a lock", async () => {
		const store = revokedStore();
		const accounts = await listPollAccounts({
			store,
			env: () => undefined,
			refresher: async () => {
				throw new CredentialStoreBusyError("auth.json", 5_000);
			},
			now: () => NOW,
		});

		expect(await accounts[0]?.access(new AbortController().signal)).toBeUndefined();
		expect((await workSlot(store)).blockReason).toBeUndefined();
	});

	it("a grant replaced before the lock is written (a /login in between) is not locked", async () => {
		const store = revokedStore();
		// A /login lands between the refresh's locked section and the lock write (the second modify).
		let modifies = 0;
		const relogin = async (current: unknown) => {
			const credential = current as { accounts: { name: string; refresh: string }[] };
			return {
				...credential,
				accounts: credential.accounts.map((slot) => ({ ...slot, refresh: token("relogin") })),
			} as never;
		};
		const racing = {
			read: store.read.bind(store),
			modify: async (...args: Parameters<typeof store.modify>) => {
				modifies += 1;
				if (modifies === 2) await store.modify("anthropic-subscription", relogin);
				return store.modify(...args);
			},
		} as never;
		const accounts = await listPollAccounts({
			store: racing,
			env: () => undefined,
			refresher: async () => {
				throw new Error('OAuth token refresh failed: status=400 {"error":"invalid_grant"}');
			},
			now: () => NOW,
		});

		expect(await accounts[0]?.access(new AbortController().signal)).toEqual({ error: SIGN_IN_NEEDED });
		expect(await workSlot(store)).toMatchObject({ refresh: token("relogin") });
		expect((await workSlot(store)).blockReason).toBeUndefined();
	});

	it("a transient refresh failure is retried next interval and blocks nothing", async () => {
		const store = storage();
		const accounts = await listPollAccounts({
			store,
			env: () => undefined,
			refresher: async () => {
				throw new Error("OAuth token refresh failed: status=503");
			},
			now: () => NOW,
		});
		const expiring = accounts.find((entry) => entry.account === "expiring");

		expect(await expiring?.access(new AbortController().signal)).toBeUndefined();
		const stored = await store.read("anthropic-subscription");
		const slots =
			stored !== undefined && "accounts" in stored && Array.isArray(stored.accounts) ? stored.accounts : [];
		expect(slots.find((slot: { name?: string }) => slot.name === "expiring")?.blockReason).toBeUndefined();
	});

	it("reads Claude's limits[] and legacy shapes, and ChatGPT's windows, onto the turn ids", () => {
		expect(
			claudeWindowsFromUsage({
				limits: [
					{ kind: "weekly_scoped", percent: 30, scope: { model: { display_name: "Opus" } } },
					{ kind: "unknown", percent: 99 },
				],
			}),
		).toEqual([{ id: "claude:7d_opus", label: "7d opus", windowMinutes: 10080, usedPercent: 30 }]);
		expect(
			claudeWindowsFromUsage({
				five_hour: { utilization: 22, resets_at: "2026-10-19T09:00:00+00:00" },
				seven_day_sonnet: { utilization: 4 },
				extra_usage: null,
			}),
		).toEqual([
			{ id: "claude:5h", label: "5h", windowMinutes: 300, usedPercent: 22, resetsAt: "2026-10-19T09:00:00.000Z" },
			{ id: "claude:7d_sonnet", label: "7d sonnet", windowMinutes: 10080, usedPercent: 4 },
		]);
		expect(
			codexUsage({
				rate_limit: {
					secondary_window: { used_percent: 61, limit_window_seconds: 604_800, reset_at: 1_792_400_000 },
				},
			}),
		).toEqual({
			windows: [
				{
					id: "codex:secondary",
					label: "7d",
					windowMinutes: 10080,
					usedPercent: 61,
					resetsAt: new Date(1_792_400_000_000).toISOString(),
				},
			],
		});
	});
});
