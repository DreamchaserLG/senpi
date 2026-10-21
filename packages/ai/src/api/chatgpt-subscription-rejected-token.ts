// ChatGPT invalidates a subscription access token server-side ("Your authentication token has
// expired. Please try refreshing it.", HTTP 401) while its stored expiry still says it is valid;
// the Codex CLI refreshes and retries on that 401 (#3407). 403 stays out: on this backend it
// means the account or region is refused, which a refresh cannot fix.
export const CHATGPT_SUBSCRIPTION_REJECTED_TOKEN_STATUSES: readonly number[] = [401];
