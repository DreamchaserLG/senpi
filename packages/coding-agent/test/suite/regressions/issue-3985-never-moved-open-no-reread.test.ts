/**
 * Opening a session that was never moved must not read its JSONL a second time just to learn that no moved
 * extension state is waiting (senpi#3985). The session manager has already parsed the file; the moved-state check
 * reread and reparsed the whole transcript on every open, which on a 272 MiB session is one more full parse.
 * A moved-in session with pending state still gets it exactly once.
 */
import { mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sessionManagerModule from "../../../src/core/session-manager.ts";
import { type MovedStateDelivery, restoreMovedState } from "../../../src/core/session-move/extension-state.ts";
import { moveIn } from "../session-move-extension-state-support.ts";
import { root, writeSession } from "../session-move-fixture.ts";

vi.mock("../../../src/core/session-manager.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof sessionManagerModule>();
	return { ...actual, loadEntriesFromFile: vi.fn(actual.loadEntriesFromFile) };
});

const loader = vi.mocked(sessionManagerModule.loadEntriesFromFile);

afterEach(() => {
	loader.mockClear();
});

function neverMovedSession(): string {
	const cwd = join(root(), "repo");
	mkdirSync(cwd, { recursive: true });
	return writeSession(cwd);
}

async function openAndRestore(sessionFile: string): Promise<MovedStateDelivery[]> {
	const sessionManager = sessionManagerModule.SessionManager.open(sessionFile);
	loader.mockClear();
	const delivered: MovedStateDelivery[] = [];
	await restoreMovedState(sessionManager, async (event) => {
		delivered.push(event);
		return true;
	});
	return delivered;
}

describe("moved-state check on open (senpi#3985)", () => {
	it("#given a never-moved session #when it is opened #then the moved-state check does not read the session file again", async () => {
		const sessionFile = neverMovedSession();

		const delivered = await openAndRestore(sessionFile);

		expect(delivered).toEqual([]);
		expect(loader).not.toHaveBeenCalled();
	});

	it("#given another session in the folder with pending moved state #when a never-moved session is opened #then it does not read its file again", async () => {
		const sessionFile = neverMovedSession();
		const other = join(dirname(sessionFile), ".move-state", "in", "2026-10-18T00-00-00-000Z_other.move-0009");
		mkdirSync(other, { recursive: true });

		const delivered = await openAndRestore(sessionFile);

		expect(delivered).toEqual([]);
		expect(loader).not.toHaveBeenCalled();
		expect(readdirSync(dirname(other))).toEqual([basename(other)]);
	});

	it("#given a moved-in session with pending state #when it is opened #then the state is delivered exactly once", async () => {
		const sessionFile = neverMovedSession();
		const pendingDir = moveIn(sessionFile, "move-0007");

		const first = await openAndRestore(sessionFile);
		const second = await openAndRestore(sessionFile);

		expect(first).toEqual([expect.objectContaining({ moveId: "move-0007", redelivered: false })]);
		expect(second).toEqual([]);
		expect(readdirSync(dirname(pendingDir))).toEqual([]);
	});
});
