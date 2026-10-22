/**
 * omo-desktop-app#4042 (b): a session binding's client capabilities follow the connection that answers it.
 * A session first opened by a socket that never sent set_client_info used to keep that opener's empty
 * capabilities for its whole life, so every question degraded to single dialogs. A connection attached to
 * the session that declares `question` now gets the structured question frame; an observer's declaration,
 * and a declaration the connection-role check refuses (senpi#3811), leave the binding as it was.
 */
import { describe, expect, it, vi } from "vitest";
import { INTERACTIVE_USER_CAPABILITY } from "../../../src/modes/rpc/custom-capability.ts";
import { startWorkerHost } from "../rpc-worker-host-support.ts";

const ASK_QUESTION_COMMAND = `export default function (pi) {
	pi.registerCommand("ask-question", { description: "question fixture", handler: async (_args, ctx) => {
		await ctx.ui.question({ requestId: "follow-connection-question", waitForAnswer: true, timeoutMs: 60000,
			questions: [{ id: "q1", header: "q1", question: "q1", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] });
	} });
}`;

const DIALOG_METHODS = new Set(["question", "select", "input", "confirm"]);

type Host = Awaited<ReturnType<typeof startWorkerHost>>;
type Client = Awaited<ReturnType<Host["connect"]>>;

async function firstDialog(client: Client, sessionId: unknown) {
	const dialog = client.wait(
		(record) =>
			record.type === "extension_ui_request" &&
			record.sessionId === sessionId &&
			DIALOG_METHODS.has(String(record.method)),
	);
	const prompt = client.request({ type: "prompt", sessionId, message: "/ask-question" });
	// The host is disposed with a degraded dialog still open; that prompt never settles on purpose.
	prompt.catch(() => undefined);
	return { dialog: await dialog, prompt };
}

async function withHost(sessionRuntime: "in-process" | "worker", run: (host: Host) => Promise<void>): Promise<void> {
	vi.stubEnv("SENPI_RPC_TEST_BUN", process.execPath);
	const host = await startWorkerHost(ASK_QUESTION_COMMAND, { socket: true, sessionRuntime });
	try {
		await run(host);
	} finally {
		await host.dispose();
	}
}

describe.each(["in-process", "worker"] as const)("%s runtime", (sessionRuntime) => {
	it("an opener that declares question after opening gets the structured question frame", async () => {
		await withHost(sessionRuntime, async (host) => {
			// Given: a session opened by a connection that sent no set_client_info, so it opened degraded.
			const owner = await host.connect();
			const opened = await owner.request({ type: "open_session", cwd: host.cwd });
			const sessionId = opened.data?.sessionId;

			// When: that connection declares `question` at the host and the session asks a question.
			const info = await owner.request({ type: "set_client_info", width: 80, capabilities: ["question"] });
			const { dialog, prompt } = await firstDialog(owner, sessionId);

			// Then: the question goes out as one structured frame, the rebind sent the client no reply of its own,
			// and the answer settles the prompt.
			expect([opened.success, info.success]).toEqual([true, true]);
			expect(dialog.method).toBe("question");
			expect(
				owner.records.filter((record) => record.type === "response" && record.command === "set_client_info"),
			).toEqual([expect.objectContaining({ id: expect.any(String), success: true })]);
			owner.send({ type: "extension_ui_response", sessionId, id: dialog.id, answers: { q1: { selected: ["A"] } } });
			expect((await prompt).success).toBe(true);
		});
	}, 120_000);
});

it("a declared connection that attaches through open_session answers the session it attached to", async () => {
	await withHost("in-process", async (host) => {
		// Given: a session opened (and so bound) by a connection that declared nothing.
		const opener = await host.connect();
		const opened = await opener.request({ type: "open_session", cwd: host.cwd });
		const sessionId = opened.data?.sessionId;
		const sessionPath = opened.data?.state?.sessionFile;

		// When: a connection that declared `question` before attaching opens the same session path.
		const answerer = await host.connect();
		await answerer.request({ type: "set_client_info", width: 80, capabilities: ["question"] });
		const attached = await answerer.request({ type: "open_session", cwd: host.cwd, sessionPath });
		const { dialog } = await firstDialog(answerer, sessionId);

		// Then: the attach rebinds the session to the answerer's capabilities.
		expect(attached).toMatchObject({ success: true, data: { sessionId, attached: true } });
		expect(dialog.method).toBe("question");
	});
}, 120_000);

it("an observer's set_client_info leaves a session it is not attached to degraded", async () => {
	await withHost("in-process", async (host) => {
		// Given: a degraded session and a second connection that never attached to it.
		const owner = await host.connect();
		const opened = await owner.request({ type: "open_session", cwd: host.cwd });
		const sessionId = opened.data?.sessionId;
		const observer = await host.connect();

		// When: only the observer declares `question`.
		const info = await observer.request({ type: "set_client_info", width: 80, capabilities: ["question"] });
		const { dialog } = await firstDialog(owner, sessionId);

		// Then: the owner's session still asks through the degraded single dialog.
		expect(info.success).toBe(true);
		expect(dialog.method).toBe("select");
	});
}, 120_000);

it("a declaration the connection-role check refuses does not rebind the session", async () => {
	await withHost("in-process", async (host) => {
		// Given: a connection that declared interactive_user without `question`, then opened a session.
		const owner = await host.connect();
		await owner.request({ type: "set_client_info", width: 80, capabilities: [INTERACTIVE_USER_CAPABILITY] });
		const opened = await owner.request({ type: "open_session", cwd: host.cwd });
		const sessionId = opened.data?.sessionId;

		// When: it tries to swap that role for `question`.
		const refused = await owner.request({ type: "set_client_info", width: 80, capabilities: ["question"] });
		const { dialog } = await firstDialog(owner, sessionId);

		// Then: the role check refuses first and the session's binding is unchanged.
		expect(refused).toMatchObject({ success: false, error: expect.stringContaining("connection_role_fixed") });
		expect(dialog.method).toBe("select");
	});
}, 120_000);
