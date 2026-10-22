import type { RouterContext } from "./session-router-context.ts";

/**
 * Per-connection client capabilities on a shared host (omo-desktop-app#4042). A connection that never declared
 * counts as the host default. A session's binding answers with the union of the declarations of the
 * connections attached to it now, recomputed on open, attach, release, disconnect and every declaration; the
 * writer then filters each capability-gated record only for connections that declared a set: those receive it
 * when they declared that capability, and a connection that never declared receives it as before.
 */
export const CLIENT_CAPABILITIES_NOT_APPLIED =
	"client_capabilities_not_applied: a session this connection is attached to could not take the declared capabilities";

function declaredBy(host: RouterContext, connection: string): readonly string[] {
	return host.pendingCapabilities.get(connection) ?? host.connectionOptions?.capabilities ?? [];
}

function attachedConnections(host: RouterContext, sessionId: string): readonly string[] {
	return [...host.sessionsByConnection].filter(([, owned]) => owned.has(sessionId)).map(([connection]) => connection);
}

/** The union of the attached connections' declarations; the host default while nobody is attached. */
export function effectiveSessionCapabilities(host: RouterContext, sessionId: string): readonly string[] {
	const attached = attachedConnections(host, sessionId);
	if (attached.length === 0) return host.connectionOptions?.capabilities ?? [];
	return [...new Set(attached.flatMap((connection) => declaredBy(host, connection)))];
}

function sameSet(left: readonly string[] | undefined, right: readonly string[]): boolean {
	return left?.length === right.length && right.every((capability) => left.includes(capability));
}

/** Gives a session's binding exactly `capabilities`; false when the binding could not take them. */
export async function applySessionCapabilities(
	host: RouterContext,
	sessionId: string,
	capabilities: readonly string[],
): Promise<boolean> {
	const binding = host.bindings.get(sessionId);
	if (binding === undefined || host.registry.peek(sessionId)?.state !== "open") return true;
	if (sameSet(host.bindingCapabilities.get(binding), capabilities)) return true;
	host.bindingCapabilities.set(binding, [...capabilities]);
	try {
		await binding.setCapabilities?.(capabilities);
		return true;
	} catch (cause) {
		host.bindingCapabilities.delete(binding);
		process.stderr.write(`senpi rpc host: client capabilities not applied to ${sessionId}: ${String(cause)}\n`);
		return false;
	}
}

/**
 * Recomputes one session. The binding call starts synchronously, so a command the client sends after this
 * returns reaches the session after its new capabilities on both runtimes; callers on a path that must not
 * wait may drop the promise, which never rejects. A session with nobody attached keeps its set.
 */
export function recomputeSessionCapabilities(host: RouterContext, sessionId: string): Promise<boolean> {
	// With nobody attached the set stays: a retained session keeps its pending questions for the client that
	// reattaches, which the writer replays to it.
	if (attachedConnections(host, sessionId).length === 0) return Promise.resolve(true);
	return applySessionCapabilities(host, sessionId, effectiveSessionCapabilities(host, sessionId));
}

/** Records a connection's own declaration and recomputes every session it is attached to. */
export async function declareConnectionCapabilities(
	host: RouterContext,
	connection: string,
	capabilities: readonly string[],
): Promise<boolean> {
	host.pendingCapabilities.set(connection, [...capabilities]);
	host.writer.setConnectionCapabilities(connection, capabilities, true);
	const sessions = [...(host.sessionsByConnection.get(connection)?.keys() ?? [])];
	const applied = await Promise.all(sessions.map((sessionId) => recomputeSessionCapabilities(host, sessionId)));
	return applied.every(Boolean);
}
