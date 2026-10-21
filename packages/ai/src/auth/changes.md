## 2026-10-21 - A permanent OAuth refresh failure says to sign in again (senpi#3407)

### What changed

- `packages/ai/src/auth/resolve.ts`: `oauthRefreshModelsError` takes the provider's display name. A permanent (non-transient) refresh failure keeps its `OAuth refresh failed for <id>: <cause>` first line and adds a second one: "The saved sign-in can no longer be renewed: sign in to <name> again." Transient failures are unchanged.

### Why

When ChatGPT refused a refresh token, the turn ended with the raw token-endpoint text and the desktop showed "the provider rejected the credentials". Nothing said that only a new sign-in could fix it.

### Why an extension could not handle it

The refresh error is built during credential resolution, before any provider request or extension hook runs.

### Expected merge conflict zones

- The permanent branch of `oauthRefreshModelsError` in `packages/ai/src/auth/resolve.ts` and its two call sites (here and in `refresh-credential.ts`), against upstream changes to OAuth refresh error mapping.

## 2026-10-09 - Restore auth-tracker coverage for upstream-modified paths (senpi#3006)

### What changed

- `packages/ai/src/auth/credential-store.ts`: documentation only; the store comment says an entry may be pooled.
- `packages/ai/src/auth/helpers.ts`: shared auth helpers carried through the v0.99.1 sync and Copilot token re-exchange (senpi#2297).
- `packages/ai/src/auth/types.ts`: auth resolution types — ambient shared-cloud credential chains (senpi#2327), immutable account ids (senpi#1495), and the `ApiKeyAuth.ambientOnly` compatibility marker.

These files were covered by the parent tracker until senpi#2895 added this nearer tracker without listing them, hiding them from the audit's exact-nearest-tracker rule.

### Why

The repository audit requires every upstream-modified production path to be named by an entry in its exact nearest changes.md tracker. senpi#2895 introduced this tracker and named only the two files it touched, so the 3 pre-existing upstream-modified files beneath it lost the coverage the parent tracker had provided and were reported uncovered.

### Why an extension could not handle it

changes.md coverage is fork-owned documentation metadata; no extension or runtime hook can supply it.

### Expected merge conflict zones

- The `ApiKeyAuth` / auth-resolution type fields (ambient markers, account-id metadata) in `packages/ai/src/auth/types.ts`, against upstream auth-contract changes.
- The `rejectedTokenStatuses` passthrough in `packages/ai/src/auth/helpers.ts`, against upstream changes to the OAuth refresh input shape.
- The doc comment in `packages/ai/src/auth/credential-store.ts` (an entry may be pooled), against upstream edits to the same comment; the code is unchanged.

## 2026-10-07 - Preserve transient OAuth exchange failures (senpi#2893)

### What changed

- `packages/ai/src/auth/oauth-refresh.ts`: preserve caller cancellation; log one JSON-encoded provider/optional-slot/closed-cause line per transient exchange without changing stored credentials. JSON encoding prevents object inspection or embedded newlines from splitting the log record.
- `packages/ai/src/auth/resolve.ts`: map transient exchanges to a symbol-branded OAuth ModelsError while preserving permanent errors and message text.

### Why

Transport failures during refresh lost their retryability and ended unattended turns.

### Why an extension could not handle it

Exchange classification and credential resolution happen before provider requests or extension recovery hooks.

### Expected merge conflict zones

- The exchange catch in `oauth-refresh.ts` and error mapping in `resolve.ts`.
