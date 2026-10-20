/**
 * Tool dispatch seam (senpi#3566): the single place a tool call is resolved to a
 * placement and executed, and where user bash (`!`, RPC `bash`) resolves its
 * BashOperations.
 *
 * The dispatcher kind follows the session's tool runtime (`--tool-runtime`, absent
 * = in-process). Nothing moves yet: `InProcessToolDispatcher` calls
 * `definition.execute` exactly as the wrappers did before, and `ChildToolDispatcher`
 * refuses child-placed work with `tool_runtime_unavailable` until the tool child
 * runtime lands (senpi#3566 todo 4). An explicit `operations` override stays with
 * its caller, so caller-injected work is never re-routed.
 */
import { dirname, isAbsolute, resolve } from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ToolRuntimeKind } from "../../cli/tool-runtime.ts";
import type { ExtensionToolContext, ToolDefinition, ToolPlacement } from "../extensions/types.ts";
import { type BashOperations, createLocalBashOperations } from "../tools/bash.ts";

export type { ToolPlacement } from "../extensions/types.ts";

export const TOOL_RUNTIME_UNAVAILABLE = "tool_runtime_unavailable";

export interface ToolUnavailableDetails {
	readonly code: typeof TOOL_RUNTIME_UNAVAILABLE;
}

export interface ToolDispatchedInfo {
	readonly toolCallId: string;
	readonly placement: ToolPlacement;
	readonly pid: number;
	readonly generation: number;
}

export type ToolDispatchObserver = (info: ToolDispatchedInfo) => void;

export type ToolDispatchNotify = (event: string, data?: Record<string, unknown>) => void;

export interface ToolDispatchCall<TDetails = unknown> {
	readonly definition: ToolDefinition<any, TDetails>;
	readonly toolCallId: string;
	readonly params: unknown;
	readonly signal?: AbortSignal;
	readonly onUpdate?: AgentToolUpdateCallback<TDetails>;
	readonly ctx: ExtensionToolContext;
	/** The extension file that registered the tool; a relative `childModule.path` resolves against its directory. */
	readonly sourcePath?: string;
}

/** The tool child's `module` job (senpi#3566; the same shape todo 8's `ctx.offload` uses). */
export interface ToolChildModuleJob {
	readonly modulePath: string;
	readonly export: string;
	readonly args: unknown;
}

export interface ToolChildRunResult {
	readonly value: unknown;
	readonly pid: number;
	readonly generation: number;
}

/** Runs a `module` job on the session's tool child, starting the child on first use. */
export type ToolChildRunner = (job: ToolChildModuleJob, signal: AbortSignal | undefined) => Promise<ToolChildRunResult>;

export interface ToolDispatcherOptions {
	runtime: ToolRuntimeKind;
	notify?: ToolDispatchNotify;
	childRunner?: ToolChildRunner;
}

export interface ToolDispatcher {
	readonly kind: ToolRuntimeKind;
	run<TDetails = unknown>(
		call: ToolDispatchCall<TDetails>,
	): Promise<AgentToolResult<TDetails | ToolUnavailableDetails>>;
	bashOperations(options?: { shellPath?: string }): BashOperations;
	onDispatched(observer: ToolDispatchObserver): () => void;
}

/**
 * Placement of one call: only a definition that opted into `"child"` while the
 * session runs the child runtime dispatches there, and never when the definition
 * is server-pinned (injected `operations` / policy override captured at creation).
 */
export function resolveToolPlacement(
	definition: Pick<ToolDefinition, "name" | "placement" | "serverPinned">,
	runtime: ToolRuntimeKind,
): ToolPlacement {
	if (runtime !== "child") return "server";
	if (definition.placement !== "child") return "server";
	if (definition.serverPinned === true) return "server";
	return "child";
}

abstract class BaseToolDispatcher implements ToolDispatcher {
	abstract readonly kind: ToolRuntimeKind;

	abstract run<TDetails>(
		call: ToolDispatchCall<TDetails>,
	): Promise<AgentToolResult<TDetails | ToolUnavailableDetails>>;

	abstract bashOperations(options?: { shellPath?: string }): BashOperations;

	private readonly observers = new Set<ToolDispatchObserver>();
	private readonly pinNotified = new Set<string>();
	private readonly notifySink: ToolDispatchNotify | undefined;

	constructor(notify?: ToolDispatchNotify) {
		this.notifySink = notify;
	}

	onDispatched(observer: ToolDispatchObserver): () => void {
		this.observers.add(observer);
		return () => {
			this.observers.delete(observer);
		};
	}

	protected placementFor(definition: Pick<ToolDefinition, "name" | "placement" | "serverPinned">): ToolPlacement {
		const placement = resolveToolPlacement(definition, this.kind);
		if (placement === "server" && this.kind === "child" && definition.placement === "child") {
			if (!this.pinNotified.has(definition.name)) {
				this.pinNotified.add(definition.name);
				this.notifySink?.("tool_placement_pinned", { tool: definition.name, reason: "server_pinned" });
			}
		}
		return placement;
	}

