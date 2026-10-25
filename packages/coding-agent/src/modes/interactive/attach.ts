import { randomUUID } from "node:crypto";
import { Container, setKeybindings, Text, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../core/keybindings.ts";
import type { RpcSessionState } from "../rpc/rpc-types.ts";
import { AttachClient, type AttachRecord } from "./attach-client.ts";
import { AttachDialogs } from "./attach-dialogs.ts";
import { createChatViewport } from "./chat-viewport.ts";
import { CustomEditor } from "./components/custom-editor.ts";
import { RecordRenderer } from "./record-renderer.ts";
import { getEditorTheme, theme } from "./theme/theme.ts";

export function validateAttachTerminal(inputIsTTY: boolean | undefined, outputIsTTY: boolean | undefined): void {
	if (!inputIsTTY || !outputIsTTY) throw new Error("--attach requires an interactive terminal on stdin and stdout");
}

/** The RPC presentation owns no session runtime, provider, session file, or host process. */
export class AttachedTui extends Container implements Focusable {
	readonly transcript = new RecordRenderer();
	readonly layoutRoot: Component;
	state: RpcSessionState | undefined;
	private readonly ui: TUI;
	private readonly status = new Text("Connecting", 1, 0);
	private readonly editor: CustomEditor;
	private readonly dialogs: AttachDialogs;
	private readonly client: AttachClient;
	private sessionId: string | undefined;
	private connected = false;
	private attached = false;
	private closing = false;
	private streaming = false;
	private before: string | undefined;
	private loadingHistory: Promise<void> | undefined;
	private buffering: AttachRecord[] | undefined = [];

	constructor(ui: TUI, finish: () => void) {
		super();
		this.ui = ui;
		const keys = KeybindingsManager.create();
		setKeybindings(keys);
		this.editor = new CustomEditor(ui, getEditorTheme(), keys);
		this.dialogs = new AttachDialogs(
			ui,
			keys,
			(response) => {
				if (this.sessionId) this.client.answer(this.sessionId, response);
			},
			() => ui.setFocus(this),
		);
		this.client = new AttachClient(
			(record) => {
				if (record.sessionId && record.sessionId !== this.sessionId) return;
				if (this.buffering) this.buffering.push(record);
				else this.record(record);
			},
			() => {
				this.connected = false;
				this.dialogs.dispose();
				ui.setFocus(this);
				this.showStatus("Disconnected");
			},
		);
		this.editor.onSubmit = (text) => {
			if (text.trim() === "/quit") {
				finish();
				return;
			}
			this.perform(() => this.submit(text));
		};
		this.editor.onCtrlD = finish;
		this.editor.onAction("app.clear", finish);
		this.editor.onEscape = () => this.perform(() => this.abort());
		this.addChild(this.transcript);
		this.addChild(this.status);
		this.addChild(this.dialogs);
		this.addChild(this.editor);
		const input = new Container();
		input.addChild(this.dialogs);
		input.addChild(this.editor);
		this.layoutRoot = createChatViewport({
			document: this.transcript,
			pendingMessages: new Container(),
			status: this.status,
			editor: input,
			footer: new Text("/history  /steer <text>  /abort  /quit", 1, 0),
			scrollbarTrackStyle: (text) => theme.fg("scrollbarTrack", text),
			scrollbarThumbStyle: (text) => theme.fg("scrollbarThumb", text),
		}).root;
	}

	get focused(): boolean {
		return this.editor.focused;
	}
	set focused(value: boolean) {
		this.editor.focused = value;
	}

	async connect(address: string, ref: string): Promise<void> {
		const path = address.startsWith("unix://") ? address.slice(7) : address;
		if (!path || path.includes("://") || /^\\\\\.\\pipe\\/i.test(path))
			throw new Error("--attach needs a local socket path or a named pipe's logical filesystem path");
		try {
			await this.client.connect(path);
			this.connected = true;
			await this.client.request({
				type: "set_client_info",
				width: this.ui.terminal.columns,
				capabilities: ["interactive_user", "question", "grant_select"],
			});
			const listing = await this.client.request({ type: "list_sessions", observe: true });
			if (listing.command !== "list_sessions") throw new Error("Expected a session listing");
			const exact = listing.data.sessions.filter(
				(row) => row.sessionId === ref || row.durableSessionId === ref || row.sessionPath === ref,
			);
			const matches = exact.length
				? exact
				: listing.data.sessions.filter((row) => row.durableSessionId?.startsWith(ref));
			const row = matches.length === 1 ? matches[0] : undefined;
			if (!row?.durableSessionId)
				throw new Error(
					matches.length > 1 ? "Ambiguous session reference" : "No live session matches the reference",
				);
			this.sessionId = row.sessionId;
			await this.client.request({
				type: "attach_session",
				sessionId: row.sessionId,
				durableSessionId: row.durableSessionId,
			});
			this.attached = true;
			const subscribed = await this.client.request({
				type: "subscribe_sessions",
				sessions: { ids: [row.sessionId] },
				mirror: "all",
			});
			const state = await this.client.request({ type: "get_state", sessionId: row.sessionId, observe: true });
			if (state.command !== "get_state") throw new Error("Expected session state");
			this.state = state.data;
			this.streaming = state.data.isStreaming;
			await this.loadHistory();
			for (const dialog of [...(state.data.pendingDialogs ?? []), ...(state.data.pendingQuestions ?? [])])
				this.dialogs.accept(dialog);
			this.showStatus(this.streaming ? "Running" : "Attached");
			if (subscribed.command === "subscribe_sessions") {
				for (const status of subscribed.data.snapshot) this.record(status);
			}
			const buffered = this.buffering ?? [];
			this.buffering = undefined;
			for (const record of buffered) this.record(record);
		} catch (error) {
			await this.close();
			throw error;
		}
	}

	loadHistory(): Promise<void> {
		if (this.loadingHistory) return this.loadingHistory;
		this.loadingHistory = this.readHistory().finally(() => {
			this.loadingHistory = undefined;
		});
		return this.loadingHistory;
	}

	private async readHistory(): Promise<void> {
		if (!this.sessionId || !this.connected) return;
		const response = await this.client.request({
			type: "get_entries",
			sessionId: this.sessionId,
			tail: 100,
			before: this.before,
			observe: true,
		});
		if (response.command !== "get_entries") throw new Error("Expected history entries");
		this.before = response.data.next_before;
		this.transcript.prepend(response.data.entries);
		this.ui.requestRender();
	}

	async submit(text: string): Promise<void> {
		if (!this.connected || !this.sessionId) throw new Error("Disconnected; attach again to send input");
		if (text.trim() === "/history") {
			if (this.before) await this.loadHistory();
			return;
		}
		if (text.trim() === "/abort") {
			await this.abort();
			return;
		}
		const steer = text.startsWith("/steer ") || this.streaming;
		const message = text.startsWith("/steer ") ? text.slice(7) : text;
		if (!message.trim()) return;
		await this.client.request({
			type: steer ? "steer" : "prompt",
			sessionId: this.sessionId,
			message,
			clientMessageId: randomUUID(),
		});
		this.editor.setText("");
		this.ui.requestRender();
	}

	async abort(): Promise<void> {
		if (!this.sessionId || !this.connected) return;
		await this.client.request({ type: "abort", sessionId: this.sessionId, intent: "stop", effectId: randomUUID() });
	}

	async close(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		this.dialogs.dispose();
		try {
			if (this.connected && this.attached && this.sessionId)
				await this.client.request({ type: "release_attachment", sessionId: this.sessionId });
		} finally {
			this.connected = false;
			this.client.close();
		}
	}

	handleInput(data: string): void {
		if (this.dialogs.active) this.dialogs.handleInput(data);
		else this.editor.handleInput(data);
		this.ui.requestRender();
	}

	private record(record: AttachRecord): void {
		this.transcript.accept(record);
		switch (record.type) {
			case "extension_ui_request":
				if (record.method === "notify") this.showStatus(record.message);
				else this.dialogs.accept(record);
				break;
			case "question_resolved":
				this.dialogs.resolve(record.id);
				break;
			case "session_status":
				this.streaming = record.status === "running";
				this.showStatus(record.status);
				break;
			case "agent_start":
				this.streaming = true;
				this.showStatus("Running");
				break;
			case "agent_end":
			case "agent_settled":
				this.streaming = false;
				this.showStatus("Attached");
				break;
			default:
				break;
		}
		this.ui.requestRender();
	}

	private showStatus(value: string): void {
		this.status.setText(
			theme.fg("muted", `${value}${this.state?.sessionName ? ` - ${this.state.sessionName}` : ""}`),
		);
		this.ui.requestRender();
	}

	private perform(action: () => Promise<void>): void {
		void action().catch((error: unknown) => this.showStatus(error instanceof Error ? error.message : String(error)));
	}
}
