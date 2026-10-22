import type { EngineTurnHold } from "./engine-turn-hold.ts";
import type { CustomMessage } from "./messages.ts";

/** Input owns one release even when a command dispatches another prompt or a human steers mid-turn. */
export class EngineTurnInput {
	private pending:
		| { sources: Record<string, number>; wakes: ReturnType<EngineTurnHold["messages"]>; admitted: boolean }
		| undefined;
	private readonly hold: EngineTurnHold;

	constructor(hold: EngineTurnHold) {
		this.hold = hold;
	}

	get hasPending(): boolean {
		return this.pending !== undefined;
	}

	begin(): void {
		this.hold.attend();
		if (this.hold.releasing || this.pending || !this.hold.held) return;
		const wakes = this.hold.messages();
		const sources = this.hold.releaseAll("input");
		this.pending = { sources, wakes, admitted: false };
	}

	messages(): CustomMessage[] {
		return this.pending?.admitted ? [] : (this.pending?.wakes.map((wake) => wake.message) ?? []);
	}

	admit(queued: boolean, enqueue: (message: CustomMessage) => void): void {
		const pending = this.pending;
		if (!pending || pending.admitted) return;
		for (const wake of pending.wakes) {
			if (this.hold.consume(wake.source, wake.noticeIds) && queued) enqueue(wake.message);
		}
		pending.admitted = true;
	}

	/**
	 * The one settle point, called once the session is quiescent (no prompt in flight, no run active):
	 * an admitted release finishes; one no input admitted (handled, no-op, thrown, cancelled, refused,
	 * an answer without a follow-on) is given back with custody intact.
	 */
	async settle(release: (sources: Record<string, number>) => Promise<void>): Promise<void> {
		const pending = this.pending;
		if (!pending) return;
		this.pending = undefined;
		if (!pending.admitted) {
			this.hold.abandonRelease();
			return;
		}
		const remaining = this.hold.finish();
		await release({ ...pending.sources, ...remaining });
	}
}
