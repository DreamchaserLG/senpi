import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { Harness } from "../harness.ts";
import { createBoundLifecycleHarness as createHarness, runToAgentIdle } from "../lifecycle-test-harness.ts";

// senpi#3864, design test 19: the engine decides self-settle when root work seals.
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

it("seals a standing agent request as a durable settle decision", async () => {
	// Given an agent request recorded in an admitted root epoch.
	const h = await createHarness({ persistSession: true });
	harnesses.push(h);
	expect(h.session.requestSelfSettle).toBeTypeOf("function");
	let recorded = false;
	const unsubscribe = h.session.subscribe((event) => {
		if (event.type === "agent_start") recorded = h.session.requestSelfSettle().recorded;
	});
	h.setResponses([fauxAssistantMessage("Finished.")]);

	// When all root work ends.
	try {
		await runToAgentIdle(h, () => h.session.prompt("Complete the change"));
	} finally {
		unsubscribe();
	}

	// Then the seal, not a label guessed by a client, carries the decision.
	expect(recorded).toBe(true);
	expect(h.session.lifecycle).toMatchObject({
		state: "done",
		persisted: true,
		completion: { kind: "agent" },
		settleDecision: { decisionId: expect.any(String) },
	});
	expect(h.sessionManager.getEntries()).toContainEqual(
		expect.objectContaining({
			type: "custom",
			customType: "session-lifecycle",
			data: expect.objectContaining({
				state: "done",
				settleDecision: h.session.lifecycle.settleDecision,
			}),
		}),
	);
});

it("refuses a self-settle request while an unattended hold is live", async () => {
	// Given an unattended reopened session.
	const h = await createHarness({
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
	});
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc" });
	expect(h.session.requestSelfSettle).toBeTypeOf("function");

	// When its agent asks to settle.
	const result = h.session.requestSelfSettle();

	// Then the shared hold authority refuses it.
	expect(result).toMatchObject({ recorded: false, reason: "held" });
});

it("keeps a sealed decision unchanged across a reopen", async () => {
	// Given a persisted done epoch with a self-settle decision.
	const a = await createHarness({ persistSession: true });
	harnesses.push(a);
	expect(a.session.requestSelfSettle).toBeTypeOf("function");
	const unsubscribe = a.session.subscribe((event) => {
		if (event.type === "agent_start") a.session.requestSelfSettle();
	});
	a.setResponses([fauxAssistantMessage("Finished.")]);
	await runToAgentIdle(a, () => a.session.prompt("Complete the change"));
	unsubscribe();
	const decision = a.session.lifecycle.settleDecision;
	const completionId = a.session.lifecycle.completionId;
	const file = a.sessionManager.getSessionFile();
	if (!file) throw new Error("A persisted session file is required");
	a.session.dispose();

	// When the engine reopens that transcript and crosses its restore barrier.
	const b = await createHarness({ siblingOf: a, sessionManager: SessionManager.open(file) });
	harnesses.push(b);
	await b.session.bindExtensions({ mode: "rpc" });

	// Then replay neither invents another decision nor another completion.
	expect(b.session.lifecycle).toMatchObject({ completionId, settleDecision: decision, restoring: false });
	expect(
		b.events.filter((event) => event.type === "session_lifecycle" && event.lifecycle.state === "done"),
	).toHaveLength(0);
});

it("invalidates an unsealed self-settle request before the restore barrier opens", async () => {
	// Given a persisted request whose root work remains unsealed under child custody.
	const a = await createHarness({ persistSession: true });
	harnesses.push(a);
	expect(a.session.workObligations).toBeDefined();
	a.session.workObligations.open("task:review", "children");
	const unsubscribe = a.session.subscribe((event) => {
		if (event.type === "agent_start") a.session.requestSelfSettle();
	});
	a.setResponses([fauxAssistantMessage("Waiting for the review.")]);
	await runToAgentIdle(a, () => a.session.prompt("Finish after the review"));
	unsubscribe();
	expect(a.session.lifecycle).toMatchObject({ state: "waiting_children" });
	const file = a.sessionManager.getSessionFile();
	if (!file) throw new Error("A persisted session file is required");
	a.session.dispose();

	// When the engine recovers the unsealed epoch.
	const b = await createHarness({ siblingOf: a, sessionManager: SessionManager.open(file) });
	harnesses.push(b);
	await b.session.bindExtensions({ mode: "rpc" });

	// Then a possibly unsaved intervening human input makes the old request untrustworthy.
	expect(b.session.lifecycle).toMatchObject({ selfSettleEligible: false, restoring: false });
	expect(b.session.requestSelfSettle()).toMatchObject({ recorded: false, reason: "not_eligible" });
});
