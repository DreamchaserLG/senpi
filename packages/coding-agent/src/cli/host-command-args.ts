import { resolve } from "node:path";
import { APP_NAME } from "../config.ts";
import type { ShardKind } from "../modes/rpc/host-daemon-paths.ts";
import type { HostDecisionPolicy } from "../modes/rpc/host-decision.ts";
import type { IdleHandoverTerms } from "../modes/rpc/host-handover-request.ts";

const SUBCOMMANDS = ["ensure", "status", "stop", "handoff", "shard-path", "gc"] as const;
type HostSubcommand = (typeof SUBCOMMANDS)[number];

const POLICIES = ["upgrade", "fallback", "never"] as const;

export interface ParsedHostArgs {
	readonly subcommand: HostSubcommand;
	readonly specPath?: string;
	readonly policy: HostDecisionPolicy;
	readonly socket?: string;
	readonly includeWorkers: boolean;
	readonly all: boolean;
	readonly drain: boolean;
	readonly force: boolean;
	/** `stop --drain`: the generation to drain, by instance id. */
	readonly instanceId?: string;
	/** `stop --drain`: how long to wait for the drained generation to exit. */
	readonly waitMs?: number;
	readonly json: boolean;
	readonly kind?: ShardKind;
	readonly owner?: string;
	readonly root?: string;
	readonly agentDir?: string;
	readonly keyRoot?: string;
	readonly handover?: IdleHandoverTerms;
}

/** Parses the command line, or answers with the message that says why it could not. */
export function parseHostArgs(args: readonly string[]): ParsedHostArgs | string {
	const [subcommand, ...rest] = args;
	if (subcommand === undefined || !isSubcommand(subcommand)) {
		return `Error: unknown host command "${subcommand ?? ""}".`;
	}
	let specPath: string | undefined;
	let policy: HostDecisionPolicy = "upgrade";
	let socket: string | undefined;
	let includeWorkers = false;
	let all = false;
	let drain = false;
	let force = false;
	let instanceId: string | undefined;
	let waitMs: string | undefined;
	let json = false;
	let kind: ShardKind | undefined;
	let owner: string | undefined;
	let root: string | undefined;
	let agentDir: string | undefined;
	let keyRoot: string | undefined;
	const handover: Record<string, string> = {};
	for (let index = 0; index < rest.length; index++) {
		const flag = rest[index];
		const value = rest[index + 1];
		if (flag === "--rpc-key-root" && value !== undefined && !value.startsWith("--")) {
			keyRoot = resolve(value);
			index++;
		} else if (flag === "--json") {
			json = true;
		} else if (flag === "--include-workers") {
			includeWorkers = true;
		} else if (flag === "--all" && subcommand === "status") {
			all = true;
		} else if (flag === "--kind" && subcommand === "shard-path" && (value === "p" || value === "i")) {
			kind = value;
			index++;
		} else if (flag === "--owner" && subcommand === "shard-path" && value !== undefined) {
			owner = value;
			index++;
		} else if (flag === "--root" && subcommand === "shard-path" && value !== undefined) {
			root = value;
			index++;
		} else if (flag === "--agent-dir" && subcommand === "gc" && value !== undefined) {
			agentDir = value;
			index++;
		} else if (subcommand === "handoff" && value !== undefined && HANDOVER_FLAGS.has(flag ?? "")) {
			handover[flag ?? ""] = value;
			index++;
		} else if (flag === "--instance" && subcommand === "stop" && value !== undefined) {
			instanceId = value;
			index++;
		} else if (flag === "--wait-ms" && subcommand === "stop" && value !== undefined) {
			waitMs = value;
			index++;
		} else if (flag === "--drain") {
			drain = true;
		} else if (flag === "--force") {
			force = true;
		} else if (flag === "--launch-spec" && value !== undefined) {
			specPath = value;
			index++;
		} else if (flag === "--socket" && value !== undefined) {
			socket = value;
			index++;
		} else if (flag === "--policy" && value !== undefined && isPolicy(value)) {
			policy = value;
			index++;
		} else {
			return `Error: unknown option "${flag}" for "${APP_NAME} host ${subcommand}".`;
		}
	}
	if (subcommand === "shard-path" && (kind === undefined || owner === undefined)) {
		return `Error: "${APP_NAME} host shard-path" needs --kind <p|i> and --owner <id>.`;
	}
	if ((instanceId !== undefined || waitMs !== undefined) && !drain) {
		return `Error: "${APP_NAME} host stop" takes --instance and --wait-ms only with --drain.`;
	}
	const parsedWaitMs = waitMs === undefined ? undefined : Number(waitMs);
	if (parsedWaitMs !== undefined && (!Number.isSafeInteger(parsedWaitMs) || parsedWaitMs <= 0)) {
		return `Error: "${APP_NAME} host stop --wait-ms" needs a positive whole number of milliseconds.`;
	}
	const terms = Object.keys(handover).length === 0 ? undefined : handoverTerms(handover);
	if (typeof terms === "string") return terms;
	return {
		subcommand,
		...(specPath !== undefined && { specPath }),
		policy,
		...(socket !== undefined && { socket }),
		includeWorkers,
		all,
		drain,
		force,
		...(instanceId !== undefined && { instanceId }),
		...(parsedWaitMs !== undefined && { waitMs: parsedWaitMs }),
		json,
		...(kind !== undefined && { kind }),
		...(owner !== undefined && { owner }),
		...(root !== undefined && { root }),
		...(agentDir !== undefined && { agentDir }),
		...(keyRoot !== undefined && { keyRoot }),
		...(terms !== undefined && { handover: terms }),
	};
}

const HANDOVER_FLAGS = new Set(["--when", "--operation", "--if-instance", "--if-generation", "--target-build"]);

/** The conditional handover's terms: all five flags together, or a usage error naming what is wrong. */
function handoverTerms(flags: Readonly<Record<string, string>>): IdleHandoverTerms | string {
	const when = flags["--when"];
	const operationId = flags["--operation"];
	const ifInstanceId = flags["--if-instance"];
	const generation = flags["--if-generation"];
	const targetRuntimeBuildId = flags["--target-build"];
	if (when !== "idle") return `Error: "${APP_NAME} host handoff" supports only --when idle.`;
	if (!operationId || !ifInstanceId || !generation || !targetRuntimeBuildId) {
		return `Error: "${APP_NAME} host handoff --when idle" needs --operation, --if-instance, --if-generation and --target-build.`;
	}
	const ifGeneration = Number(generation);
	if (!/^\d+$/.test(generation) || !Number.isSafeInteger(ifGeneration)) {
		return `Error: --if-generation must be a non-negative integer.`;
	}
	return { operationId, ifInstanceId, ifGeneration, targetRuntimeBuildId };
}

function isSubcommand(value: string): value is HostSubcommand {
	return SUBCOMMANDS.some((subcommand) => subcommand === value);
}

function isPolicy(value: string): value is HostDecisionPolicy {
	return POLICIES.some((policy) => policy === value);
}
