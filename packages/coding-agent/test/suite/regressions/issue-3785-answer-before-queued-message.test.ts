/**
 * senpi#3785: an answer to a pending ask-user question reaches the model before a message the user
 * queued earlier; the queued message follows in its own order.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import askUserExtension from "../../../src/core/extensions/builtin/ask-user/index.ts";
import { getPendingQuestions } from "../../../src/core/extensions/builtin/ask-user/registry.ts";
import { ConnectionQuestionBridge } from "../../../src/modes/rpc/connection-question-bridge.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";

const CALL_ID = "call-q";
const QUEUED = "QUEUED-EARLIER";
const ANSWER = "ANSWER-VIA-CARD";
const QUESTION = {
	header: "Lib",
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

async function world(waitForAnswer: boolean) {
	const asked = Promise.withResolvers<string>();
	const bridge = new ConnectionQuestionBridge((record) => {
		if ("method" in record && record.method === "question") asked.resolve((record as { id: string }).id);
	});
	const release = Promise.withResolvers<void>();
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await release.promise;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	const harness = await createHarness({
		tools: [waitTool],
		extensionFactories: [askUserExtension],
		settings: { askUser: { enabled: true, timeoutMinutes: 30 } },
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({
		uiContext: createTestUiContext({ question: (request, options) => bridge.ask(request, options) }),
		mode: "rpc",
	});
	const queued = Promise.withResolvers<void>();
	const contexts: Context[] = [];
	const record = (text: string) => (context: Context) => {
		contexts.push(structuredClone(context));
		return fauxAssistantMessage(text);
	};
	harness.setResponses([
		() => {
			void harness.session.steer(QUEUED).then(() => queued.resolve());
			return fauxAssistantMessage(
				[
					fauxToolCall("ask_user_question", { questions: [QUESTION], waitForAnswer }, { id: CALL_ID }),
					...(waitForAnswer ? [] : [fauxToolCall("wait", {}, { id: "call-wait" })]),
				],
				{ stopReason: "toolUse" },
			);
		},
		record("first"),
		record("second"),
	]);
	const answer = async () => {
		const id = await asked.promise;
		await queued.promise;
		expect(harness.session.getSteeringMessages()).toEqual([QUEUED]);
		bridge.respond({ type: "extension_ui_response", id, answers: {}, comment: ANSWER });
	};
	return { harness, contexts, answer, release: () => release.resolve() };
}

function answerReachedQueue(harness: Harness): Promise<void> {
	return new Promise((resolve) => {
		const check = () => {
			if (!harness.session.getSteeringMessages().some((text) => text.includes(ANSWER))) return false;
			unsubscribe();
			resolve();
			return true;
		};
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "queue_update") check();
		});
		check();
	});
}

function positions(context: Context | undefined) {
	const texts = (context?.messages ?? []).map((message) => JSON.stringify(message.content));
	return { answer: texts.findIndex((t) => t.includes(ANSWER)), queued: texts.findIndex((t) => t.includes(QUEUED)) };
}

describe("senpi#3785 the answer reaches the model before a message queued earlier", () => {
	it("blocking question: the answer's tool result precedes the queued message", async () => {
		const { harness, contexts, answer } = await world(true);
		const run = harness.session.prompt("pick a library");
		await answer();
		await run;
		const first = contexts[0];
		const roles = first?.messages.map((message) => message.role) ?? [];
		expect(roles.slice(-4)).toEqual(["assistant", "toolResult", "user", "user"]);
		const { answer: answerAt, queued: queuedAt } = positions(first);
		expect(answerAt).toBeGreaterThan(-1);
		expect(queuedAt).toBeGreaterThan(answerAt);
	});

	it("async question answered while the agent works: the answer is delivered first", async () => {
		const { harness, contexts, answer, release } = await world(false);
		const run = harness.session.prompt("pick a library");
		await answer();
		await answerReachedQueue(harness);
		release();
		await run;
		const first = positions(contexts[0]);
		expect(first.answer).toBeGreaterThan(-1);
		expect(first.queued).toBe(-1);
		const second = positions(contexts[1]);
		expect(second.queued).toBeGreaterThan(second.answer);
	});
});
