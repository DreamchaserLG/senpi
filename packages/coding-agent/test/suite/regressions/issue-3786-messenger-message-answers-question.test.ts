/**
 * senpi#3786: a message a messenger gateway delivers through external admission while an ask-user
 * question is open reaches the same handling as typed input (senpi#3774). A blocking question takes it
 * as its answer; a non-blocking question leaves it to be delivered right after; it is never dropped.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import askUserExtension from "../../../src/core/extensions/builtin/ask-user/index.ts";
import { getPendingQuestions } from "../../../src/core/extensions/builtin/ask-user/registry.ts";
import { SESSION_CONTROL_DELIVERY_TYPE } from "../../../src/core/extensions/types.ts";
import { ConnectionQuestionBridge } from "../../../src/modes/rpc/connection-question-bridge.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";

const CALL_ID = "call-messenger";
const TEXT = "beta please";
const QUESTION = {
	header: "Library",
	question: "Which library?",
	options: [{ label: "alpha" }, { label: "beta" }],
	multiSelect: false,
};

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) {
		for (const entry of getPendingQuestions(harness.sessionManager.getSessionId())) entry.cancel();
		harness.cleanup();
	}
});

async function questionWorld(tools: AgentTool[] = []) {
	const frames: Array<Record<string, unknown>> = [];
	const asked = Promise.withResolvers<void>();
	const resolved = Promise.withResolvers<Record<string, unknown>>();
	const bridge = new ConnectionQuestionBridge((record) => {
		const frame = record as Record<string, unknown>;
		frames.push(frame);
		if (frame.method === "question") asked.resolve();
		if (frame.type === "question_resolved") resolved.resolve(frame);
	});
	const harness = await createHarness({
		tools,
		extensionFactories: [askUserExtension],
		settings: { askUser: { enabled: true, timeoutMinutes: 30 } },
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({
		uiContext: createTestUiContext({ question: (request, options) => bridge.ask(request, options) }),
		mode: "rpc",
	});
	const askCall = (waitForAnswer: boolean, extra: ReturnType<typeof fauxToolCall>[] = []) =>
		fauxAssistantMessage(
			[fauxToolCall("ask_user_question", { questions: [QUESTION], waitForAnswer }, { id: CALL_ID }), ...extra],
			{ stopReason: "toolUse" },
		);
	return { harness, frames, asked: asked.promise, resolved: resolved.promise, askCall };
}

function deliver(harness: Harness, deliveryId: string, deliverAs: "steer" | "followUp") {
	const admission = harness.session.externalAdmission;
	return admission.admit({
		delivery_id: deliveryId,
		text: TEXT,
		deliverAs,
		expected_turn_id: admission.turnEpoch,
		sender: { kind: "external", platform: "slack", author: "tester" },
	});
}

function deliveryMessages(harness: Harness) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === SESSION_CONTROL_DELIVERY_TYPE,
	);
}

describe("senpi#3786 a messenger message while an ask-user question is open", () => {
	it.each(["steer", "followUp"] as const)("answers a blocking question (%s lane)", async (lane) => {
		const { harness, asked, resolved, askCall } = await questionWorld();
		harness.setResponses([askCall(true), fauxAssistantMessage("going with beta")]);
		const run = harness.session.prompt("pick a library");
		await asked;

		expect(deliver(harness, `d-${lane}`, lane).kind).toBe(lane === "steer" ? "steered" : "queued");
		expect(await resolved).toMatchObject({
			outcome: "comment-submitted",
			resolvedBy: "typed_message",
			comment: TEXT,
		});
		await run;

		const result = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "ask_user_question",
		);
		expect(result?.role === "toolResult" ? result.details : undefined).toMatchObject({
			status: "comment-submitted",
			resolvedBy: "typed_message",
			freeText: TEXT,
		});
		expect(deliveryMessages(harness)).toEqual([]);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.session.externalAdmission.list()).toEqual({ pending: [], emitted: [`d-${lane}`] });
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant" });
	});

	it("leaves a non-blocking question open and delivers the message right after", async () => {
		const release = Promise.withResolvers<void>();
		const waitStarted = Promise.withResolvers<void>();
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				waitStarted.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const { harness, frames, asked, askCall } = await questionWorld([waitTool]);
		const contexts: Context[] = [];
		harness.setResponses([
			askCall(false, [fauxToolCall("wait", {}, { id: "call-wait" })]),
			(context: Context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage("noted");
			},
		]);
		const emitted = Promise.withResolvers<void>();
		harness.session.externalAdmission.onEmitted(() => emitted.resolve());
		const run = harness.session.prompt("pick a library");
		await asked;
		await waitStarted.promise;

		expect(deliver(harness, "d-async", "steer").kind).toBe("steered");
		release.resolve();
		await run;
		await emitted.promise;

		expect(getPendingQuestions(harness.sessionManager.getSessionId()).map((e) => e.request.requestId)).toEqual([
			CALL_ID,
		]);
		expect(frames.filter((frame) => frame.type === "question_resolved")).toEqual([]);
		const roles = contexts[0]?.messages.map((message) => message.role) ?? [];
		expect(roles.slice(-4)).toEqual(["assistant", "toolResult", "toolResult", "user"]);
		expect(JSON.stringify(contexts[0]?.messages.at(-1))).toContain(TEXT);
		expect(deliveryMessages(harness)).toHaveLength(1);
		expect(harness.session.externalAdmission.list()).toEqual({ pending: [], emitted: ["d-async"] });
	});
});
