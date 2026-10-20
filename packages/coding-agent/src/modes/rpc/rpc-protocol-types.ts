import type { RpcProtocolIdentity } from "./rpc-types.ts";

export interface RpcProtocolInfoCommand {
	id?: string;
	type: "get_protocol_info";
	/** Public POSIX endpoint challenge; ignored by pre-authentication hosts. */
	auth?: { readonly client_nonce: string };
	/** An observing read never counts as host activity (docs/rpc.md, idle exit). */
	observe?: boolean;
}

export interface RpcProtocolInfo extends RpcProtocolIdentity {
	/** Present only on the public POSIX endpoint's challenge response. */
	readonly auth?: {
		readonly launch_id: string;
		readonly server_nonce: string;
		readonly server_proof: string;
	};
	/** Supervised socket hosts expose admission state independently of child responsiveness. */
	readonly lifecycle?: "ready" | "stopping";
	readonly protocolVersion: 1;
	/** Informational engine version. Never compare it for compatibility. */
	readonly serverVersion: string;
	readonly capabilities: string[];
	readonly mode: "classic" | "multi";
	/** Observability only: the host memory sampler reads above SENPI_RPC_HOST_RSS_WARN_MB. */
	readonly memory_pressure?: boolean;
}
