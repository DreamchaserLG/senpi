import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "./agent-session.ts";
import type { CustomMessage } from "./messages.ts";
import type { SessionLifecycleController } from "./session-lifecycle.ts";
import type { DeliveryTicketId } from "./session-lifecycle-types.ts";
import { isRecord } from "./work-custody-record.ts";

export function messageTicket(message: Pick<CustomMessage, "details">): DeliveryTicketId | undefined {
	return isRecord(message.details) && typeof message.details.ticketId === "string"
		? message.details.ticketId
		: undefined;
}

/** Synchronous at message_start: transcript first, then the consuming run's custody. */
export function consumeLifecycleDelivery(
	session: AgentSession,
	controller: SessionLifecycleController,
	message: AgentMessage,
): string | undefined {
	if (message.role !== "custom") return undefined;
	const ticketId = messageTicket(message);
	if (!ticketId) return undefined;
	const custody = controller.obligations.active.find((record) => record.ticketId === ticketId);
	if (!custody) return undefined;
	if (custody.state === "consumed") return undefined;
	const runId = controller.ledger.runId;
	if (!runId) return undefined;
	const existing = session.sessionManager
		.getEntries()
		.find((entry) => entry.type === "custom_message" && messageTicket(entry) === ticketId);
	const transcriptEntryId =
		existing?.id ??
		session.sessionManager.appendCustomMessageEntry(
			message.customType,
			message.content,
			message.display,
			message.details,
		);
	controller.obligations.consumed(ticketId, { runId, transcriptEntryId });
	return transcriptEntryId;
}

/**
 * #3860 currently returns void from note(). Capture its appended notice by
 * ticket identity instead of introducing another held-message store.
 */
export function heldLifecycleNotice(session: AgentSession, ticketId: DeliveryTicketId): string | undefined {
	for (const entry of session.sessionManager.getEntries().toReversed()) {
		if (entry.type !== "custom" || entry.customType !== "session-notice" || !isRecord(entry.data)) continue;
		if (
			isRecord(entry.data.message) &&
			isRecord(entry.data.message.details) &&
			entry.data.message.details.ticketId === ticketId &&
			typeof entry.data.noticeId === "string"
		)
			return entry.data.noticeId;
		// Goal notices deliberately store no pre-rendered message (#3860).
		if (entry.data.producer === "goal" && entry.data.message === undefined && typeof entry.data.noticeId === "string")
			return entry.data.noticeId;
	}
	return undefined;
}
