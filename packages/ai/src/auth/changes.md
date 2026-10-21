## 2026-10-20 - A login for a saved account refreshes that account in place (senpi#3841)

### What changed

- Review fold (#3861): the in-place refresh replaces only the credential material (`key`/`access`/`refresh`/`expires`) and keeps the account's `displayName` and `env` (unless the new login carries `env`), and sets `source` to `login` because the credentials now come from a login. The receipt origin is `refreshed` for an existing account. The RPC handler passes the account name only when one is set, so an unnamed `login_start` keeps the two-argument `login(provider, callbacks)` call.
- `packages/ai/src/auth/pool/slots.ts`: `appendLoginSlot(current, flat, onAllocated?, targetName?)`. With `targetName` and no provider-owned pool, the new `writeTargetSlot` writes the login into the slot named `targetName`, REPLACING it whole, or appends it under that name when the pool has none; the flat projection follows when the replaced slot was the one it mirrored. Without `targetName` nothing changes (a new `login-N`). New `isValidSlotName`.

### Why

- `packages/ai/src/auth/pool/slots.ts`: re-authenticating a saved account ("Reconnect office") for a provider that does not ask "Name for this account" (OpenAI subscription and every other non-Anthropic, non-Cursor OAuth provider) always added a new `login-N` and left the blocked account behind (sisyphuslabs/omo-desktop-app report, senpi#3841). Account blocks are kept per credential revision, so new material makes the old block inapplicable.

### Why an extension could not handle it

- Slot writes are the credential pool's own storage path; no extension hook sees them.

### Expected merge conflict zones

- LOW: `packages/ai/src/auth/pool/slots.ts` `appendLoginSlot` head and the new `writeTargetSlot` before `managedSentinelMaterial`.

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
