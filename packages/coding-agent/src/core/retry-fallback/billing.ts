/**
 * Billing-class provider failures (credit exhaustion, hard account quota).
 * These never recover by retrying the same account, so the fallback switch for
 * one is always pinned: the candidate becomes the session model for the rest of
 * the session instead of reverting after the billing cooldown.
 *
 * A usage limit (`usage_limit_reached`, "usage limit has been reached") is NOT
 * billing: it is a window that resets, so pinning on it kept a session off its
 * subscription long after the reset (senpi#3038). It still switches at once as an
 * account limit and parks the original until its reset. `usage_not_included`
 * stays here: the plan does not include the model, and no reset changes that.
 */
const BILLING_ERROR_PATTERN = new RegExp(
	[
		"credit[- ]balance",
		"insufficient[_ -]quota",
		"\\bbilling\\b",
		"purchase credits",
		"credits[-_ ]required",
		"credits are required",
		// OpenAI plan entitlement (senpi#1969): the model is not in the plan at all.
		"usage_not_included",
	].join("|"),
	"i",
);

export function isBillingErrorMessage(errorMessage: string | undefined): boolean {
	return errorMessage !== undefined && BILLING_ERROR_PATTERN.test(errorMessage);
}
