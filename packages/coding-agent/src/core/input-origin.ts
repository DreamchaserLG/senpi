import { isUserDirectedTurn } from "./engine-turn-limit.ts";
import type { InputSource } from "./extensions/types.ts";

/**
 * Who started an input, classified once at its entry point (senpi#3853):
 * - `person`: RPC prompt / steer / follow_up / answer and TUI submit;
 * - `extension`: extension API sends (`pi.sendUserMessage`);
 * - `engine`: goal, monitor, codemode and other automation turns.
 */
export type InputOrigin = "person" | "extension" | "engine";

export function inputOriginOf(source: InputSource | undefined): InputOrigin {
	return source === "extension" ? "extension" : "person";
}

export function customTurnOrigin(customType: string): InputOrigin {
	return isUserDirectedTurn(customType) ? "person" : "engine";
}
