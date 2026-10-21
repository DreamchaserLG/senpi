import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { HumanInputAdmittedEvent } from "../../../src/core/agent-session.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

type Fixture = Awaited<ReturnType<typeof createIdentityHarness>>;
const fixtures: Fixture[] = [];

afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function seamFixture() {
	let api: ExtensionAPI | undefined;
	const fixture = await createIdentityHarness({
		extensionFactories: [
			(pi: ExtensionAPI) => {
				api = pi;
			},
		],
	});
	fixtures.push(fixture);
	await fixture.session.bindExtensions({ mode: "rpc" });
	fixture.harness.setResponses([
		fauxAssistantMessage("one"),
		fauxAssistantMessage("two"),
		fauxAssistantMessage("three"),
	]);
	const seen: Array<HumanInputAdmittedEvent & { userMessagesAtCall: number }> = [];
	fixture.session.onHumanInputAdmitted((event) => {
		const userMessagesAtCall = fixture.session.messages.filter((message) => message.role === "user").length;
		seen.push({ ...event, userMessagesAtCall });
	});
	if (api === undefined) throw new Error("extension binding unavailable");
	return { fixture, api, seen };
}

describe("senpi#3811 human-input seam", () => {
	it("reports interactive RPC input synchronously, before it is admitted", async () => {
		const { fixture, seen } = await seamFixture();
		const human = fixture.bind();
		await human.send({ type: "set_client_info", capabilities: ["interactive_user"] });

		await human.send({ type: "prompt", message: "hello" });
		await fixture.session.waitForIdle();

		expect(seen.map((event) => event.kind)).toEqual(["prompt"]);
		expect(seen[0]?.userMessagesAtCall).toBe(0);
	});

	it("does not report input from a connection without the role, nor extension or automatic deliveries", async () => {
		const { fixture, api, seen } = await seamFixture();
		const bot = fixture.bind();

		await bot.send({ type: "prompt", message: "scripted" });
		await fixture.session.waitForIdle();
		api.sendUserMessage("from an extension");
		await fixture.session.waitForIdle();
		await fixture.session.sendCustomMessage(
			{ customType: "senpi-monitor:event", content: "wake", display: false },
			{ triggerTurn: true },
		);
		await fixture.session.waitForIdle();

		expect(seen).toEqual([]);
	});

	it("reports TUI input and resume", async () => {
		const { fixture, seen } = await seamFixture();

		await fixture.session.prompt("typed in the TUI");
		await fixture.session.resumeSession();

		expect(seen.map((event) => event.kind)).toEqual(["prompt", "resume"]);
	});

	it("fixes the interactive_user role at its first declaration", async () => {
		const { fixture } = await seamFixture();
		const conn = fixture.bind();
		await conn.send({ type: "set_client_info", capabilities: [] });

		const flip = (await conn.send({ type: "set_client_info", capabilities: ["interactive_user"] })) as {
			success: boolean;
			error?: string;
		};

		expect(flip.success).toBe(false);
		expect(flip.error).toContain("connection_role_fixed");
	});
});
