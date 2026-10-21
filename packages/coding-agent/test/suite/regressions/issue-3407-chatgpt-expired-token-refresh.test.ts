import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessageEvent, AssistantMessageEventStream, Credential } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";

// Issue #3407: ChatGPT refuses a stored access token with HTTP 401 "Your authentication
// token has expired. Please try refreshing it." while the stored `expires` still says it is
// valid, so senpi's expiry-driven refresh never runs and every turn fails as "the provider
// rejected the credentials" until the user signs in again (a desktop user hit it on a fresh
// thread with a full weekly quota). The stored refresh token still works: senpi must
// refresh once and retry, and say "sign in again" only when that refresh itself fails.

const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const HOURS = 60 * 60 * 1000;
const EXPIRED_BODY = JSON.stringify({
	error: {
		message: "Your authentication token has expired. Please try refreshing it.",
		type: "invalid_request_error",
		code: "token_expired",
		param: null,
	},
});

function token(tag: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" }, tag }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

const SERVER_EXPIRED = token("server-expired");
const FRESH = token("fresh");

type Call = { url: string; auth: string | null; body?: string };
let dir: string;
let calls: Call[];

function completedSSE(): Response {
	const events = [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "OK" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "OK" }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_3407",
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function fakeChatGpt(refresh: () => Response) {
	return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = input instanceof Request ? input.url : String(input);
		const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
		const auth = headers.get("authorization");
		calls.push({
			url,
			auth,
			...(typeof init?.body === "string" || init?.body instanceof URLSearchParams
				? { body: String(init.body) }
				: {}),
		});
		if (url === TOKEN_URL) return Promise.resolve(refresh());
		if (url === ENDPOINT) {
			if (auth === `Bearer ${FRESH}`) return Promise.resolve(completedSSE());
			return Promise.resolve(
				new Response(EXPIRED_BODY, { status: 401, headers: { "content-type": "application/json" } }),
			);
		}
		return Promise.resolve(new Response("unexpected", { status: 599 }));
	};
}

const refreshes = () => Response.json({ access_token: FRESH, refresh_token: "rt_rotated", expires_in: 864000 });
const refreshRefused = () =>
	Response.json({ error: "invalid_grant", error_description: "refresh token has been revoked" }, { status: 400 });

async function runtimeWith(credential: Credential): Promise<{ runtime: ModelRuntime; credentials: AuthStorage }> {
	const credentials = AuthStorage.inMemory();
	await credentials.modify("chatgpt-subscription", async () => credential);
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		agentDir: dir,
		allowModelNetwork: false,
	});
	return { runtime, credentials };
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
		if (event.type === "done" || event.type === "error") break;
	}
	return events;
}

const context = { messages: [{ role: "user" as const, content: "Reply with OK.", timestamp: 0 }], tools: [] };
const options = { transport: "sse" as const, maxRetries: 0 };
const stored = (): Credential => ({
	type: "oauth",
	access: SERVER_EXPIRED,
	refresh: "rt_still_valid",
	expires: Date.now() + 5 * 24 * HOURS,
});

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "issue-3407-"));
	calls = [];
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});

describe("issue #3407: a ChatGPT token the server says has expired is refreshed once", () => {
	it("refreshes on the 401 'token has expired', retries once with the new token, and stores it", async () => {
		vi.stubGlobal("fetch", vi.fn(fakeChatGpt(refreshes)));
		const { runtime, credentials } = await runtimeWith(stored());

		const events = await collect(runtime.stream(getModel("chatgpt-subscription", "gpt-5.5"), context, options));

		expect(events.at(-1)?.type).toBe("done");
		const inference = calls.filter((call) => call.url === ENDPOINT);
		expect(inference.map((call) => call.auth)).toEqual([`Bearer ${SERVER_EXPIRED}`, `Bearer ${FRESH}`]);
		const refreshCalls = calls.filter((call) => call.url === TOKEN_URL);
		expect(refreshCalls).toHaveLength(1);
		expect(refreshCalls[0]?.body).toContain("refresh_token=rt_still_valid");
		const saved = await credentials.read("chatgpt-subscription");
		expect(saved?.type === "oauth" ? [saved.access, saved.refresh] : undefined).toEqual([FRESH, "rt_rotated"]);
	});

	it("when the refresh itself is refused, the turn says to sign in to ChatGPT again", async () => {
		vi.stubGlobal("fetch", vi.fn(fakeChatGpt(refreshRefused)));
		const { runtime } = await runtimeWith(stored());

		const events = await collect(runtime.stream(getModel("chatgpt-subscription", "gpt-5.5"), context, options));

		const terminal = events.at(-1);
		expect(terminal?.type).toBe("error");
		const message = terminal?.type === "error" ? (terminal.error.errorMessage ?? "") : "";
		expect(message).toContain("sign in to ChatGPT Subscription (Plus/Pro) again");
		expect(message).not.toContain("Your authentication token has expired");
		expect(calls.filter((call) => call.url === TOKEN_URL)).toHaveLength(1);
	});
});
