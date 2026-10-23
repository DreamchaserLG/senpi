import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";

// senpi#4091: a usage limit that names no reset is retried with a doubling cooldown, and every
// failed probe doubles it again. The block must never outgrow the shortest subscription window
// (5 hours): past that the limit has reset, and a longer block keeps a recovered account unused
// for up to 48 hours. Contract guarded: persisted pool health.

const NOW = 1_800_000_000_000;
const PROVIDER = "chatgpt-subscription";
const WINDOW_MS = 5 * 60 * 60_000;

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "issue-4091-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function sources(repository: CredentialSlotRepository, clock: { now: number }) {
	const credential: PooledCredential = {
		type: "api_key",
		key: "key-a",
		accounts: [{ name: "a", key: "key-a", source: "login" }],
	};
	return { providerId: PROVIDER, credential, env: () => undefined, repository, now: () => clock.now };
}

async function probeLimited(repository: CredentialSlotRepository, clock: { now: number }): Promise<void> {
	const limit = Object.assign(new Error("You've hit your usage limit. Upgrade to Pro for higher limits."), {
		status: 429,
	});
	const stream = streamWithCredentialRotation({
		sources: sources(repository, clock),
		affinityKey: "session-4091",
		runAttempt: (): AsyncIterable<AssistantMessageEvent> => {
			throw limit;
		},
	});
	const events: AssistantMessageEvent[] = [];
	await expect(
		(async () => {
			for await (const event of stream) events.push(event);
		})(),
	).rejects.toThrow("usage limit");
	expect(events).toEqual([]);
}

describe("a no-reset usage limit's cooldown stops at the subscription window (#4091)", () => {
	test("a dozen failed probes never block the slot past the 5-hour window", async () => {
		const clock = { now: NOW };
		const repository = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
		const blocks: number[] = [];
		for (let probe = 0; probe < 12; probe++) {
			await probeLimited(repository, clock);
			const blockedUntil = (await repository.listSlots(PROVIDER, "stored")).a?.blockedUntil;
			if (blockedUntil === undefined) throw new Error(`probe ${probe} left no block`);
			blocks.push(blockedUntil - clock.now);
			clock.now = blockedUntil + 1;
		}

		expect(Math.max(...blocks)).toBeLessThanOrEqual(WINDOW_MS);
		expect(blocks[1]).toBeGreaterThan(blocks[0] ?? 0);
		expect(blocks.at(-1)).toBe(WINDOW_MS);
	});
});
