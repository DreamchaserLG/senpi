import { existsSync, rmSync } from "node:fs";
import { loadEntriesFromFile, SessionManager } from "../session-manager.ts";
import { readManifest } from "./bundle.ts";
import type { MoveStatus } from "./move-ledger.ts";
import { headerSessionId, type MoveId, SESSION_MOVED, SESSION_RECLAIMED, sessionOwnership } from "./ownership.ts";
import { requeueInput } from "./requeue.ts";

export interface FinishMoveOptions {
	readonly sessionFile: string;
	/** The bundle this device kept while the move was open; it holds the input the release took out. */
	readonly bundleDir: string;
	/** The move the answer is about; the bundle and the file must be about the same move. */
	readonly moveId: MoveId;
	/** The receiver's signed answer. `receiving` changes nothing: the move is still open. */
	readonly answer: MoveStatus;
}

export class MoveMismatchError extends Error {
	readonly code = "move_mismatch";

	constructor(expected: MoveId, found: string, what: string) {
		super(
			`The answer is about move ${expected}, but ${what} belongs to move ${found}; nothing was changed. Finish each move with its own answer and bundle.`,
		);
		this.name = "MoveMismatchError";
	}
}

/**
 * Closes a move on the sending device from the receiver's answer. `accepted` records `session_moved` (read-only for
 * good). `declined`/`failed` takes the session back: `session_reclaimed` makes the file writable, the queued input
 * is re-queued under ids stable per move, then the bundle goes. While the bundle exists the re-queue runs again on
 * the next call, so a crash between any two steps loses nothing and doubles nothing.
 */
export async function finishMove(options: FinishMoveOptions): Promise<void> {
	const { sessionFile, bundleDir, moveId, answer } = options;
	if (existsSync(bundleDir)) {
		const bundled = readManifest(bundleDir).moveId;
		if (bundled !== moveId) throw new MoveMismatchError(moveId, bundled, "the kept bundle");
	}
	const entries = loadEntriesFromFile(sessionFile);
	const ownership = sessionOwnership(entries);
	if (ownership.writable) {
		if (reclaimed(entries, moveId)) await requeueDroppedInput(sessionFile, bundleDir);
		rmSync(bundleDir, { recursive: true, force: true });
		return;
	}
	if (ownership.moveId !== moveId) throw new MoveMismatchError(moveId, ownership.moveId, "the session file");
	if (ownership.state === "moved") {
		rmSync(bundleDir, { recursive: true, force: true });
		return;
	}
	const sessionId = headerSessionId(entries) ?? "";
	switch (answer.state) {
		case "receiving":
			return;
		case "accepted":
			SessionManager.open(sessionFile).appendCustomEntry(SESSION_MOVED, {
				move_id: moveId,
				session_id: sessionId,
				target: ownership.target,
				moved_at: new Date().toISOString(),
			});
			break;
		case "declined":
		case "failed":
			SessionManager.open(sessionFile).appendCustomEntry(SESSION_RECLAIMED, {
				move_id: moveId,
				session_id: sessionId,
				reason: answer.state,
				detail: answer.reason,
				reclaimed_at: new Date().toISOString(),
			});
			await requeueDroppedInput(sessionFile, bundleDir);
			break;
		default: {
			const unreachable: never = answer;
			throw new Error(`Unknown move answer ${JSON.stringify(unreachable)}`);
		}
	}
	rmSync(bundleDir, { recursive: true, force: true });
}

function reclaimed(entries: readonly { type: string; customType?: string; data?: unknown }[], moveId: MoveId): boolean {
	return entries.some(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === SESSION_RECLAIMED &&
			(entry.data as { move_id?: unknown } | undefined)?.move_id === moveId,
	);
}

export async function requeueDroppedInput(sessionFile: string, bundleDir: string): Promise<void> {
	if (!existsSync(bundleDir)) return;
	const manifest = readManifest(bundleDir);
	await requeueInput(sessionFile, manifest.moveId, manifest.droppedUserMessages);
}