	protected runOnServer<TDetails>(call: ToolDispatchCall<TDetails>): Promise<AgentToolResult<TDetails>> {
		this.emitDispatched({ toolCallId: call.toolCallId, placement: "server", pid: process.pid, generation: 0 });
		return call.definition.execute(call.toolCallId, call.params, call.signal, call.onUpdate, call.ctx);
	}

	protected emitDispatched(info: ToolDispatchedInfo): void {
		for (const observer of [...this.observers]) {
			try {
				observer(info);
			} catch (error) {
				// An observer is diagnostics only: its failure must never become the tool call's failure.
				this.notifySink?.("tool_dispatch_observer_failed", {
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
}

export class InProcessToolDispatcher extends BaseToolDispatcher {
	readonly kind: ToolRuntimeKind = "in-process";

	run<TDetails>(call: ToolDispatchCall<TDetails>): Promise<AgentToolResult<TDetails>> {
		return this.runOnServer(call);
	}

	bashOperations(options?: { shellPath?: string }): BashOperations {
		return createLocalBashOperations(options);
	}
}

/**
 * Refuses child-placed work and child-backed bash until the tool child runtime
 * lands (senpi#3566 todo 4 / todo 9); server-placed work still runs in-process,
 * so a session under `--tool-runtime child` stays usable at this stage.
 */
export class ChildToolDispatcher extends BaseToolDispatcher {
	readonly kind: ToolRuntimeKind = "child";
	readonly #childRunner: ToolChildRunner | undefined;

	constructor(notify?: ToolDispatchNotify, childRunner?: ToolChildRunner) {
		super(notify);
		this.#childRunner = childRunner;
	}

	run<TDetails>(call: ToolDispatchCall<TDetails>): Promise<AgentToolResult<TDetails | ToolUnavailableDetails>> {
		if (this.placementFor(call.definition) === "server") {
			return this.runOnServer(call);
		}
		const job = childModuleJob(call);
		if (job === undefined || this.#childRunner === undefined)
			return Promise.resolve(unavailableToolResult(call.definition.name));
		return this.#runOnChild(this.#childRunner, job, call);
	}

	async #runOnChild<TDetails>(
		runner: ToolChildRunner,
		job: ToolChildModuleJob,
		call: ToolDispatchCall<TDetails>,
	): Promise<AgentToolResult<TDetails>> {
		const { value, pid, generation } = await runner(job, call.signal);
		this.emitDispatched({ toolCallId: call.toolCallId, placement: "child", pid, generation });
		if (!isToolResult<TDetails>(value))
			throw new Error(`tool_child_invalid_result: ${job.modulePath}#${job.export} must return { content: [...] }`);
		return value;
	}

	bashOperations(): BashOperations {
		return unavailableBashOperations();
	}
}

export function createToolDispatcher(options: ToolDispatcherOptions): ToolDispatcher {
	return options.runtime === "child"
		? new ChildToolDispatcher(options.notify, options.childRunner)
		: new InProcessToolDispatcher(options.notify);
}

function childModuleJob(call: {
	readonly definition: Pick<ToolDefinition, "childModule">;
	readonly params: unknown;
	readonly toolCallId: string;
	readonly sourcePath?: string;
}): ToolChildModuleJob | undefined {
	const childModule = call.definition.childModule;
	if (childModule === undefined) return undefined;
	const base = call.sourcePath === undefined ? undefined : dirname(call.sourcePath);
	if (!isAbsolute(childModule.path) && base === undefined) return undefined;
	const modulePath = isAbsolute(childModule.path) ? childModule.path : resolve(base ?? "", childModule.path);
	return { modulePath, export: childModule.export, args: { params: call.params, toolCallId: call.toolCallId } };
}

function isToolResult<TDetails>(value: unknown): value is AgentToolResult<TDetails> {
	return typeof value === "object" && value !== null && Array.isArray(Reflect.get(value, "content"));
}

export function unavailableToolResult(toolName: string): AgentToolResult<ToolUnavailableDetails> {
	return {
		content: [
			{
				type: "text",
				text: `${TOOL_RUNTIME_UNAVAILABLE}: tool "${toolName}" is placed on the session tool child, which this build does not provide yet (senpi#3566).`,
			},
		],
		details: { code: TOOL_RUNTIME_UNAVAILABLE },
		isError: true,
	};
}

export function unavailableBashOperations(): BashOperations {
	return {
		exec: async () => {
			throw new Error(
				`${TOOL_RUNTIME_UNAVAILABLE}: user bash needs the session tool child, which this build does not provide yet (senpi#3566)`,
			);
		},
	};
}
