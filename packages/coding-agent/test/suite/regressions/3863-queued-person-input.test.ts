import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

async function heldTurn(): Promise<{ harness: Harness; release: () => void; done: Promise<void> }> {
	const gate = Promise.withResolvers<void>();
	const wait: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await gate.promise;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	const harness = await createHarness({ tools: [wait] });
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("after queue"),
		fauxAssistantMessage("after follow-up"),
		fauxAssistantMessage("after another"),
	]);
	const started = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "tool_execution_start") return;
			unsubscribe();
			resolve();
		});
	});
	const done = harness.session.prompt("start");
	await started;
	return { harness, release: gate.resolve, done };
}

describe("queued person input is decided from the entries queued now (senpi#3863)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each([
		["a desktop or RPC client follow-up", { source: "rpc" as const }],
		["a TUI follow-up", { source: "interactive" as const }],
	])("counts %s", async (_label, options) => {
		const { harness, release, done } = await heldTurn();
		harnesses.push(harness);

		await harness.session.followUp("from a person", undefined, options);

		expect(harness.session.hasQueuedPersonInput).toBe(true);
		release();
		await done;
	});

	it("person enqueues, removes it unsent, then an extension enqueues: no person input is queued", async () => {
		const { harness, release, done } = await heldTurn();
		harnesses.push(harness);
		await harness.session.followUp("changed my mind", undefined, { source: "rpc" });
		const [mine] = harness.session.getQueuedInputs();

		expect(harness.session.dequeueQueuedInput(mine!.queuedId)).toBe("removed");
		await harness.session.sendUserMessage("loop tick", { deliverAs: "followUp" });

		expect(harness.session.pendingMessageCount).toBeGreaterThan(0);
		expect(harness.session.hasQueuedPersonInput).toBe(false);
		release();
		await done;
	});

	it("person enqueues, clears the queue (Esc), then an extension enqueues: no person input is queued", async () => {
		const { harness, release, done } = await heldTurn();
		harnesses.push(harness);
		await harness.session.steer("never mind", undefined, { source: "interactive" });

		harness.session.clearQueue();
		await harness.session.sendUserMessage("stop hook", { deliverAs: "followUp" });

		expect(harness.session.hasQueuedPersonInput).toBe(false);
		release();
		await done;
	});

	it("an extension's queued message alone is not a person's input", async () => {
		const { harness, release, done } = await heldTurn();
		harnesses.push(harness);

		await harness.session.sendUserMessage("timed-out question", { deliverAs: "followUp" });

		expect(harness.session.pendingMessageCount).toBeGreaterThan(0);
		expect(harness.session.hasQueuedPersonInput).toBe(false);
		release();
		await done;
	});

	it("an answered question delivered through the extension API is a person's input, whatever the event order", async () => {
		const { harness, release, done } = await heldTurn();
		harnesses.push(harness);

		await harness.session.sendUserMessage("my answer", { deliverAs: "followUp", humanOrigin: true });

		expect(harness.session.hasQueuedPersonInput).toBe(true);
		release();
		await done;
	});

	it("stops counting once the person's input is delivered", async () => {
		const { harness, release, done } = await heldTurn();
		harnesses.push(harness);
		await harness.session.followUp("then this", undefined, { source: "rpc" });

		release();
		await done;
		await harness.session.waitForIdle();

		expect(harness.session.hasQueuedPersonInput).toBe(false);
	});
});
