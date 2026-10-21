import type { DeliveryTicketId, ObligationKind, ObligationToken, WorkObligations } from "./session-lifecycle-types.ts";
import type { SessionEntry } from "./session-manager.ts";
import { type CustodyPayload, custodyIsOpen, readWorkCustody, type WorkCustodyRecord } from "./work-custody-record.ts";

export class CustodyViolation extends Error {
	readonly key: string;
	constructor(key: string) {
		super(`Work custody is no longer owned: ${key}`);
		this.name = "CustodyViolation";
		this.key = key;
	}
}

export interface CustodyStore {
	readonly entries: readonly SessionEntry[];
	append(record: WorkCustodyRecord): void;
	changed(): void;
}

/** One session's durable registry. A token never acknowledges its own delivery. */
export class SessionWorkObligations implements WorkObligations {
	private readonly records = new Map<string, WorkCustodyRecord>();
	private readonly delivering = new Set<DeliveryTicketId>();
	private readonly store: CustodyStore;
	constructor(store: CustodyStore) {
		this.store = store;
		for (const entry of store.entries) {
			if (entry.type !== "custom" || entry.customType !== "work-custody") continue;
			const record = readWorkCustody(entry.data);
			if (record) this.records.set(record.id, record);
		}
	}

	get active(): readonly WorkCustodyRecord[] {
		return [...this.records.values()].filter(custodyIsOpen);
	}

	get activeCount(): number {
		return this.active.reduce((sum, record) => sum + (record.activeCount ?? 1), 0);
	}

	open(key: string, kind: ObligationKind, detail?: string): ObligationToken {
		const existing = this.active.find((record) => record.key === key);
		if (existing) return this.token(existing.id);
		const record: WorkCustodyRecord = {
			id: crypto.randomUUID(),
			key,
			kind,
			state: "open",
			...(detail === undefined ? {} : { detail }),
		};
		this.install(record);
		this.store.changed();
		return this.token(record.id);
	}

	syncSource(source: string, kind: ObligationKind, activeCount: number): void {
		const key = `wake-source:${source}`;
		const current = this.active.find((record) => record.key === key);
		if (activeCount <= 0) {
			if (current) this.close(current.id, "passive");
			return;
		}
		if (current?.activeCount === activeCount && current.kind === kind) return;
		this.install({
			id: current?.id ?? crypto.randomUUID(),
			key,
			source,
			kind,
			activeCount,
			state: "open",
		});
		this.store.changed();
	}

	queue(ticketId: DeliveryTicketId, payload: CustodyPayload): boolean {
		const record = this.ticketRecord(ticketId);
		if (!custodyIsOpen(record) || record.state === "consumed" || this.delivering.has(ticketId)) return false;
		this.install({ ...record, state: "queued", payload, delivery: undefined });
		this.delivering.add(ticketId);
		this.store.changed();
		return true;
	}

	endDelivery(ticketId: DeliveryTicketId): void {
		this.delivering.delete(ticketId);
	}

	passive(ticketId: DeliveryTicketId): void {
		const record = this.ticketRecord(ticketId);
		if (custodyIsOpen(record)) this.close(record.id, "passive");
	}

	consumed(ticketId: DeliveryTicketId, run: { readonly runId: string; readonly transcriptEntryId: string }): void {
		const record = this.ticketRecord(ticketId);
		if (!custodyIsOpen(record) || record.state === "consumed") return;
		this.install({ ...record, state: "consumed", ...run, delivery: undefined });
		this.store.changed();
	}

	failed(ticketId: DeliveryTicketId): void {
		const record = this.ticketRecord(ticketId);
		if (!custodyIsOpen(record) || record.state === "consumed") return;
		this.install({ ...record, state: "queued", delivery: "failed" });
		this.store.changed();
	}

	held(ticketId: DeliveryTicketId, noticeId: string): void {
		const record = this.ticketRecord(ticketId);
		if (custodyIsOpen(record)) this.close(record.id, "held", noticeId);
	}

	retire(ticketId: DeliveryTicketId): void {
		const record = this.ticketRecord(ticketId);
		if (!custodyIsOpen(record) || record.state === "consumed") return;
		this.install({ ...record, state: "open", delivery: "retired", payload: undefined });
		this.store.changed();
	}

	cancel(ticketId: DeliveryTicketId): void {
		const record = this.ticketRecord(ticketId);
		if (custodyIsOpen(record) && record.state !== "consumed") this.close(record.id, "cancelled");
	}

	settleRun(runId: string): void {
		for (const record of this.active) {
			if (record.state === "consumed" && record.runId === runId) this.install({ ...record, state: "settled" });
		}
		this.store.changed();
	}

	private install(record: WorkCustodyRecord): void {
		this.store.append(record);
		this.records.set(record.id, record);
	}

	private owned(id: string): WorkCustodyRecord {
		const record = this.records.get(id);
		if (!record || !custodyIsOpen(record)) throw new CustodyViolation(record?.key ?? id);
		return record;
	}

	private ticketRecord(ticketId: DeliveryTicketId): WorkCustodyRecord {
		const record = [...this.records.values()].find((value) => value.ticketId === ticketId);
		if (!record) throw new CustodyViolation(ticketId);
		return record;
	}

	private close(id: string, state: "settled" | "held" | "cancelled" | "passive", noticeId?: string): void {
		const record = this.owned(id);
		this.install({ ...record, state, ...(noticeId === undefined ? {} : { noticeId }) });
		this.store.changed();
	}

	private token(id: string): ObligationToken {
		return {
			transfer: (nextKey, kind) => {
				const current = this.owned(id);
				if (nextKey === current.key) throw new CustodyViolation(nextKey);
				const next = this.active.find((record) => record.key === nextKey) ?? {
					id: crypto.randomUUID(),
					key: nextKey,
					kind: kind ?? current.kind,
					state: "open" as const,
				};
				// Both writes are synchronous; publish only after custody has moved.
				// If the second append fails, both remain open: work cannot disappear.
				try {
					this.install(next);
					this.install({ ...current, state: "cancelled" });
				} finally {
					this.store.changed();
				}
				return this.token(next.id);
			},
			ticket: () => {
				const record = this.owned(id);
				if (record.ticketId) return record.ticketId;
				const ticketId = crypto.randomUUID();
				this.install({ ...record, state: "queued", ticketId });
				this.store.changed();
				return ticketId;
			},
			heldAsNotice: (noticeId) => this.close(id, "held", noticeId),
			close: (reason) => this.close(id, reason === "consumed" ? "settled" : reason),
		};
	}
}
