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

	/** Returns true when this input opened the release and therefore owns giving it back. */
	begin(): boolean {
		this.hold.attend();
		if (this.hold.releasing || this.pending || !this.hold.held) return false;
		const wakes = this.hold.messages();
		const sources = this.hold.releaseAll("input");
		this.pending = { sources, wakes, admitted: wakes.length === 0 };
		return true;
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

	/** The input that began this release ended without any disposition (thrown or cancelled): give it back, custody intact. */
	abandon(): void {
		if (!this.pending) return;
		const delivered = this.pending.wakes.length > 0 && this.pending.admitted;
		if (delivered) return;
		this.pending = undefined;
		this.hold.abandonRelease();
	}

	async finish(release: (sources: Record<string, number>) => Promise<void>): Promise<void> {
		const pending = this.pending;
		if (!pending?.admitted) return;
		this.pending = undefined;
		const remaining = this.hold.finish();
		await release({ ...pending.sources, ...remaining });
	}
}
