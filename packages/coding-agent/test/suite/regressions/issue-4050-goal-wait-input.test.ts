import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import { createGoal, readGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import type { TerminalInputHandler } from "../../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { createHarness, createTestUiContext, getUserTexts, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
const originalKeybindings = getKeybindings();
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
	setKeybindings(originalKeybindings);
});

async function parkedSession() {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
	setKeybindings(new KeybindingsManager());
	const terminalHandlers = new Set<TerminalInputHandler>();
	const timerStates: unknown[] = [];
	const goalUi = { changed: () => {} };
	const harness = await createHarness({
		persistSession: true,
		extensionFactories: [
			goalExtension,
			(pi) => {
				pi.on("session_start", () => {
					pi.events.emit("terminal_monitor_state", { activeCount: 1 });
				});
				pi.events.on("goal_continuation_timer_state", (state) => timerStates.push(state));
			},
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({
		mode: "tui",
		uiContext: createTestUiContext({
			setStatus: (key) => {
				if (key === "goal") goalUi.changed();
			},
			onTerminalInput: (handler) => {
				terminalHandlers.add(handler);
				return () => terminalHandlers.delete(handler);
			},
		}),
	});
	const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
	await createGoal(ref, "Wait for the monitored work");
	harness.setResponses([fauxAssistantMessage("Waiting for the event.")]);
	await harness.session.prompt("Monitor the work", { source: "extension" });
	expect(timerStates.at(-1)).toMatchObject({ armed: true, kind: "monitor" });
	expect(harness.session.isIdle).toBe(true);
	return { harness, ref, timerStates, terminalHandlers, goalUi };
}

// senpi#4050: exercise the real session input and terminal-input boundaries, not handcrafted dispositions.
describe("input during a parked goal wait", () => {
	it.each(["tui", "rpc", "print"] as const)("starts a %s host without terminal-input capability", async (mode) => {
		const ui = createTestUiContext();
		Reflect.deleteProperty(ui, "onTerminalInput");
		const harness = await createHarness({ persistSession: true, extensionFactories: [goalExtension] });
		harnesses.push(harness);
		const errors: unknown[] = [];

		await harness.session.bindExtensions({ mode, uiContext: ui, onError: (error) => errors.push(error) });

		expect(errors).toEqual([]);
		expect(harness.session.isIdle).toBe(true);
	});

	it("delivers new user input with steer semantics immediately and cancels the old wait", async () => {
		const { harness, timerStates } = await parkedSession();
		harness.setResponses([fauxAssistantMessage("Handled the user's request.")]);

		await harness.session.prompt("Change direction now", { streamingBehavior: "steer" });

		expect(getUserTexts(harness).filter((text) => text === "Change direction now")).toHaveLength(1);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(timerStates).toContainEqual({ armed: false, kind: "monitor" });
		expect(harness.session.isIdle).toBe(true);
		expect(harness.faux.getCallLog()).toHaveLength(2);
	});

	it("cancels the parked wait on keyboard Escape without starting a model turn", async () => {
		const { harness, timerStates, terminalHandlers, ref, goalUi } = await parkedSession();
		const updated = Promise.withResolvers<void>();
		goalUi.changed = updated.resolve;

		for (const handler of terminalHandlers) await handler("\u001b");

		expect(timerStates.at(-1)).toMatchObject({ armed: false, kind: "monitor" });
		await updated.promise;
		expect(await readGoal(ref)).toMatchObject({ status: "blocked" });
		await vi.advanceTimersByTimeAsync(271_000);
		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.faux.getCallLog()).toHaveLength(1);
	});
});
